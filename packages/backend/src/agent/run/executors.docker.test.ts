import { PassThrough } from "stream";
import { Writable } from "stream";
import { describe, expect, it, vi } from "vitest";
import {
  createDockerExecutor,
  type DockerClient,
} from "./executors.js";
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
function fakeDocker(opts: {
  /** inspect 抛出则视为镜像不存在（404）或其他错误。 */
  inspectError?: object;
  pullError?: Error;
  /** 覆盖默认 pull：返回受控流/延迟 promise 以模拟卡死、迟到或出错的拉取。 */
  pullImpl?: () => Promise<PassThrough> | PassThrough;
} = {}): {
  client: DockerClient;
  pullCalls: string[];
  /** 须在 executor.start() 之后访问（createContainer 被调用后才有值）。 */
  readonly container: FakeContainer;
} {
  let container: FakeContainer | undefined;
  const pullCalls: string[] = [];
  const client: DockerClient = {
    getImage(image: string) {
      return {
        async inspect() {
          if (opts.inspectError) throw opts.inspectError;
          return { Id: `sha256:${image}` };
        },
      } as unknown as Dockerode.Image;
    },
    pull: (async (image: string) => {
      pullCalls.push(image);
      if (opts.pullError) throw opts.pullError;
      if (opts.pullImpl) return opts.pullImpl();
      const stream = new PassThrough();
      stream.end();
      return stream;
    }) as unknown as DockerClient["pull"],
    modem: {
      followProgress(
        stream: PassThrough,
        onFinished: (err: Error | null, output: unknown) => void,
      ) {
        stream.resume();
        stream.on("end", () => onFinished(null, []));
        stream.on("error", (err: Error) => onFinished(err, null));
      },
    } as unknown as DockerClient["modem"],
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
    pullCalls,
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

describe("createDockerExecutor image auto-pull", () => {
  const notFound = Object.assign(new Error("No such image"), {
    statusCode: 404,
  });

  it("skips pull when the image already exists locally", async () => {
    const fake = fakeDocker();
    await createDockerExecutor("worker-img:1", () => fake.client).start(
      startContext(),
    );
    expect(fake.pullCalls).toEqual([]);
    expect(fake.container.createConfig.Image).toBe("worker-img:1");
  });

  it("pulls once when inspect returns 404, then creates the container", async () => {
    const fake = fakeDocker({ inspectError: notFound });
    await createDockerExecutor("worker-img:1", () => fake.client).start(
      startContext(),
    );
    expect(fake.pullCalls).toEqual(["worker-img:1"]);
    expect(fake.container.createConfig.Image).toBe("worker-img:1");
  });

  it("pulls again if a previously pulled image is later missing", async () => {
    const fake = fakeDocker({ inspectError: notFound });
    const executor = createDockerExecutor("deleted-img:1", () => fake.client);
    await executor.start(startContext());
    await executor.start({ ...startContext(), runId: "later-run" });
    expect(fake.pullCalls).toEqual(["deleted-img:1", "deleted-img:1"]);
  });

  it("deduplicates concurrent pulls of the same image across runs", async () => {
    const fake = fakeDocker({ inspectError: notFound });
    const starts = await Promise.all(
      ["run_a", "run_b", "run_c"].map((runId) =>
        createDockerExecutor("shared-img:2", () => fake.client).start({
          ...startContext(),
          runId,
        }),
      ),
    );
    expect(fake.pullCalls).toEqual(["shared-img:2"]);
    expect(starts).toHaveLength(3);
  });

  it("surfaces an actionable error (without env secrets) when pull fails", async () => {
    const fake = fakeDocker({ inspectError: notFound, pullError: new Error("pull access denied") });
    await expect(
      createDockerExecutor("private-img:9", () => fake.client).start(
        startContext(),
      ),
    ).rejects.toThrow(/Failed to pull missing worker image "private-img:9"/);
    // 失败不缓存：后续 run 可重试拉取
    await expect(
      createDockerExecutor("private-img:9", () => fake.client).start(
        startContext(),
      ),
    ).rejects.toThrow(/docker pull private-img:9/);
    expect(fake.pullCalls).toEqual(["private-img:9", "private-img:9"]);
  });

  it("does not pull and rethrows when inspect fails with a non-404 error", async () => {
    const daemonErr = Object.assign(
      new Error("permission denied while accessing docker.sock"),
      { statusCode: 403 },
    );
    const fake = fakeDocker({ inspectError: daemonErr });
    await expect(
      createDockerExecutor("worker-img:1", () => fake.client).start(
        startContext(),
      ),
    ).rejects.toThrow("permission denied while accessing docker.sock");
    expect(fake.pullCalls).toEqual([]);
  });

  it("times out and destroys a stalled pull stream without creating a container", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const fake = fakeDocker({
        inspectError: notFound,
        pullImpl: () => stream,
      });
      const startP = createDockerExecutor("stalled-img:1", () => fake.client)
        .start(startContext());
      const assertion = expect(startP).rejects.toThrow(
        /timed out after 10 minutes/,
      );
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await assertion;
      expect(stream.destroyed).toBe(true);
      const assertion2 = expect(
        createDockerExecutor("stalled-img:1", () => fake.client).start(
          startContext(),
        ),
      ).rejects.toThrow(/timed out after 10 minutes/);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await assertion2;
      expect(fake.pullCalls).toEqual(["stalled-img:1", "stalled-img:1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a stream that arrives after the pull timeout fired", async () => {
    vi.useFakeTimers();
    try {
      let resolvePull: (s: PassThrough) => void = () => {};
      const fake = fakeDocker({
        inspectError: notFound,
        pullImpl: () =>
          new Promise<PassThrough>((resolve) => {
            resolvePull = resolve;
          }),
      });
      const startP = createDockerExecutor("late-img:1", () => fake.client)
        .start(startContext());
      const assertion = expect(startP).rejects.toThrow(
        /timed out after 10 minutes/,
      );
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await assertion;
      const late = new PassThrough();
      resolvePull(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects synchronous progress errors immediately and clears the timeout", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const fake = fakeDocker({ inspectError: notFound, pullImpl: () => stream });
      vi.spyOn(fake.client.modem, "followProgress").mockImplementation(() => {
        throw new Error("invalid progress stream");
      });
      await expect(createDockerExecutor("sync-progress-img:1", () => fake.client).start(startContext()))
        .rejects.toThrow("invalid progress stream");
      expect(stream.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => fake.container).toThrow("createContainer not called yet");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a pull stream error emitted before container creation", async () => {
    let stream: PassThrough | undefined;
    const fake = fakeDocker({
      inspectError: notFound,
      pullImpl: () => {
        stream = new PassThrough();
        process.nextTick(() => stream!.emit("error", new Error("layer fetch failed")));
        return stream;
      },
    });
    await expect(
      createDockerExecutor("err-img:1", () => fake.client).start(
        startContext(),
      ),
    ).rejects.toThrow(/Failed to pull missing worker image "err-img:1".*layer fetch failed/s);
    await expect(
      createDockerExecutor("err-img:1", () => fake.client).start(
        startContext(),
      ),
    ).rejects.toThrow(/layer fetch failed/);
    expect(fake.pullCalls).toEqual(["err-img:1", "err-img:1"]);
  });
});
