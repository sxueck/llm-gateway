import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import {
  structuredResultSchema,
  TERMINAL_RUN_STATUSES,
  type StructuredSearchResult,
} from "@llm-gateway/shared";
import { agentSearchRunDb, agentSearchUsageDb } from "../../db/index.js";
import { memoryLogger } from "../../services/logger.js";
import { runEventHub } from "./run-events.js";
import { prepareWorkspace, readRunQuery } from "./run.service.js";
import type {
  RunExecutor,
  ExecutorHandle,
  ExecutorStartContext,
} from "./executors.js";
export type { RunExecutor, ExecutorHandle };
import type { AgentSearchRun, AgentSearchUsage } from "../../db/types.js";
import { getMasterKey, encryptText } from "../snapshot/encryption.js";

export interface UsageReport {
  turns: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  model_route_metadata?: Record<string, unknown> | null;
}

export type TerminalReport =
  | { kind: "completed"; result: unknown; usage: UsageReport }
  | {
      kind: "failed";
      error_code: string;
      error_message: string;
      usage?: UsageReport;
    }
  | { kind: "budget_exceeded"; error_message: string; usage?: UsageReport };

interface ActiveRun {
  run: AgentSearchRun;
  executorHandle: ExecutorHandle | null;
  cancelRequested: () => void;
  terminal: (report: TerminalReport) => void;
  timedOut: () => void;
}

const TERMINAL_EVENT: Record<
  string,
  "run.completed" | "run.failed" | "run.cancelled"
> = {
  completed: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
  timed_out: "run.failed",
  budget_exceeded: "run.failed",
};

/**
 * 进程内 run 调度器：FIFO 队列 + 并发上限 + 超时 + 取消传播 + 崩溃恢复。
 */
export class SearchRunScheduler {
  private executor: RunExecutor | null = null;
  private queue: string[] = [];
  private active = new Map<string, ActiveRun>();
  private starting = new Set<string>();
  private concurrency = Number(process.env.AGENT_SEARCH_CONCURRENCY || 2);

  setExecutor(executor: RunExecutor): void {
    this.executor = executor;
  }

  queueDepth(): number {
    return this.queue.length + this.active.size + this.starting.size;
  }

  enqueue(runId: string): void {
    this.queue.push(runId);
    this.pump();
  }

  /** 内部 API 收到 worker 终态上报时调用；返回 false 表示 run 不在执行中。 */
  reportTerminal(runId: string, report: TerminalReport): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.terminal(report);
    return true;
  }

  /** 幂等取消：只触发一次终止动作。 */
  requestKill(runId: string): void {
    const active = this.active.get(runId);
    if (active) active.cancelRequested();
  }

  /** 同步循环：starting 槽位在启动注册前即被占用，并发上限不会被突刺击穿。 */
  private pump(): void {
    while (
      this.active.size + this.starting.size < this.concurrency &&
      this.queue.length > 0
    ) {
      const runId = this.queue.shift()!;
      this.starting.add(runId);
      void this.startRun(runId)
        .catch((e) => {
          memoryLogger.error?.(
            `Run ${runId} scheduler error: ${e}`,
            "AgentSearch",
          );
        })
        .finally(() => {
          this.starting.delete(runId);
          this.pump();
        });
    }
  }

  private async startRun(runId: string): Promise<void> {
    const run = await agentSearchRunDb.getById(runId);
    if (!run || run.status !== "queued") return;

    if (run.cancellation_requested_at) {
      await this.finalize(run, "cancelled", {
        errorCode: "cancelled_before_start",
      });
      return;
    }
    if (!this.executor) {
      await this.finalize(run, "failed", {
        errorCode: "executor_not_configured",
      });
      return;
    }

    const workspaceRoot = path.join(this.workspaceBase(), runId);
    const repoDir = path.join(workspaceRoot, "repo");
    const runDir = path.join(workspaceRoot, "run");
    let handle: ExecutorHandle | null = null;

    const active: ActiveRun = {
      run,
      executorHandle: null,
      cancelRequested: () => {},
      terminal: () => {},
      timedOut: () => {},
    };
    this.active.set(runId, active);

    const outcome = new Promise<
      | { kind: "terminal"; report: TerminalReport }
      | { kind: "exited" }
      | { kind: "timeout" }
      | { kind: "cancel" }
    >((resolve) => {
      active.terminal = (report) => resolve({ kind: "terminal", report });
      active.cancelRequested = () => resolve({ kind: "cancel" });
      active.timedOut = () => resolve({ kind: "timeout" });
    });

    try {
      await agentSearchRunDb.update(runId, {
        status: "running",
        started_at: Date.now(),
      });
      await runEventHub.append(runId, "run.started", {
        plugin: `${run.plugin_id}@${run.plugin_version}`,
      });

      // 数据源固定：本地快照 → 只读 workspace
      await prepareWorkspace(run, repoDir);
      await runEventHub.append(runId, "source.resolved", {
        source_type: run.source_type,
        snapshot_id: run.snapshot_id,
      });

      // plugin bundle + run 输入（worker 只读挂载）
      await mkdir(runDir, { recursive: true });
      const { resolvePlugin } = await import("../plugins/store.js");
      // 已入队的 run 固定了当时的 digest；发布后新撤销的版本允许存量 run 完成（PRD §14.2）
      const plugin = await resolvePlugin(run.plugin_id, run.plugin_version, {
        allowRevoked: true,
      });
      if (!plugin) {
        throw new RunErrorLike(
          "invalid_state",
          `plugin ${run.plugin_id}@${run.plugin_version} missing`,
        );
      }
      const query = await readRunQuery(run);
      await writeFile(
        path.join(runDir, "plugin.json"),
        JSON.stringify(
          {
            run_id: runId,
            query,
            model_profile: run.model_profile,
            plugin: {
              id: plugin.manifest.id,
              version: plugin.manifest.version,
              digest: plugin.digest,
              manifest: plugin.manifest,
              files: plugin.files,
            },
          },
          null,
          2,
        ),
        { mode: 0o444 },
      );

      const serviceToken = this.pendingTokens.get(runId) ?? "";
      this.pendingTokens.delete(runId);
      const gatewayUrlOverride = process.env.AGENT_WORKER_GATEWAY_URL;
      const ctx: ExecutorStartContext = {
        runId,
        workspaceDir: workspaceRoot,
        runDir,
        env: {
          AGENT_RUN_ID: runId,
          AGENT_SERVICE_TOKEN: serviceToken,
          ...(gatewayUrlOverride
            ? { AGENT_GATEWAY_INTERNAL_URL: gatewayUrlOverride }
            : {}),
        },
      };

      await runEventHub.append(runId, "worker.started", {
        executor: this.executor.name,
      });
      handle = await this.executor.start(ctx);
      active.executorHandle = handle;

      const overrideMs = Number(process.env.AGENT_SEARCH_TIMEOUT_MS || 0);
      const timeoutMs =
        overrideMs > 0
          ? overrideMs
          : plugin.manifest.execution_policy.timeout_seconds * 1000 +
            Number(process.env.AGENT_SEARCH_TIMEOUT_MARGIN_MS || 60_000);
      const timer = setTimeout(() => active.timedOut(), timeoutMs);

      const result = await Promise.race([
        outcome,
        handle.exited.then(() => ({ kind: "exited" }) as const),
      ]);
      clearTimeout(timer);

      switch (result.kind) {
        case "terminal": {
          const { report } = result;
          if (report.kind === "completed") {
            const usageRow = await agentSearchUsageDb.getByRunId(runId);
            const enriched = {
              ...(report.result as Record<string, unknown>),
              run_id: runId,
              repository: {
                source_type: run.source_type,
                snapshot_id: run.snapshot_id,
                commit: run.resolved_commit,
              },
              usage: {
                plugin: `${run.plugin_id}@${run.plugin_version}`,
                model_profile: run.model_profile,
                turns: report.usage.turns,
                tool_calls: report.usage.tool_calls,
                input_tokens: usageRow?.input_tokens ?? 0,
                output_tokens: usageRow?.output_tokens ?? 0,
                cost: Number(usageRow?.cost ?? 0),
              },
            };
            const parsed = structuredResultSchema.safeParse(enriched);
            if (parsed.success) {
              await this.finalize(run, "completed", {
                result: parsed.data,
                usage: report.usage,
              });
            } else {
              await this.finalize(run, "failed", {
                errorCode: "output_validation_failed",
                errorMessage: parsed.error.issues
                  .slice(0, 5)
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; "),
                usage: report.usage,
              });
            }
          } else if (report.kind === "budget_exceeded") {
            await this.finalize(run, "budget_exceeded", {
              errorCode: "budget_exceeded",
              errorMessage: report.error_message,
              usage: report.usage,
            });
          } else {
            await this.finalize(run, "failed", {
              errorCode: report.error_code,
              errorMessage: report.error_message,
              usage: report.usage,
            });
          }
          await handle.kill().catch(() => {});
          break;
        }
        case "exited": {
          // worker 进程退出但未上报终态
          await this.finalize(run, "failed", {
            errorCode: "worker_exited_without_result",
          });
          break;
        }
        case "timeout": {
          await handle.kill().catch(() => {});
          await this.finalize(run, "timed_out", { errorCode: "timeout" });
          break;
        }
        case "cancel": {
          await handle.kill().catch(() => {});
          await this.finalize(run, "cancelled", { errorCode: "cancelled" });
          break;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorCode =
        e instanceof RunErrorLike ? e.code : "workspace_preparation_failed";
      await this.finalize(run, "failed", { errorCode, errorMessage: message });
      await handle?.kill().catch(() => {});
    } finally {
      this.active.delete(runId);
      this.pendingTokens.delete(runId);
      runEventHub.dispose(runId);
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
      this.pump();
    }
  }

  private pendingTokens = new Map<string, string>();

  /** 创建 run 后立即注册 service token，供 executor env 注入。 */
  registerServiceToken(runId: string, token: string): void {
    this.pendingTokens.set(runId, token);
  }

  private workspaceBase(): string {
    return (
      process.env.AGENT_WORKSPACE_DIR ||
      path.join(process.cwd(), "data", "agent-workspaces")
    );
  }

  private async finalize(
    run: AgentSearchRun,
    status: AgentSearchRun["status"],
    opts: {
      errorCode?: string;
      errorMessage?: string;
      result?: StructuredSearchResult;
      usage?: UsageReport;
    } = {},
  ): Promise<void> {
    const now = Date.now();
    const updates: Parameters<typeof agentSearchRunDb.update>[1] = {
      status,
      completed_at: now,
      error_code: opts.errorCode ?? null,
      error_message: opts.errorMessage ?? null,
    };
    if (opts.result) {
      const masterKey = await getMasterKey();
      updates.result_encrypted = encryptText(
        masterKey,
        JSON.stringify(opts.result),
      );
    }
    await agentSearchRunDb.update(run.id, updates);

    if (opts.usage) {
      // token/cost 由 internal completion 网关侧累计（唯一权威）；这里只写 turns/tool_calls。
      const existing = await agentSearchUsageDb.getByRunId(run.id);
      const usage: AgentSearchUsage = {
        run_id: run.id,
        turn_count: opts.usage.turns,
        tool_call_count: opts.usage.tool_calls,
        input_tokens: Math.max(
          existing?.input_tokens ?? 0,
          opts.usage.input_tokens,
        ),
        output_tokens: Math.max(
          existing?.output_tokens ?? 0,
          opts.usage.output_tokens,
        ),
        cost: Math.max(Number(existing?.cost ?? 0), opts.usage.cost),
        model_route_metadata:
          existing?.model_route_metadata ??
          (opts.usage.model_route_metadata
            ? JSON.stringify(opts.usage.model_route_metadata)
            : null),
        updated_at: now,
      };
      await agentSearchUsageDb.upsert(usage);
    }

    const eventName = TERMINAL_EVENT[status] ?? "run.failed";
    await runEventHub.append(run.id, eventName, {
      status,
      error_code: opts.errorCode,
    });
    memoryLogger.info(
      `Run ${run.id} ${status}${opts.errorCode ? ` (${opts.errorCode})` : ""}`,
      "AgentSearch",
    );
  }

  async recoverAtBoot(): Promise<number> {
    const actives = await agentSearchRunDb.findActiveAtBoot();
    for (const run of actives) {
      await this.finalize(run, "failed", {
        errorCode: "gateway_restarted",
        errorMessage: "gateway restarted while the run was active",
      });
    }
    return actives.length;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  isTerminalStatus(status: string): boolean {
    return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  }
}

class RunErrorLike extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const searchRunScheduler = new SearchRunScheduler();
