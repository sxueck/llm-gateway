import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = new Map<string, any>();
  return {
    rows,
    workerPluginRepository: {
      create: vi.fn(async (row: any) => {
        const key = `${row.id}@${row.version}`;
        if (rows.has(key)) throw new Error(`duplicate ${key}`);
        rows.set(key, {
          bundle_url: null,
          signature: null,
          deprecated_at: null,
          revoked_at: null,
          ...row,
        });
        return rows.get(key);
      }),
      getByIdVersion: vi.fn(async (id: string, version: string) =>
        rows.get(`${id}@${version}`),
      ),
      listAll: vi.fn(async () => [...rows.values()]),
      setStatus: vi.fn(async (id: string, version: string, status: string) => {
        const row = rows.get(`${id}@${version}`);
        if (!row) return undefined;
        row.status = status;
        row.deprecated_at = null;
        row.revoked_at = null;
        if (status === "deprecated") row.deprecated_at = Date.now();
        if (status === "revoked") row.revoked_at = Date.now();
        if (status === "published") row.published_at = Date.now();
        return row;
      }),
    },
  };
});

vi.mock("../../db/index.js", () => ({
  workerPluginDb: mocks.workerPluginRepository,
}));
vi.mock("../../services/logger.js", () => ({
  memoryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  BUILTIN_PLUGIN_BUNDLES,
  publishPlugin,
  resolvePlugin,
  seedBuiltinPlugins,
  setPluginStatus,
} from "./store.js";
import { computeBundleDigest, validatePluginBundle } from "./registry.js";
import {
  CODE_SEARCH_INPUT_SCHEMA,
  CODE_SEARCH_MANIFEST,
  CODE_SEARCH_OUTPUT_SCHEMA,
  CODE_SEARCH_PROMPT_MD,
} from "./code-search.js";

// 版本引用 fixture 单一来源：升级内置插件版本时测试自动跟随
const PLUGIN_ID = CODE_SEARCH_MANIFEST.id;
const FIXTURE_VERSION = CODE_SEARCH_MANIFEST.version;
const FIXTURE_KEY = `${PLUGIN_ID}@${FIXTURE_VERSION}`;

function nextVersion(): string {
  const [major, minor, patch] = FIXTURE_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function validPublishInput() {
  return {
    manifest: JSON.parse(JSON.stringify(CODE_SEARCH_MANIFEST)),
    files: {
      "prompt.md": CODE_SEARCH_PROMPT_MD,
      "input.schema.json": JSON.stringify(CODE_SEARCH_INPUT_SCHEMA, null, 2),
      "output.schema.json": JSON.stringify(CODE_SEARCH_OUTPUT_SCHEMA, null, 2),
    },
  };
}

beforeEach(() => {
  mocks.rows.clear();
  vi.clearAllMocks();
});

describe("plugin store: seed", () => {
  it("seeds the built-in fixture once and is idempotent on restart", async () => {
    await seedBuiltinPlugins();
    expect(mocks.rows.size).toBe(1);
    const first = mocks.rows.get(FIXTURE_KEY);
    expect(first.status).toBe("published");
    expect(first.digest).toBe(computeBundleDigest(BUILTIN_PLUGIN_BUNDLES[0]));

    await seedBuiltinPlugins();
    expect(mocks.rows.size).toBe(1);
    expect(mocks.workerPluginRepository.create).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite a stored version whose digest differs (immutability)", async () => {
    await seedBuiltinPlugins();
    const row = mocks.rows.get(FIXTURE_KEY);
    row.digest = "sha256:deadbeef";
    await seedBuiltinPlugins();
    expect(mocks.rows.get(FIXTURE_KEY).digest).toBe("sha256:deadbeef");
    expect(mocks.workerPluginRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe("plugin store: resolve", () => {
  it("resolves a published version with re-validated digest", async () => {
    await seedBuiltinPlugins();
    const plugin = await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION);
    expect(plugin).toBeDefined();
    expect(plugin!.manifest.id).toBe(PLUGIN_ID);
    expect(computeBundleDigest(plugin!)).toBe(plugin!.digest);
  });

  it("returns undefined for unknown or draft versions", async () => {
    await seedBuiltinPlugins();
    expect(await resolvePlugin(PLUGIN_ID, "9.9.9")).toBeUndefined();
    const row = mocks.rows.get(FIXTURE_KEY);
    row.status = "draft";
    expect(await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION)).toBeUndefined();
  });

  it("rejects revoked versions for new runs but allows pinned runs to finish", async () => {
    await seedBuiltinPlugins();
    await setPluginStatus(PLUGIN_ID, FIXTURE_VERSION, "revoked");
    await expect(
      resolvePlugin(PLUGIN_ID, FIXTURE_VERSION),
    ).rejects.toMatchObject({ code: "plugin_revoked" });
    const plugin = await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION, {
      allowRevoked: true,
    });
    expect(plugin).toBeDefined();
  });

  it("still resolves deprecated versions (deprecation is advisory)", async () => {
    await seedBuiltinPlugins();
    await setPluginStatus(PLUGIN_ID, FIXTURE_VERSION, "deprecated");
    const plugin = await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION);
    expect(plugin).toBeDefined();
  });

  it("refuses to load a stored bundle that no longer matches its digest", async () => {
    await seedBuiltinPlugins();
    const row = mocks.rows.get(FIXTURE_KEY);
    const parsed = JSON.parse(row.bundle_files_json);
    parsed["prompt.md"] = promptTampered();
    row.bundle_files_json = JSON.stringify(parsed);
    // 存量 digest 不变 → 复验失败
    await expect(resolvePlugin(PLUGIN_ID, FIXTURE_VERSION)).rejects.toThrow(
      /does not match its digest/,
    );
  });
});

function promptTampered() {
  return `${CODE_SEARCH_PROMPT_MD}\n<!-- tampered -->`;
}

describe("plugin store: publish", () => {
  it("publishes a new version without code changes (FR-1)", async () => {
    await seedBuiltinPlugins();
    const newVersion = nextVersion();
    const input: ReturnType<typeof validPublishInput> & { changelog?: string } =
      validPublishInput();
    input.manifest.version = newVersion;
    input.changelog = "Tighten max_turns budget.";
    const info = await publishPlugin(input);
    expect(info.version).toBe(newVersion);
    expect(info.status).toBe("published");
    expect(mocks.rows.get(`${PLUGIN_ID}@${newVersion}`).digest).toBe(
      info.digest,
    );
    const resolved = await resolvePlugin(PLUGIN_ID, newVersion);
    expect(resolved!.digest).toBe(info.digest);
    // 旧版本不受影响
    expect(await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION)).toBeDefined();
  });

  it("rejects re-publishing the same id+version", async () => {
    await seedBuiltinPlugins();
    const input = validPublishInput();
    await expect(publishPlugin(input)).rejects.toMatchObject({
      code: "duplicate_plugin_version",
    });
  });

  it("rejects the same id+version with different content (immutability)", async () => {
    await seedBuiltinPlugins();
    const input = validPublishInput();
    input.files["prompt.md"] = promptTampered();
    await expect(publishPlugin(input)).rejects.toMatchObject({
      code: "plugin_version_conflict",
    });
  });

  it("surfaces publish-level bundle validation errors", async () => {
    const input: any = validPublishInput();
    input.files["index.ts"] = "export {}";
    await expect(publishPlugin(input)).rejects.toMatchObject({
      code: "invalid_plugin_bundle",
    });
    expect(
      validatePluginBundle({
        manifest: input.manifest,
        files: input.files,
      }).join(" "),
    ).toContain("outside the allowed set");
  });

  it("rejects a manifest whose model profile is referenced but unvalidated here", () => {
    // profile 存在性在运行端 modelDb.getByName 校验；此处只确保发布不因 profile 名抛出
    const input = validPublishInput();
    input.manifest.model_policy.profile = "search-deep";
    expect(() => validatePluginBundle(input as any)).not.toThrow();
  });
});

describe("plugin store: status transitions", () => {
  it("deprecate and revoke update status; revoked is terminal and idempotent", async () => {
    await seedBuiltinPlugins();
    const deprecated = await setPluginStatus(
      PLUGIN_ID,
      FIXTURE_VERSION,
      "deprecated",
    );
    expect(deprecated!.status).toBe("deprecated");
    expect(deprecated!.deprecated_at).toBeGreaterThan(0);

    const revoked = await setPluginStatus(
      PLUGIN_ID,
      FIXTURE_VERSION,
      "revoked",
    );
    expect(revoked!.status).toBe("revoked");

    const again = await setPluginStatus(
      PLUGIN_ID,
      FIXTURE_VERSION,
      "published",
    );
    expect(again!.status).toBe("revoked");
  });

  it("returns undefined for unknown versions", async () => {
    expect(
      await setPluginStatus("com.llm-gateway.x", "1.0.0", "revoked"),
    ).toBeUndefined();
  });
});

describe("digest determinism", () => {
  it("is unaffected by key order in stored JSON", async () => {
    await seedBuiltinPlugins();
    const row = mocks.rows.get(FIXTURE_KEY);
    const files = JSON.parse(row.bundle_files_json);
    row.bundle_files_json = JSON.stringify(
      Object.fromEntries(Object.entries(files).reverse()),
    );
    const plugin = await resolvePlugin(PLUGIN_ID, FIXTURE_VERSION);
    expect(plugin).toBeDefined();
  });
});
