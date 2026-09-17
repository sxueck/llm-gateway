import type { WorkerPluginManifest } from "@llm-gateway/shared";
import {
  computeBundleDigest,
  validatePluginBundle,
  type PluginBundle,
  type ResolvedPlugin,
} from "./registry.js";
import {
  CODE_SEARCH_INPUT_SCHEMA,
  CODE_SEARCH_MANIFEST,
  CODE_SEARCH_OUTPUT_SCHEMA,
  CODE_SEARCH_PROMPT_MD,
} from "./code-search.js";
import { workerPluginDb } from "../../db/index.js";
import type { WorkerPluginRow } from "../../db/types.js";
import { memoryLogger } from "../../services/logger.js";

export type { PluginBundle, ResolvedPlugin };

export class PluginStoreError extends Error {
  constructor(
    public readonly code:
      | "duplicate_plugin_version"
      | "plugin_version_conflict"
      | "invalid_plugin_bundle"
      | "plugin_revoked",
    message: string,
  ) {
    super(message);
  }
}

export interface PluginVersionInfo {
  id: string;
  version: string;
  digest: string;
  name: string;
  description: string | null;
  status: WorkerPluginRow["status"];
  changelog: string | null;
  published_at: number | null;
  deprecated_at: number | null;
  revoked_at: number | null;
  created_at: number;
  manifest: WorkerPluginManifest;
}

function rowToBundle(row: WorkerPluginRow): PluginBundle {
  try {
    return {
      manifest: JSON.parse(row.manifest_json) as WorkerPluginManifest,
      files: JSON.parse(row.bundle_files_json) as Record<string, string>,
    };
  } catch {
    throw new Error(
      `stored plugin ${row.id}@${row.version} data is corrupt (unparsable manifest/bundle)`,
    );
  }
}

function rowToInfo(row: WorkerPluginRow): PluginVersionInfo {
  let manifest: WorkerPluginManifest;
  try {
    manifest = JSON.parse(row.manifest_json) as WorkerPluginManifest;
  } catch {
    throw new Error(
      `stored plugin ${row.id}@${row.version} data is corrupt (unparsable manifest)`,
    );
  }
  return {
    id: row.id,
    version: row.version,
    digest: row.digest,
    name: row.name,
    description: row.description,
    status: row.status,
    changelog: row.changelog,
    published_at: row.published_at,
    deprecated_at: row.deprecated_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    manifest,
  };
}

function bundle(
  manifest: WorkerPluginManifest,
  promptMd: string,
  inputSchema: unknown,
  outputSchema: unknown,
): PluginBundle {
  return {
    manifest,
    files: {
      "prompt.md": promptMd,
      "input.schema.json": JSON.stringify(inputSchema, null, 2),
      "output.schema.json": JSON.stringify(outputSchema, null, 2),
    },
  };
}

/** 官方内置 fixture：启动时幂等 seed 到 worker_plugins 表。 */
export const BUILTIN_PLUGIN_BUNDLES: PluginBundle[] = [
  bundle(
    CODE_SEARCH_MANIFEST,
    CODE_SEARCH_PROMPT_MD,
    CODE_SEARCH_INPUT_SCHEMA,
    CODE_SEARCH_OUTPUT_SCHEMA,
  ),
];

export async function seedBuiltinPlugins(): Promise<void> {
  for (const b of BUILTIN_PLUGIN_BUNDLES) {
    const errors = validatePluginBundle(b);
    if (errors.length > 0) {
      throw new Error(
        `built-in plugin ${b.manifest.id}@${b.manifest.version} failed validation: ${errors.join("; ")}`,
      );
    }
    const digest = computeBundleDigest(b);
    const existing = await workerPluginDb.getByIdVersion(
      b.manifest.id,
      b.manifest.version,
    );
    if (!existing) {
      const now = Date.now();
      await workerPluginDb.create({
        id: b.manifest.id,
        version: b.manifest.version,
        digest,
        name: b.manifest.name,
        description: b.manifest.description ?? null,
        manifest_json: JSON.stringify(b.manifest),
        bundle_files_json: JSON.stringify(b.files),
        changelog: "内置官方插件（首次 seed）",
        status: "published",
        published_at: now,
        created_at: now,
      });
      memoryLogger.info(
        `seeded built-in plugin ${b.manifest.id}@${b.manifest.version}`,
        "PluginCenter",
      );
    } else if (existing.digest !== digest) {
      // 版本不可变：同 id+version 不同 digest 时拒绝覆盖并告警，不允许静默改写历史
      memoryLogger.error(
        `built-in plugin ${b.manifest.id}@${b.manifest.version} digest mismatch with stored version; keeping stored version`,
        "PluginCenter",
      );
    }
  }
}

export async function listPluginVersions(): Promise<PluginVersionInfo[]> {
  const rows = await workerPluginDb.listAll();
  return rows.map(rowToInfo);
}

/**
 * 解析可被 run 使用的插件版本：draft 视为不存在；revoked 默认拒绝（新 run），
 * 已入队/运行中的 run 可传 allowRevoked 以允许完成（PRD §14.2 紧急策略二选一）。
 * 每次解析都重新执行发布级校验并复验 digest（运行端防篡改）。
 */
export async function resolvePlugin(
  id: string,
  version: string,
  options: { allowRevoked?: boolean } = {},
): Promise<ResolvedPlugin | undefined> {
  if (version === "latest") {
    // Request-time reference only: run records persist the concrete version resolved here.
    const latest = await workerPluginDb.getLatestRunnableByPluginId(id);
    if (!latest) return undefined;
    version = latest.version;
  }
  const row = await workerPluginDb.getByIdVersion(id, version);
  if (!row || row.status === "draft") return undefined;
  if (row.status === "revoked" && !options.allowRevoked) {
    throw new PluginStoreError(
      "plugin_revoked",
      `plugin ${id}@${version} has been revoked and cannot start new runs`,
    );
  }
  const bundle = rowToBundle(row);
  const errors = validatePluginBundle(bundle);
  if (errors.length > 0) {
    throw new Error(
      `plugin ${id}@${version} failed runtime re-validation: ${errors.join("; ")}`,
    );
  }
  const digest = computeBundleDigest(bundle);
  if (digest !== row.digest) {
    throw new Error(
      `plugin ${id}@${version} stored bundle does not match its digest; refusing to load`,
    );
  }
  return { ...bundle, digest };
}

export async function publishPlugin(input: {
  manifest: WorkerPluginManifest;
  files: Record<string, string>;
  changelog?: string;
}): Promise<PluginVersionInfo> {
  const { manifest, files } = input;
  const bundle: PluginBundle = { manifest, files };
  const errors = validatePluginBundle(bundle);
  if (errors.length > 0) {
    throw new PluginStoreError("invalid_plugin_bundle", errors.join("; "));
  }
  const digest = computeBundleDigest(bundle);
  const existing = await workerPluginDb.getByIdVersion(
    manifest.id,
    manifest.version,
  );
  if (existing) {
    throw new PluginStoreError(
      existing.digest === digest
        ? "duplicate_plugin_version"
        : "plugin_version_conflict",
      existing.digest === digest
        ? `plugin ${manifest.id}@${manifest.version} is already published with the same digest; versions are immutable`
        : `plugin ${manifest.id}@${manifest.version} already exists with a different digest; publish a new version instead`,
    );
  }
  const now = Date.now();
  const row = await workerPluginDb.create({
    id: manifest.id,
    version: manifest.version,
    digest,
    name: manifest.name,
    description: manifest.description ?? null,
    manifest_json: JSON.stringify(manifest),
    bundle_files_json: JSON.stringify(files),
    changelog: input.changelog ?? null,
    status: "published",
    published_at: now,
    created_at: now,
  });
  memoryLogger.info(
    `published plugin ${manifest.id}@${manifest.version} (${digest.slice(0, 19)}…)`,
    "PluginCenter",
  );
  return rowToInfo(row);
}

export async function setPluginStatus(
  id: string,
  version: string,
  status: "published" | "deprecated" | "revoked",
): Promise<PluginVersionInfo | undefined> {
  const row = await workerPluginDb.getByIdVersion(id, version);
  if (!row) return undefined;
  if (row.status === "revoked") {
    // revoked 是终态，重复操作幂等返回
    return rowToInfo(row);
  }
  const updated = await workerPluginDb.setStatus(id, version, status);
  memoryLogger.warn(
    `plugin ${id}@${version} status -> ${status}`,
    "PluginCenter",
  );
  return updated ? rowToInfo(updated) : undefined;
}
