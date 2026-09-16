import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalProcessExecutor } from "./executors.js";

let base: string;
let outFile: string;

const PROBE = (out: string) => `import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(out)}, JSON.stringify({
  plugin: process.env.AGENT_PLUGIN_FILE,
  workspace: process.env.AGENT_WORKSPACE_ROOT,
  url: process.env.AGENT_GATEWAY_INTERNAL_URL,
  token: process.env.AGENT_SERVICE_TOKEN,
}));
`;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "exec-"));
  await mkdir(path.join(base, "run"), { recursive: true });
  await mkdir(path.join(base, "repo"), { recursive: true });
  outFile = path.join(base, "probe.json");
  await writeFile(path.join(base, "probe.mjs"), PROBE(outFile));
  process.env.AGENT_WORKER_ENTRY = path.join(base, "probe.mjs");
  delete process.env.AGENT_WORKER_GATEWAY_URL;
});

afterEach(async () => {
  delete process.env.AGENT_WORKER_ENTRY;
  delete process.env.AGENT_WORKER_GATEWAY_URL;
  await rm(base, { recursive: true, force: true });
});

async function probeEnv(
  extraEnv: Record<string, string> = {},
): Promise<Record<string, string>> {
  const executor = createLocalProcessExecutor();
  const handle = await executor.start({
    runId: "asr_probe",
    workspaceDir: base,
    runDir: path.join(base, "run"),
    env: { AGENT_RUN_ID: "asr_probe", AGENT_SERVICE_TOKEN: "tok", ...extraEnv },
  });
  const exited = await handle.exited;
  expect(exited.code).toBe(0);
  return JSON.parse(await readFile(outFile, "utf8"));
}

describe("createLocalProcessExecutor", () => {
  it("maps plugin/workspace env to host paths and defaults the URL to the loopback port", async () => {
    const probe = await probeEnv();
    expect(probe.plugin).toBe(path.join(base, "run", "plugin.json"));
    expect(probe.workspace).toBe(path.join(base, "repo"));
    expect(probe.url).toBe(`http://127.0.0.1:${process.env.PORT || 3000}`);
    expect(probe.token).toBe("tok");
  });

  it("honors an explicit AGENT_GATEWAY_INTERNAL_URL from the start context", async () => {
    const probe = await probeEnv({
      AGENT_GATEWAY_INTERNAL_URL: "http://override.example:9",
    });
    expect(probe.url).toBe("http://override.example:9");
  });
});
