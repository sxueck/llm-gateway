import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Connection, PoolConnection } from "mysql2/promise";

export type BusinessRow = Record<string, unknown>;
export type BusinessTables = Record<string, BusinessRow[]>;

export const UPGRADE_BACKUP_FORMAT = "llm-gateway-upgrade-v2";

export const IMPORT_ORDER = [
  "users",
  "providers",
  "system_config",
  "routing_configs",
  "expert_routing_configs",
  "cost_mappings",
  "worker_plugins",
  "models",
  "virtual_keys",
  "user_plugin_enrollments",
] as const;

export type PreservedTable = (typeof IMPORT_ORDER)[number];

export const PRESERVED_TABLES: readonly PreservedTable[] = IMPORT_ORDER;

export const CLEARED_TABLES = [
  "api_requests",
  "api_request_payloads",
  "api_request_daily_summaries",
  "api_request_hourly_summaries",
  "prompt_samples",
  "expert_routing_logs",
  "expert_routing_session_bindings",
  "session_context_bindings",
  "context_switch_events",
  "expert_routing_training_records",
  "circuit_breaker_stats",
  "circuit_breaker_events",
  "backup_records",
  "restore_records",
  "repository_snapshots",
  "agent_search_runs",
  "agent_search_run_events",
  "agent_search_usage",
  "alert_reads",
] as const;

export const SCHEMA_TABLES = ["schema_migrations", "schema_baseline"] as const;

const RETIRED_TABLES = ["intent_classify_logs", "health_summaries", "health_runs", "health_targets", "blocked_ips", "expert_routing_session_bindings_legacy"] as const;

export const ALL_GATEWAY_TABLES: readonly string[] = [
  ...IMPORT_ORDER,
  ...CLEARED_TABLES,
  ...SCHEMA_TABLES,
  ...RETIRED_TABLES,
];

const ALL_GATEWAY_TABLE_SET = new Set<string>(ALL_GATEWAY_TABLES);
const PRESERVED_TABLE_SET = new Set<string>(IMPORT_ORDER);

export const TABLE_COLUMNS: Record<PreservedTable, string[]> = {
  users: ["id", "username", "password_hash", "created_at", "updated_at"],
  providers: [
    "id",
    "name",
    "description",
    "base_url",
    "protocol_mappings",
    "api_key",
    "model_mapping",
    "enabled",
    "created_at",
    "updated_at",
  ],
  system_config: ["key", "value", "description", "updated_at"],
  routing_configs: [
    "id",
    "name",
    "description",
    "type",
    "config",
    "enabled",
    "created_at",
    "updated_at",
  ],
  expert_routing_configs: [
    "id",
    "name",
    "description",
    "enabled",
    "config",
    "created_at",
    "updated_at",
  ],
  cost_mappings: [
    "id",
    "pattern",
    "target_model",
    "priority",
    "enabled",
    "created_at",
    "updated_at",
  ],
  worker_plugins: [
    "id",
    "version",
    "digest",
    "name",
    "description",
    "manifest_json",
    "bundle_files_json",
    "changelog",
    "bundle_url",
    "signature",
    "status",
    "published_at",
    "deprecated_at",
    "revoked_at",
    "created_at",
  ],
  models: [
    "id",
    "name",
    "provider_id",
    "model_identifier",
    "is_virtual",
    "routing_config_id",
    "expert_routing_id",
    "enabled",
    "model_attributes",
    "compression_config",
    "created_at",
    "updated_at",
  ],
  virtual_keys: [
    "id",
    "key_value",
    "key_hash",
    "name",
    "provider_id",
    "model_id",
    "routing_strategy",
    "model_ids",
    "routing_config",
    "enabled",
    "rate_limit",
    "cache_enabled",
    "disable_logging",
    "dynamic_compression_enabled",
    "image_compression_enabled",
    "intercept_zero_temperature",
    "zero_temperature_replacement",
    "pii_protection_enabled",
    "prompt_capture_enabled",
    "context_normalization_enabled",
    "created_at",
    "updated_at",
  ],
  user_plugin_enrollments: [
    "user_id",
    "plugin_id",
    "version",
    "enabled",
    "is_default",
    "updated_at",
  ],
};

const TABLE_UNIQUE_KEYS: Record<PreservedTable, string[][]> = {
  users: [["id"], ["username"]],
  providers: [["id"]],
  system_config: [["key"]],
  routing_configs: [["id"]],
  expert_routing_configs: [["id"]],
  cost_mappings: [["id"]],
  worker_plugins: [["id", "version"]],
  models: [["id"]],
  virtual_keys: [["id"], ["key_value"], ["key_hash"]],
  user_plugin_enrollments: [["user_id", "plugin_id"]],
};

const TABLE_PRIMARY_KEYS: Record<PreservedTable, string[]> = {
  users: ["id"],
  providers: ["id"],
  system_config: ["key"],
  routing_configs: ["id"],
  expert_routing_configs: ["id"],
  cost_mappings: ["id"],
  worker_plugins: ["id", "version"],
  models: ["id"],
  virtual_keys: ["id"],
  user_plugin_enrollments: ["user_id", "plugin_id"],
};

export const RETIRED_COLUMNS: Partial<Record<PreservedTable, string[]>> = {
  providers: ["owner_node", "owner_pop"],
  models: ["supported_protocols", "protocol", "health_check_protocol"],
};

const MAPPABLE_LEGACY_PROTOCOLS = new Set(["openai", "anthropic", "google"]);

const noop = (_message: string) => {};

export class UpgradeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UpgradeError";
    this.code = code;
  }
}

export function safeDbErrorMessage(error: unknown): string {
  const candidate = error as { code?: unknown; errno?: unknown; sqlState?: unknown } | null;
  const code =
    candidate && typeof candidate.code === "string" && candidate.code
      ? candidate.code
      : "UNKNOWN";
  const parts = [`code=${code}`];
  if (candidate && (typeof candidate.errno === "number" || typeof candidate.errno === "string")) {
    parts.push(`errno=${String(candidate.errno)}`);
  }
  if (candidate && typeof candidate.sqlState === "string" && candidate.sqlState) {
    parts.push(`sqlState=${candidate.sqlState}`);
  }
  return `MySQL 错误 (${parts.join(", ")})，SQL 与行值已隐藏`;
}

export interface UpgradeBackupMeta {
  host: string;
  port: string;
  database: string;
  exportedAt: number;
  counts: Record<string, number>;
}

export interface UpgradeBackupFile {
  format: typeof UPGRADE_BACKUP_FORMAT;
  meta: UpgradeBackupMeta;
    digest: string;
  tables: BusinessTables;
}

export interface SchemaHooks {
  createTables: (conn?: PoolConnection) => Promise<void>;
  applyMigrations: (conn: Connection) => Promise<void>;
}

export interface ParsedCliArgs {
  command: "export" | "rebuild";
  file?: string;
  confirmDatabase?: string;
  serviceStopped: boolean;
  retryRestore: boolean;
  verifyInScratchDb: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "rebuild") {
    throw new UpgradeError(
      "USAGE",
      "用法: tsx packages/backend/scripts/upgrade.ts <export|rebuild> --file <路径> [--confirm-database <库名>] [--service-stopped] [--verify-in-scratch-db] [--retry-restore]",
    );
  }
  const args: ParsedCliArgs = {
    command,
    serviceStopped: false,
    retryRestore: false,
    verifyInScratchDb: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    switch (flag) {
      case "--file":
        if (!value) throw new UpgradeError("USAGE", "--file 需要一个路径参数");
        args.file = value;
        index += 1;
        break;
      case "--confirm-database":
        if (!value) throw new UpgradeError("USAGE", "--confirm-database 需要一个库名参数");
        args.confirmDatabase = value;
        index += 1;
        break;
      case "--service-stopped":
        args.serviceStopped = true;
        break;
      case "--retry-restore":
        args.retryRestore = true;
        break;
      case "--verify-in-scratch-db":
        args.verifyInScratchDb = true;
        break;
      default:
        throw new UpgradeError("USAGE", `未知参数: ${flag}`);
    }
  }
  if (!args.file) {
    throw new UpgradeError("USAGE", "--file 为必填参数");
  }
  if (command === "rebuild") {
    if (!args.confirmDatabase) {
      throw new UpgradeError(
        "USAGE",
        "rebuild 必须提供 --confirm-database <精确库名> 以确认目标数据库",
      );
    }
    if (!args.serviceStopped) {
      throw new UpgradeError(
        "SERVICE_NOT_STOPPED",
        "rebuild 会删除并重建数据表；必须先停止所有网关副本并提供 --service-stopped 确认",
      );
    }
  }
  return args;
}

export interface ConnectionMeta {
  host: string;
  port: string;
  database: string;
}

type ProgressFn = (message: string) => void;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UpgradeError("BACKUP_FILE_INVALID", `备份文件缺少字段 ${label}`);
  }
  return value;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  throw new UpgradeError("BACKUP_FILE_INVALID", "配置包含非 JSON 值");
}

export function computeTablesDigest(tables: BusinessTables): string {
  const sorted = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [
    table,
    [...rows].sort((a, b) => {
      const keys = TABLE_PRIMARY_KEYS[table as PreservedTable] ?? [];
      return JSON.stringify(keys.map((key) => a[key])).localeCompare(JSON.stringify(keys.map((key) => b[key])));
    }),
  ]));
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(sorted)))
    .digest("hex");
}

export function isSecureFileMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export async function writeBackupFileExclusive(
  filePath: string,
  backup: UpgradeBackupFile,
): Promise<void> {
  const payload = JSON.stringify(backup, null, 2);
  const handle = await fs.open(filePath, "wx", 0o600).catch((error: unknown) => {
    throw new UpgradeError(
      "BACKUP_FILE_NOT_WRITABLE",
      `无法排他创建备份文件 ${filePath}（已存在或无权限）: ${safeDbErrorMessage(error)}`,
    );
  });
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // 尽力 fsync 父目录，保证崩溃后文件条目可见
  try {
    const dirHandle = await fs.open(dirname(filePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // 目录 fsync 在部分平台/文件系统不可用，忽略
  }
}

async function snapshotBusinessTables(
  conn: Connection,
  onProgress?: ProgressFn,
): Promise<BusinessTables> {
  const log = onProgress ?? noop;
  await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const tables: BusinessTables = {};
  try {
    for (const table of IMPORT_ORDER) {
      const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
      tables[table] = rows as BusinessRow[];
      log(`[v2升级] 读取 ${table}: ${tables[table].length} 行`);
    }
  } finally {
    await conn.query("COMMIT");
  }
  return tables;
}

function collectDeclaredProtocols(model: BusinessRow): Set<string> {
  const declared = new Set<string>();
  const single = model["protocol"];
  if (typeof single === "string" && single.trim()) {
    declared.add(single.trim());
  }
  const list = model["supported_protocols"];
  if (typeof list === "string" && list.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(list);
    } catch {
      throw new UpgradeError(
        "UNSUPPORTED_LEGACY_PROTOCOL",
        "models.supported_protocols 不是合法 JSON，无法安全裁剪该退役列",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new UpgradeError(
        "UNSUPPORTED_LEGACY_PROTOCOL",
        "models.supported_protocols 不是 JSON 数组，无法安全裁剪该退役列",
      );
    }
    for (const protocol of parsed) {
      if (typeof protocol !== "string" || !protocol.trim()) {
        throw new UpgradeError(
          "UNSUPPORTED_LEGACY_PROTOCOL",
          "models.supported_protocols 含非字符串协议项，无法安全裁剪该退役列",
        );
      }
      declared.add(protocol.trim());
    }
  }
  return declared;
}

function applyProtocolSupplierMapping(tables: BusinessTables): void {
  const providers = tables["providers"] ?? [];
  const models = tables["models"] ?? [];
  const providersById = new Map<string, BusinessRow>(
    providers.map((provider) => [String(provider["id"]), provider]),
  );
  for (const model of models) {
    const providerId = model["provider_id"];
    if (typeof providerId !== "string" || !providerId) continue;
    if (model["is_virtual"] === 1 || model["is_virtual"] === true) continue;
    const declared = collectDeclaredProtocols(model);
    if (declared.size === 0) continue;
    for (const protocol of declared) {
      if (!MAPPABLE_LEGACY_PROTOCOLS.has(protocol)) {
        throw new UpgradeError(
          "UNSUPPORTED_LEGACY_PROTOCOL",
          `models 声明了无法映射的旧协议（值已隐藏，合法集合 openai/anthropic/google）；请先在旧库处理后再导出`,
        );
      }
    }
    const provider = providersById.get(providerId);
    if (!provider) continue; // 引用完整性校验会单独报告
    const rawMappings = provider["protocol_mappings"];
    let mappings: Record<string, unknown> = {};
    if (typeof rawMappings === "string" && rawMappings.trim()) {
      try {
        const parsed: unknown = JSON.parse(rawMappings);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          mappings = parsed as Record<string, unknown>;
        }
      } catch {
        // 非法 JSON 时重建映射，仅保留本次回填内容（与迁移 v56 行为一致）
      }
    }
    let changed = false;
    for (const protocol of declared) {
      if (protocol === "openai") continue; // openai 始终走 base_url 缺省行为
      const existing = mappings[protocol];
      if (typeof existing === "string" && existing.trim()) continue;
      mappings[protocol] = typeof provider["base_url"] === "string" ? provider["base_url"] : "";
      changed = true;
    }
    if (changed) {
      provider["protocol_mappings"] = JSON.stringify(mappings);
    }
  }
}

export function normalizeBusinessTables(raw: BusinessTables): BusinessTables {
  for (const table of IMPORT_ORDER) {
    const rows = Array.isArray(raw[table]) ? (raw[table] as BusinessRow[]) : [];
    const allowed = new Set<string>([
      ...TABLE_COLUMNS[table],
      ...(RETIRED_COLUMNS[table] ?? []),
    ]);
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new UpgradeError("BACKUP_FILE_INVALID", `表 ${table} 含非对象行`);
      }
      const unknown = Object.keys(row).filter((key) => !allowed.has(key));
      if (unknown.length > 0) {
        throw new UpgradeError(
          "UNKNOWN_COLUMN",
          `表 ${table} 存在无法识别的列: ${unknown.join(", ")}；为避免静默丢数据已中止（仅允许裁剪已知退役列）`,
        );
      }
      const missing = TABLE_COLUMNS[table].filter((column) => !(column in row));
      if (missing.length > 0) {
        throw new UpgradeError(
          "SCHEMA_TOO_OLD",
          `数据库表 ${table} 缺少 v2 必需列: ${missing.join(", ")}；请先用旧版本网关补齐后再导出`,
        );
      }
    }
  }

  applyProtocolSupplierMapping(raw);

  const tables: BusinessTables = {};
  for (const table of IMPORT_ORDER) {
    const rows = Array.isArray(raw[table]) ? (raw[table] as BusinessRow[]) : [];
    tables[table] = rows.map((row) => {
      // 已知退役列（providers.owner_node/owner_pop、
      // models.supported_protocols/protocol/health_check_protocol）在投影时被丢弃
      const projected: BusinessRow = {};
      for (const column of TABLE_COLUMNS[table]) {
        projected[column] = row[column] ?? null;
      }
      return projected;
    });
  }
  return tables;
}

function parseJsonObjectConfig(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fallthrough 到统一报错
    }
  }
  throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}: config 不是合法 JSON 对象`);
}

const EXPERT_TYPES = new Set(["virtual", "real"]);
const ROUTING_BANDS = new Set(["low", "medium", "high"]);
const SESSION_POLICY_MODES = new Set(["per_turn", "sticky", "escalate_only"]);
const FAIL_OPEN_MODES = new Set(["fallback", "parent", "error"]);

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}: 缺少必需字符串字段`);
  }
  return value;
}

function validateExpertTarget(target: unknown, context: string, requireBand = true): void {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}: 候选必须是对象`);
  }
  const expert = target as Record<string, unknown>;
  const type = requireNonEmptyString(expert["type"], `${context}.type`);
  if (!EXPERT_TYPES.has(type)) {
    throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}.type 不合法`);
  }
  const band = expert["band"];
  if (requireBand && (typeof band !== "string" || !ROUTING_BANDS.has(band))) {
    throw new UpgradeError(
      "INCOMPATIBLE_EXPERT_CONFIG",
      `${context}: 缺少 band (low/medium/high) —— 疑似 v1 旧配置，删库前中止`,
    );
  }
  if (type === "virtual") {
    requireNonEmptyString(expert["model_id"], `${context}.model_id`);
  } else {
    requireNonEmptyString(expert["provider_id"], `${context}.provider_id`);
    requireNonEmptyString(expert["model"], `${context}.model`);
  }
}

export function validateExpertRoutingConfigV2(configText: unknown, configId: string): void {
  const context = `expert_routing_configs[${configId}]`;
  const config = parseJsonObjectConfig(configText, context);
  if (config["version"] !== 2) {
    throw new UpgradeError(
      "INCOMPATIBLE_EXPERT_CONFIG",
      `${context}: version=${String(config["version"])} 不是 2 —— 不支持的旧配置已在删库前中止，请先在旧版本中升级该配置`,
    );
  }
  const failOpen = config["fail_open"];
  if (failOpen !== undefined && failOpen !== null && !FAIL_OPEN_MODES.has(String(failOpen))) {
    throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}.fail_open 不合法`);
  }
  const experts = config["experts"];
  if (!Array.isArray(experts)) {
    throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}: experts 必须是数组`);
  }
  const seenExpertIds = new Set<string>();
  experts.forEach((expert, index) => {
    const expertContext = `${context}.experts[${index}]`;
    const id = requireNonEmptyString(
      (expert as Record<string, unknown>)?.["id"],
      `${expertContext}.id`,
    );
    if (seenExpertIds.has(id)) {
      throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${expertContext}: 重复候选 id`);
    }
    seenExpertIds.add(id);
    validateExpertTarget(expert, expertContext);
  });
  const fallback = config["fallback"];
  if (fallback !== undefined && fallback !== null) {
    validateExpertTarget(fallback, `${context}.fallback`, false);
  }
  const sessionPolicy = config["session_policy"];
  if (sessionPolicy !== undefined && sessionPolicy !== null) {
    if (typeof sessionPolicy !== "object" || Array.isArray(sessionPolicy)) {
      throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}.session_policy 必须是对象`);
    }
    const policy = sessionPolicy as Record<string, unknown>;
    const mode = policy["mode"];
    if (mode !== undefined && !SESSION_POLICY_MODES.has(String(mode))) {
      throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}.session_policy.mode 不合法`);
    }
    for (const field of ["idle_ttl_seconds", "absolute_ttl_seconds"]) {
      const ttl = policy[field];
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0)) {
        throw new UpgradeError(
          "INCOMPATIBLE_EXPERT_CONFIG",
          `${context}.session_policy.${field} 必须是正整数`,
        );
      }
    }
  }
  for (const field of ["classifier", "exposure", "preprocessing"]) {
    const value = config[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", `${context}.${field} 必须是对象`);
      }
    }
  }
}

interface ParsedExpertConfigs {
  configs: Record<string, Record<string, unknown>>;
}

function collectExpertConfigs(tables: BusinessTables): ParsedExpertConfigs {
  const configs: Record<string, Record<string, unknown>> = {};
  for (const row of tables["expert_routing_configs"] ?? []) {
    const id = typeof row["id"] === "string" ? row["id"] : "<unknown>";
    configs[id] = parseJsonObjectConfig(row["config"], `expert_routing_configs[${id}]`);
  }
  return { configs };
}

function checkDuplicateKeys(tables: BusinessTables): void {
  for (const table of IMPORT_ORDER) {
    const rows = tables[table] ?? [];
    for (const columns of TABLE_UNIQUE_KEYS[table]) {
      const seen = new Set<string>();
      for (const row of rows) {
        const values = columns.map((column) => {
          const value = row[column];
          return value === undefined ? null : value;
        });
        if (values.every((value) => value === null)) continue;
        const key = JSON.stringify(values);
        if (seen.has(key)) {
          throw new UpgradeError(
            "DUPLICATE_KEY",
            `表 ${table} 存在重复键 (${columns.join(", ")})；键值已隐藏，请修正备份后重试`,
          );
        }
        seen.add(key);
      }
    }
  }
}

function checkReferences(tables: BusinessTables, expertConfigs: ParsedExpertConfigs): void {
  const providerIds = new Set(
    (tables["providers"] ?? []).map((row) => String(row["id"])).filter((id) => id !== ""),
  );
  const modelIds = new Set(
    (tables["models"] ?? []).map((row) => String(row["id"])).filter((id) => id !== ""),
  );
  const routingConfigIds = new Set(
    (tables["routing_configs"] ?? []).map((row) => String(row["id"])).filter((id) => id !== ""),
  );
  const expertRoutingIds = new Set(Object.keys(expertConfigs.configs));
  const pluginVersions = new Set(
    (tables["worker_plugins"] ?? []).map((row) => `${String(row["id"])}\0${String(row["version"])}`),
  );

  const broken: string[] = [];
  const refs: Array<[string, string, string | undefined, Set<string>]> = [
    ["models", "provider_id", undefined, providerIds],
    ["models", "routing_config_id", undefined, routingConfigIds],
    ["models", "expert_routing_id", undefined, expertRoutingIds],
    ["virtual_keys", "provider_id", undefined, providerIds],
    ["virtual_keys", "model_id", undefined, modelIds],
  ];
  for (const [table, column, , targets] of refs) {
    const count = (tables[table] ?? []).filter((row) => {
      const value = row[column];
      return typeof value === "string" && value !== "" && !targets.has(value);
    }).length;
    if (count > 0) broken.push(`${table}.${column}=${count}`);
  }

  const danglingPlugins = (tables["user_plugin_enrollments"] ?? []).filter((row) => {
    const key = `${String(row["plugin_id"])}\0${String(row["version"])}`;
    return row["plugin_id"] !== null && row["plugin_id"] !== undefined && !pluginVersions.has(key);
  }).length;
  if (danglingPlugins > 0) broken.push(`user_plugin_enrollments.plugin_id/version=${danglingPlugins}`);
  const userIds = new Set((tables.users ?? []).map((row) => row.id));
  if ((tables.user_plugin_enrollments ?? []).some((row) => !userIds.has(row.user_id))) {
    broken.push("user_plugin_enrollments.user_id");
  }
  for (const row of tables.virtual_keys ?? []) {
    if (row.model_ids === null || row.model_ids === undefined || row.model_ids === "") continue;
    let ids: unknown;
    try { ids = typeof row.model_ids === "string" ? JSON.parse(row.model_ids) : row.model_ids; }
    catch { throw new UpgradeError("BROKEN_REFERENCE", "virtual_keys.model_ids 不是合法 JSON"); }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !modelIds.has(id))) {
      broken.push("virtual_keys.model_ids");
    }
  }

  let danglingExpertRefs = 0;
  for (const config of Object.values(expertConfigs.configs)) {
    const targets: unknown[] = Array.isArray(config["experts"]) ? [...config["experts"]] : [];
    if (config["fallback"] !== undefined && config["fallback"] !== null) {
      targets.push(config["fallback"]);
    }
    for (const target of targets) {
      if (!target || typeof target !== "object") continue;
      const expert = target as Record<string, unknown>;
      if (expert["type"] === "virtual") {
        const modelId = expert["model_id"];
        if (typeof modelId === "string" && !modelIds.has(modelId)) danglingExpertRefs += 1;
      } else if (expert["type"] === "real") {
        const providerId = expert["provider_id"];
        if (typeof providerId === "string" && !providerIds.has(providerId)) danglingExpertRefs += 1;
      }
    }
  }
  if (danglingExpertRefs > 0) broken.push(`expert_routing_configs.*->models/providers=${danglingExpertRefs}`);

  if (broken.length > 0) {
    throw new UpgradeError(
      "BROKEN_REFERENCE",
      `业务配置存在悬空引用: ${broken.join(", ")}；具体键值已隐藏，请先修复引用再重建`,
    );
  }
}

export function validateBusinessConfig(tables: BusinessTables): void {
  for (const table of IMPORT_ORDER) {
    if (!Array.isArray(tables[table])) {
      throw new UpgradeError("BACKUP_FILE_INVALID", `备份缺少表 ${table}`);
    }
  }
  for (const row of tables["expert_routing_configs"] ?? []) {
    const id = typeof row["id"] === "string" ? row["id"] : "<unknown>";
    validateExpertRoutingConfigV2(row["config"], id);
  }
  const expertConfigs = collectExpertConfigs(tables);
  for (const row of tables.expert_routing_configs) {
    const experts = expertConfigs.configs[String(row.id)].experts as unknown[];
    if (Number(row.enabled) === 1 && experts.length === 0) {
      throw new UpgradeError("INCOMPATIBLE_EXPERT_CONFIG", "启用的专家路由不能是空草稿");
    }
  }
  checkDuplicateKeys(tables);
  checkReferences(tables, expertConfigs);
}

export async function exportBusinessConfig(
  conn: Connection,
  options: { filePath: string; meta: ConnectionMeta; onProgress?: ProgressFn },
): Promise<UpgradeBackupFile> {
  const raw = await snapshotBusinessTables(conn, options.onProgress);
  const tables = normalizeBusinessTables(raw);
  validateBusinessConfig(tables);
  const counts: Record<string, number> = {};
  for (const table of IMPORT_ORDER) {
    counts[table] = tables[table].length;
  }
  const backup: UpgradeBackupFile = {
    format: UPGRADE_BACKUP_FORMAT,
    meta: { ...options.meta, exportedAt: Date.now(), counts },
    digest: computeTablesDigest(tables),
    tables,
  };
  await writeBackupFileExclusive(options.filePath, backup);
  return backup;
}

export async function loadBackupFile(filePath: string): Promise<UpgradeBackupFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw new UpgradeError("BACKUP_FILE_UNREADABLE", `无法读取备份文件 ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UpgradeError("BACKUP_FILE_INVALID_JSON", `备份文件不是合法 JSON: ${filePath}`);
  }
  const candidate = parsed as Partial<UpgradeBackupFile> | null;
  if (!candidate || candidate.format !== UPGRADE_BACKUP_FORMAT) {
    throw new UpgradeError("BACKUP_FORMAT_UNKNOWN", "备份文件格式标识不正确（期望 llm-gateway-upgrade-v2）");
  }
  const meta = candidate.meta;
  if (!meta || typeof meta !== "object") {
    throw new UpgradeError("BACKUP_FILE_INVALID", "备份文件缺少 meta");
  }
  requireString(meta.host, "meta.host");
  requireString(meta.port, "meta.port");
  requireString(meta.database, "meta.database");
  if (typeof meta.exportedAt !== "number") {
    throw new UpgradeError("BACKUP_FILE_INVALID", "备份文件缺少 meta.exportedAt");
  }
  const digest = requireString(candidate.digest, "digest");
  const tables = candidate.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new UpgradeError("BACKUP_FILE_INVALID", "备份文件缺少 tables");
  }
  for (const table of Object.keys(tables)) {
    if (!PRESERVED_TABLE_SET.has(table)) {
      throw new UpgradeError(
        "BACKUP_UNKNOWN_TABLE",
        `备份包含未知表 ${table}；仅接受业务配置表，请用当前工具重新 export`,
      );
    }
    const rows = tables[table];
    if (!Array.isArray(rows)) {
      throw new UpgradeError("BACKUP_FILE_INVALID", `备份表 ${table} 不是数组`);
    }
    const retired = new Set(RETIRED_COLUMNS[table as PreservedTable] ?? []);
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new UpgradeError("BACKUP_FILE_INVALID", `备份表 ${table} 含非对象行`);
      }
      const unknown = Object.keys(row).filter((key) => !TABLE_COLUMNS[table as PreservedTable].includes(key));
      if (unknown.length > 0) {
        if (unknown.every((key) => retired.has(key))) {
          throw new UpgradeError(
            "BACKUP_NOT_CANONICAL",
            `备份表 ${table} 仍含退役列 ${unknown.join(", ")}；请用当前工具重新 export`,
          );
        }
        throw new UpgradeError(
          "UNKNOWN_COLUMN",
          `备份表 ${table} 含无法识别的列: ${unknown.join(", ")}`,
        );
      }
      for (const pk of TABLE_PRIMARY_KEYS[table as PreservedTable]) {
        const value = row[pk];
        if (value === null || value === undefined || value === "") {
          throw new UpgradeError("BACKUP_INVALID_ROW", `备份表 ${table} 存在主键 (${pk}) 为空的行`);
        }
      }
    }
  }
  const recomputed = computeTablesDigest(tables as BusinessTables);
  if (recomputed !== digest) {
    throw new UpgradeError("BACKUP_DIGEST_MISMATCH", "备份文件 digest 校验失败（文件损坏或被篡改）");
  }
  for (const [table, count] of Object.entries(meta.counts ?? {})) {
    const actual = Array.isArray(tables[table]) ? (tables[table] as unknown[]).length : 0;
    if (actual !== count) {
      throw new UpgradeError(
        "BACKUP_COUNT_MISMATCH",
        `备份表 ${table} 行数 (${actual}) 与 meta.counts (${String(count)}) 不一致`,
      );
    }
  }
  validateBusinessConfig(tables as BusinessTables);
  return {
    format: UPGRADE_BACKUP_FORMAT,
    meta,
    digest,
    tables: tables as BusinessTables,
  };
}

export async function preflightRebuild(
  conn: Connection,
  options: {
    backup: UpgradeBackupFile;
    expected: ConnectionMeta;
    confirmDatabase: string;
    retryRestore?: boolean;
    onProgress?: ProgressFn;
  },
): Promise<void> {
  const log = options.onProgress ?? noop;
  const { backup, expected } = options;
  if (options.confirmDatabase !== expected.database) {
    throw new UpgradeError(
      "CONFIRM_DATABASE_MISMATCH",
      `--confirm-database 与当前 MYSQL_DATABASE 不一致（期望 ${expected.database}）`,
    );
  }
  if (backup.meta.host !== expected.host) {
    throw new UpgradeError("META_MISMATCH", "备份 meta.host 与当前 MYSQL_HOST 不一致（要求精确匹配）");
  }
  if (backup.meta.port !== expected.port) {
    throw new UpgradeError("META_MISMATCH", "备份 meta.port 与当前 MYSQL_PORT 不一致（要求精确匹配）");
  }
  if (backup.meta.database !== expected.database) {
    throw new UpgradeError("META_MISMATCH", "备份 meta.database 与当前 MYSQL_DATABASE 不一致（要求精确匹配）");
  }
  const [rows] = await conn.query("SELECT DATABASE() AS db");
  const live = (rows as BusinessRow[])[0]?.["db"];
  if (live !== expected.database) {
    throw new UpgradeError(
      "LIVE_DATABASE_MISMATCH",
      `连接实际指向数据库 ${String(live)}，与期望 ${expected.database} 不一致`,
    );
  }

  const [objects] = await conn.query(
    "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  for (const object of objects as BusinessRow[]) {
    const name = String(object["name"]);
    if (ALL_GATEWAY_TABLE_SET.has(name) && object["type"] === "BASE TABLE") continue;
    if (object["type"] === "VIEW") {
      throw new UpgradeError(
        "UNKNOWN_LIVE_VIEW",
        `数据库存在未知视图 ${name}；请先自行处理（删除或迁移）后重试`,
      );
    }
    throw new UpgradeError(
      "UNKNOWN_LIVE_TABLE",
      `数据库存在未知表 ${name}；重建只删除已知网关表，为避免遗漏业务数据请先自行完整备份/迁移该表后重试`,
    );
  }

  if (options.retryRestore) {
    const [baseline] = await conn.query("SELECT generation FROM schema_baseline WHERE id = 1");
    if (Number((baseline as BusinessRow[])[0]?.generation) !== 2) {
      throw new UpgradeError("RETRY_SCHEMA_MISSING", "重试导入要求 v2 基线已就绪");
    }
    await assertPreservedTablesEmpty(conn);
    return;
  }
  const [externalReferences] = await conn.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND TABLE_SCHEMA <> DATABASE()",
  );
  const [triggers] = await conn.query(
    "SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()",
  );
  if ((externalReferences as unknown[]).length > 0 || (triggers as unknown[]).length > 0) {
    throw new UpgradeError("UNSUPPORTED_DATABASE_DEPENDENCIES", "数据库存在跨库外键或触发器，不能安全重建；请先完整备份并处理依赖");
  }
  const raw = await snapshotBusinessTables(conn);
  const liveTables = normalizeBusinessTables(raw);
  validateBusinessConfig(liveTables);
  const liveDigest = computeTablesDigest(liveTables);
  if (liveDigest !== backup.digest) {
    throw new UpgradeError(
      "STALE_BACKUP",
      "导出后业务配置已发生变化（digest 不一致）；请重新执行 export 后再 rebuild",
    );
  }
  log("[v2升级] 前置校验通过（元数据/未知对象/陈旧备份检查）");
}

async function assertPreservedTablesEmpty(conn: Connection): Promise<void> {
  for (const table of PRESERVED_TABLES) {
    try {
      const [rows] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${table}\``);
      const count = Number((rows as BusinessRow[])[0]?.["cnt"] ?? 0);
      if (count > 0) {
        throw new UpgradeError(
          "RETRY_NOT_EMPTY",
          `表 ${table} 非空；--retry-restore 仅用于重建后导入失败的空库重试`,
        );
      }
    } catch (error) {
      if (error instanceof UpgradeError) throw error;
      throw new UpgradeError(
        "RETRY_SCHEMA_MISSING",
        `无法确认表 ${table} 状态: ${safeDbErrorMessage(error)}；--retry-restore 要求 v2 表结构已就绪`,
      );
    }
  }
}

async function importBusinessConfig(
  conn: Connection,
  tables: BusinessTables,
  onProgress?: ProgressFn,
): Promise<void> {
  const log = onProgress ?? noop;
  await conn.beginTransaction();
  try {
    for (const table of IMPORT_ORDER) {
      const rows = tables[table] ?? [];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!columns.includes(key)) {
            throw new UpgradeError(
              "BACKUP_INCONSISTENT_ROWS",
              `表 ${table} 各行的列集合不一致`,
            );
          }
        }
      }
      const columnSql = columns.map((column) => `\`${column}\``).join(", ");
      const BATCH_SIZE = 100;
      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        const values = batch.map((row) => columns.map((column) => row[column] ?? null));
        await conn.query(`INSERT INTO \`${table}\` (${columnSql}) VALUES ?`, [values]);
      }
      log(`[v2升级] 已导入 ${table}: ${rows.length} 行`);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error instanceof UpgradeError) throw error;
    throw new UpgradeError(
      "IMPORT_FAILED",
      `导入业务配置失败（事务已回滚）: ${safeDbErrorMessage(error)}`,
    );
  }
}

export async function rebuildDatabase(
  conn: Connection,
  backup: UpgradeBackupFile,
  options: { retryRestore?: boolean; hooks: SchemaHooks; onProgress?: ProgressFn },
): Promise<void> {
  const log = options.onProgress ?? noop;
  if (options.retryRestore) {
    log("[v2升级] 重试导入模式：校验业务表为空");
    await assertPreservedTablesEmpty(conn);
    await importBusinessConfig(conn, backup.tables, options.onProgress);
    return;
  }
  log("[v2升级] 删除已知网关表（不会执行 DROP DATABASE）");
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of ALL_GATEWAY_TABLES) {
      await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }
  log("[v2升级] 重建 v2 表结构（createTables + applyMigrations，基线版本 0）");
  try {
    await options.hooks.applyMigrations(conn);
    await options.hooks.createTables(conn as PoolConnection);
  } catch (error) {
    throw new UpgradeError(
      "SCHEMA_REBUILD_FAILED",
      `重建表结构失败: ${safeDbErrorMessage(error)}；可重试 rebuild，或使用全量 mysqldump 恢复`,
    );
  }
  await importBusinessConfig(conn, backup.tables, options.onProgress);
}

export async function verifyRestoreInScratchDatabase(
  conn: Connection,
  backup: UpgradeBackupFile,
  options: { hooks: SchemaHooks; database: string; onProgress?: ProgressFn },
): Promise<void> {
  const log = options.onProgress ?? noop;
  const suffix = randomBytes(4).toString("hex");
  const base = options.database.slice(0, Math.max(1, 63 - `_verify_${suffix}`.length));
  const scratch = `${base}_verify_${suffix}`;
  const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``;
  try {
    await conn.query(
      `CREATE DATABASE ${quote(scratch)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } catch (error) {
    throw new UpgradeError(
      "SCRATCH_CREATE_DENIED",
      `无法创建临时校验数据库（需要 CREATE 权限）: ${safeDbErrorMessage(error)}；目标数据库未改动`,
    );
  }
  try {
    log(`[v2升级] 干跑校验中（临时库 ${scratch}）`);
    await conn.query(`USE ${quote(scratch)}`);
    await options.hooks.applyMigrations(conn);
    await options.hooks.createTables(conn as PoolConnection);
    await importBusinessConfig(conn, backup.tables, options.onProgress);
    log("[v2升级] 干跑校验通过");
  } catch (error) {
    if (error instanceof UpgradeError) throw error;
    throw new UpgradeError(
      "DRY_RUN_FAILED",
      `临时库干跑恢复失败: ${safeDbErrorMessage(error)}；未触碰真实数据库`,
    );
  } finally {
    // Failure to switch back must abort: subsequent DROP TABLE targets the selected database.
    await conn.query(`USE ${quote(options.database)}`);
    try {
      await conn.query(`DROP DATABASE IF EXISTS ${quote(scratch)}`);
    } catch {
      throw new UpgradeError("SCRATCH_CLEANUP_FAILED", `临时库 ${scratch} 清理失败，含敏感配置，请手动处理；目标数据库未改动`);
    }
  }
}
