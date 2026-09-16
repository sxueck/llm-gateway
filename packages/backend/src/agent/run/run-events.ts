import { EventEmitter } from "events";
import { agentSearchRunEventDb } from "../../db/index.js";
import {
  TERMINAL_RUN_EVENT_TYPES,
  type SearchRunEvent,
  type SearchRunEventType,
} from "@llm-gateway/shared";

export interface RunStreamHandle {
  unsubscribe(): void;
  /** 历史重放与缓冲冲刷完成后 resolve，值为该窗口内是否交付过终态事件；后续终态经 deliver 回调交付。 */
  done: Promise<boolean>;
}

/**
 * per-run 事件总线：事件先落库（SSE 断线重连重放），再向订阅者广播。
 */
export class RunEventHub {
  private emitter = new EventEmitter();
  private nextSeq = new Map<string, number>();
  private seqChains = new Map<string, Promise<void>>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  subscribe(
    runId: string,
    listener: (event: SearchRunEvent) => void,
  ): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  /**
   * SSE 订阅编排：先订阅（缓冲），再重放历史，最后按 seq 去重交付。
   * 订阅先于重放建立，消除“重放快照与订阅之间”的事件丢失窗口。
   */
  openStream(
    runId: string,
    lastEventId: number,
    deliver: (event: SearchRunEvent) => void,
  ): RunStreamHandle {
    let lastSent = lastEventId;
    let replayDone = false;
    let sawTerminal = false;
    const buffered: SearchRunEvent[] = [];
    const deliverOnce = (event: SearchRunEvent) => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      if ((TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(event.type))
        sawTerminal = true;
      deliver(event);
    };
    const unsubscribe = this.subscribe(runId, (event) => {
      if (!replayDone) {
        buffered.push(event);
        return;
      }
      deliverOnce(event);
    });
    const done = (async () => {
      try {
        const history = await this.listAfter(runId, lastEventId);
        for (const event of history) deliverOnce(event);
      } finally {
        replayDone = true;
      }
      for (const event of buffered) deliverOnce(event);
      return sawTerminal;
    })();
    return { unsubscribe, done };
  }

  /** 追加事件；seq 按 run 内单调递增分配。 */
  append(
    runId: string,
    type: SearchRunEventType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const prev = this.seqChains.get(runId) ?? Promise.resolve();
    const task = prev.then(async () => {
      const seq = await this.allocateSeq(runId);
      await agentSearchRunEventDb.append(runId, seq, type, payload);
      this.emitter.emit(runId, {
        run_id: runId,
        seq,
        type,
        payload,
        created_at: Date.now(),
      } satisfies SearchRunEvent);
    });
    this.seqChains.set(
      runId,
      task.catch(() => {
        // 链条断裂不影响后续追加
      }),
    );
    return task;
  }

  private async allocateSeq(runId: string): Promise<number> {
    let next = this.nextSeq.get(runId);
    if (next === undefined) {
      next = await agentSearchRunEventDb.maxSeq(runId);
    }
    next += 1;
    this.nextSeq.set(runId, next);
    return next;
  }

  async listAfter(runId: string, afterSeq: number): Promise<SearchRunEvent[]> {
    const rows = await agentSearchRunEventDb.listAfter(runId, afterSeq);
    return rows.map((r) => ({
      run_id: r.run_id,
      seq: r.seq,
      type: r.type as SearchRunEventType,
      payload: safeParse(r.payload_json),
      created_at: r.created_at,
    }));
  }

  dispose(runId: string): void {
    this.nextSeq.delete(runId);
    this.seqChains.delete(runId);
    this.emitter.removeAllListeners(runId);
  }
}

function safeParse(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const runEventHub = new RunEventHub();
