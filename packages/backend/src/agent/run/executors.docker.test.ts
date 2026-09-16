import { PassThrough } from "stream";
import { Writable } from "stream";
import { describe, expect, it, vi } from "vitest";
import { createDockerExecutor, type DockerClient } from "./executors.js";
import type Dockerode from "dockerode";

interface FakeContainer {
  createConfig: Dockerode.ContainerCreateOptions;
  attachOpts: Record<string, unknown>;
  stderr: PassThrough;
  killSignals: unknown[];
  removeOpts: unknown[];
  resolveWait: (statusCode: number) => void;
}

/** 最小假 dockerode 客户端：记录 createContainer 入参，容器方法可控可观测。 */
function fakeDocker(): {
  client: DockerClient;
  /** 须在 executor.start() 之后访问（createContainer 被调用后才有值）。 */
  readonly container: FakeContainer;
} {
  let container: FakeContainer | undefined;
  const client: DockerClient = {
    async createContainer(config) {
      container = {
        createConfig: config,
        attachOpts: {},
        stderr: new PassThrough(),
        killSignals: [],
        removeOpts: [],
        resolveWait: () => {},
      };
      const c = container;
      return {
        modem: {
          demuxStream: (stream: PassThrough, _out: unknown, err: Writable) => {
            stream.on("data", (d) => err.write(d));
          },
        },
        async attach(opts: Record<string, unknown>) {
          c.attachOpts = opts;
          return c.stderr;
        },
        async start() {},
        async wait() {
          return new Promise((resolve) => {
            c.resolveWait = (statusCode) => resolve({ StatusCode: statusCode });
          });
        },
        async kill(opts: unknown) {
          c.killSignals.push(opts);
        },
        async remove(opts: unknown) {
          c.removeOpts.push(opts);
        },
      } as unknown as Dockerode.Container;
    },
  };
  return {
    client,
    get container(): FakeContainer {
      if (!container) throw new Error("createContainer not called yet");
      return container;
    },
  };
}

function startContext(): Parameters<
  ReturnType<typeof createDockerExecutor>["start"]
>[0] {
  return {
    runId: "asr_docker",
    workspaceDir: "/tmp/ws",
    runDir: "/tmp/ws/run",
    env: { AGENT_RUN_ID: "asr_docker", AGENT_SERVICE_TOKEN: "tok" },
  };
}

describe("createDockerExecutor", () => {
  it("creates an isolated container with env, read-only binds and host-gateway", async () => {
    const fake = fakeDocker();
    const handle = await createDockerExecutor(
      "worker-img:1",
      () => fake.client,
    ).start(startContext());
    const { container } = fake;

    expect(container.createConfig.Image).toBe("worker-img:1");
    expect(container.createConfig.name).toBe("craft-worker-asr_docker");
    expect(container.createConfig.Env).toEqual(
      expect.arrayContaining([
        "AGENT_RUN_ID=asr_docker",
        "AGENT_SERVICE_TOKEN=tok",
        "AGENT_PLUGIN_FILE=/run/plugin.json",
        "AGENT_WORKSPACE_ROOT=/workspace/repo",
      ]),
    );
    const host = container.createConfig.HostConfig!;
    expect(host.NetworkMode).toBe("bridge");
    expect(host.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Binds).toEqual([
      "/tmp/ws/repo:/workspace/repo:ro",
      "/tmp/ws/run:/run:ro",
    ]);
    // attach 在 start 前建立，仅订阅 stderr
    expect(container.attachOpts).toEqual({
      stream: true,
      stdin: false,
      stdout: false,
      stderr: true,
    });

    container.resolveWait(0);
    const exited = await handle.exited;
    expect(exited.code).toBe(0);
  });

  it("defaults the gateway URL to the host-gateway published port and honors overrides", async () => {
    const a = fakeDocker();
    await createDockerExecutor("img", () => a.client).start(startContext());
    const envA = a.container.createConfig.Env as string[];
    expect(envA).toContain(
      `AGENT_GATEWAY_INTERNAL_URL=http://host.docker.internal:${process.env.PORT || 3000}`,
    );

    const b = fakeDocker();
    await createDockerExecutor("img", () => b.client).start({
      ...startContext(),
      env: {
        AGENT_RUN_ID: "asr_docker",
        AGENT_SERVICE_TOKEN: "tok",
        AGENT_GATEWAY_INTERNAL_URL: "http://override.example:9",
      },
    });
    expect(b.container.createConfig.Env).toContain(
      "AGENT_GATEWAY_INTERNAL_URL=http://override.example:9",
    );
  });

  it("forwards demuxed container stderr to process stderr with the run prefix", async () => {
    const fake = fakeDocker();
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await createDockerExecutor("img", () => fake.client).start(
        startContext(),
      );
      fake.container.stderr.write("boom");
      await new Promise((r) => setImmediate(r));
      expect(spy).toHaveBeenCalledWith("[craft-worker-asr_docker] boom\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("kills with SIGKILL and removes the container after wait settles (--rm parity)", async () => {
    const fake = fakeDocker();
    const handle = await createDockerExecutor("img", () => fake.client).start(
      startContext(),
    );
    const { container } = fake;

    await handle.kill();
    expect(container.killSignals).toEqual([{ signal: "SIGKILL" }]);
    container.resolveWait(137);
    await handle.exited;
    expect(container.removeOpts).toEqual([{ force: true }]);
  });
});
