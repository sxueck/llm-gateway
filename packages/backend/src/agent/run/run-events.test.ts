import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = new Map<string, any[]>();
  return {
    rows,
    agentSearchRunEventRepository: {
      append: vi.fn(
        async (runId: string, seq: number, type: string, payload: unknown) => {
          const list = rows.get(runId) ?? [];
          list.push({
            run_id: runId,
            seq,
            type,
            payload_json: JSON.stringify(payload ?? {}),
            created_at: Date.now(),
          });
          rows.set(runId, list);
        },
      ),
      maxSeq: vi.fn(async (runId: string) =>
        Math.max(0, ...(rows.get(runId) ?? []).map((r) => r.seq)),
      ),
      listAfter: vi.fn(async (runId: string, after: number) =>
        (rows.get(runId) ?? [])
          .filter((r) => r.seq > after)
          .sort((a, b) => a.seq - b.seq),
      ),
      deleteByRunIds: vi.fn(),
    },
  };
});

vi.mock("../../db/index.js", () => ({
  agentSearchRunEventDb: mocks.agentSearchRunEventRepository,
}));

import { RunEventHub } from "./run-events.js";

describe("RunEventHub.openStream", () => {
  it("subscribes before replaying so events appended during replay are not lost", async () => {
    const hub = new RunEventHub();
    await hub.append("r1", "run.queued");
    const delivered: number[] = [];
    const stream = hub.openStream("r1", 0, (e) => delivered.push(e.seq));
    await hub.append("r1", "worker.started");
    await stream.done;
    expect(delivered).toEqual([1, 2]);
    expect(await stream.done).toBe(false);
    stream.unsubscribe();
    hub.dispose("r1");
  });

  it("flags terminal events seen during replay", async () => {
    const hub = new RunEventHub();
    await hub.append("r2", "run.queued");
    await hub.append("r2", "run.completed");
    const delivered: string[] = [];
    const stream = hub.openStream("r2", 0, (e) => delivered.push(e.type));
    expect(await stream.done).toBe(true);
    expect(delivered).toEqual(["run.queued", "run.completed"]);
    stream.unsubscribe();
    hub.dispose("r2");
  });

  it("keeps delivering live events after the replay window", async () => {
    const hub = new RunEventHub();
    await hub.append("r3", "run.queued");
    const delivered: number[] = [];
    const stream = hub.openStream("r3", 0, (e) => delivered.push(e.seq));
    expect(await stream.done).toBe(false);
    await hub.append("r3", "run.started");
    await hub.append("r3", "run.completed");
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toEqual([1, 2, 3]);
    stream.unsubscribe();
    hub.dispose("r3");
  });

  it("resumes from lastEventId for reconnect replay", async () => {
    const hub = new RunEventHub();
    await hub.append("r4", "run.queued");
    await hub.append("r4", "run.started");
    const delivered: number[] = [];
    const stream = hub.openStream("r4", 1, (e) => delivered.push(e.seq));
    await stream.done;
    expect(delivered).toEqual([2]);
    stream.unsubscribe();
    hub.dispose("r4");
  });
});
