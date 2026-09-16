import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import path from "path";

export interface ExecutorStartContext {
  runId: string;
  /** 宿主机目录，其内 repo/ 子目录为 worker 的只读 workspace 源。 */
  workspaceDir: string;
  /** 宿主机目录，内含 plugin.json（manifest+prompt+schemas+digest+run 输入）。 */
  runDir: string;
  /** 与 worker 约定的基础 env：AGENT_RUN_ID、AGENT_SERVICE_TOKEN，可选 AGENT_GATEWAY_INTERNAL_URL 覆盖。 */
  env: Record<string, string>;
}

export interface ExecutorHandle {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): Promise<void>;
}

export interface RunExecutor {
  readonly name: string;
  start(ctx: ExecutorStartContext): Promise<ExecutorHandle>;
}

function childHandle(child: ChildProcess): ExecutorHandle {
  return {
    exited: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

export function createDockerExecutor(image: string): RunExecutor {
  return {
    name: "docker",
    async start(ctx: ExecutorStartContext) {
      const containerName = `craft-worker-${ctx.runId}`;
      const env: Record<string, string> = {
        ...ctx.env,
        AGENT_GATEWAY_INTERNAL_URL:
          ctx.env.AGENT_GATEWAY_INTERNAL_URL ??
          `http://host.docker.internal:${process.env.PORT || 3000}`,
        AGENT_PLUGIN_FILE: "/run/plugin.json",
        AGENT_WORKSPACE_ROOT: "/workspace/repo",
      };
      const child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network",
          "bridge",
          // Linux 上 host.docker.internal 仅在显式映射 host-gateway 后可解析
          "--add-host",
          "host.docker.internal:host-gateway",
          "--read-only",
          "-v",
          `${ctx.workspaceDir}/repo:/workspace/repo:ro`,
          "-v",
          `${ctx.runDir}:/run:ro`,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          image,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.on("data", (d) => {
        // 容器级错误日志；worker 自身进度经 internal API 上报
        if (d.toString().trim()) {
          process.stderr.write(`[craft-worker-${ctx.runId}] ${d}`);
        }
      });
      return {
        ...childHandle(child),
        kill: async () => {
          await new Promise<void>((resolve) => {
            const killer = spawn("docker", ["kill", containerName], {
              stdio: "ignore",
            });
            killer.once("exit", () => resolve());
            killer.once("error", () => resolve());
          });
        },
      };
    },
  };
}

/**
 * 本地进程执行器：不经 Docker 直接以子进程运行 worker 入口（开发/测试用）。
 * 隔离性弱于容器，仅建议在受控环境通过 AGENT_WORKER_LOCAL=1 启用。
 */
export function createLocalProcessExecutor(): RunExecutor {
  return {
    name: "local",
    async start(ctx: ExecutorStartContext) {
      const entry =
        process.env.AGENT_WORKER_ENTRY || "packages/worker/dist/index.js";
      const env = {
        ...process.env,
        ...ctx.env,
        AGENT_GATEWAY_INTERNAL_URL:
          ctx.env.AGENT_GATEWAY_INTERNAL_URL ??
          `http://127.0.0.1:${process.env.PORT || 3000}`,
        AGENT_PLUGIN_FILE: path.join(ctx.runDir, "plugin.json"),
        AGENT_WORKSPACE_ROOT: path.join(ctx.workspaceDir, "repo"),
      };
      const child = spawn(process.execPath, [entry], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (d) => {
        const text = d.toString().trim();
        if (text) process.stderr.write(`[craft-worker-local] ${text}\n`);
      });
      return childHandle(child);
    },
  };
}
