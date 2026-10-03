import { spawn } from "child_process";
import { existsSync } from "fs";
import type { ChildProcess } from "child_process";
import { Writable } from "stream";
import path from "path";
import Docker from "dockerode";

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

export type DockerClient = Pick<
  Docker,
  "createContainer" | "getImage" | "pull" | "modem"
>;

type PullStream = Awaited<ReturnType<DockerClient["pull"]>>;

function destroyPullStream(stream: PullStream): void {
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
}

/** 同一镜像的并发拉取去重：多个 run 同时发现镜像缺失时只发一次 docker pull。 */
const pendingPulls = new Map<string, Promise<void>>();

/** 拉取整体硬上限：scheduler 超时在 executor.start 之后才计时，此处不设界会占死 worker 并发。 */
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

function isImageNotFound(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 404;
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pullTimeoutError(image: string): Error {
  return new Error(
    `Pull of worker image "${image}" timed out after ${
      PULL_TIMEOUT_MS / 60000
    } minutes`,
  );
}

function pullWithTimeout(
  client: DockerClient,
  image: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stream: PullStream | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (stream) destroyPullStream(stream);
      reject(pullTimeoutError(image));
    }, PULL_TIMEOUT_MS);
    timer.unref?.();
    Promise.resolve().then(() => client.pull(image)).then(
      (s) => {
        if (timedOut) {
          destroyPullStream(s);
          return;
        }
        stream = s;
        client.modem.followProgress(s, (err, _output) => {
          clearTimeout(timer);
          if (timedOut) return;
          if (err) {
            destroyPullStream(s);
            reject(err);
          } else resolve();
        });
      },
    ).catch((err) => {
      clearTimeout(timer);
      if (stream) destroyPullStream(stream);
      if (!timedOut) reject(err);
    });
  });
}

/**
 * 确保 worker 镜像存在：仅在 inspect 返回 404（真缺镜像）时拉取；
 * daemon 权限/网络等其他错误原样抛出，不做业务重试。
 */
async function ensureImage(client: DockerClient, image: string): Promise<void> {
  try {
    await client.getImage(image).inspect();
    return;
  } catch (err) {
    if (!isImageNotFound(err)) throw err;
  }
  let pending = pendingPulls.get(image);
  if (!pending) {
    pending = pullWithTimeout(client, image);
    // Only in-flight pulls are shared; a later image deletion must trigger a fresh pull.
    pending.then(() => pendingPulls.delete(image), () => pendingPulls.delete(image));
    pendingPulls.set(image, pending);
  }
  try {
    await pending;
  } catch (err) {
    throw new Error(
      `Failed to pull missing worker image "${image}". ` +
        `Verify registry access/credentials (e.g. docker pull ${image}) and retry. ` +
        `Cause: ${asErrorMessage(err)}`,
    );
  }
}

export function createDockerExecutor(
  image: string,
  createClient: () => DockerClient = () => new Docker(),
): RunExecutor {
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
      const client = createClient();
      await ensureImage(client, image);
      const container = await client.createContainer({
        Image: image,
        name: containerName,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          // 与 compose 网络隔离：worker 只经 host-gateway 回连网关发布端口
          NetworkMode: "bridge",
          // Linux 上 host.docker.internal 仅在显式映射 host-gateway 后可解析
          ExtraHosts: ["host.docker.internal:host-gateway"],
          ReadonlyRootfs: true,
          Binds: [
            `${ctx.workspaceDir}/repo:/workspace/repo:ro`,
            `${ctx.runDir}:/run:ro`,
          ],
        },
      });
      const stderr = await container.attach({
        stream: true,
        stdin: false,
        stdout: false,
        stderr: true,
      });
      // 容器级错误日志；worker 自身进度经 internal API 上报
      container.modem.demuxStream(
        stderr,
        new Writable({
          write(_chunk, _enc, cb) {
            cb();
          },
        }),
        new Writable({
          write(chunk, _enc, cb) {
            const text = chunk.toString().trim();
            if (text) process.stderr.write(`[${containerName}] ${text}\n`);
            cb();
          },
        }),
      );
      await container.start();
      const exited = container
        .wait()
        .then(
          (res: { StatusCode?: number }) =>
            ({ code: res.StatusCode ?? -1, signal: null }) as const,
          () => ({ code: -1, signal: null }) as const,
        )
        .finally(() => {
          // 对应 docker run --rm：wait 终态后兜底清理（force 幂等，与 kill 路径重复无害）
          void container.remove({ force: true }).catch(() => {});
        });
      return {
        exited,
        kill: async () => {
          // 容器已退出/已移除时 kill 返回 404/409，按已终止处理
          await container.kill({ signal: "SIGKILL" }).catch(() => {});
        },
      };
    },
  };
}

/**
 * 本地进程执行器：不经 Docker 直接以子进程运行 worker 入口（开发/测试用）。
 * 隔离性弱于容器，仅建议在受控环境通过 AGENT_WORKER_LOCAL=1 启用。
 */
function resolveLocalWorkerEntry(): string {
  const explicit = process.env.AGENT_WORKER_ENTRY;
  if (explicit) return explicit;
  // cwd 可能是仓库根（bun run dev:all）或 packages/backend（bun run dev），逐一探测
  const candidates = [
    path.resolve(process.cwd(), "packages/worker/dist/index.js"),
    path.resolve(process.cwd(), "../worker/dist/index.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function createLocalProcessExecutor(): RunExecutor {
  return {
    name: "local",
    async start(ctx: ExecutorStartContext) {
      const entry = resolveLocalWorkerEntry();
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
