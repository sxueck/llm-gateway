import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ALL_GATEWAY_TABLES,
  IMPORT_ORDER,
  UPGRADE_BACKUP_FORMAT,
  computeTablesDigest,
  exportBusinessConfig,
  isSecureFileMode,
  loadBackupFile,
  normalizeBusinessTables,
  parseCliArgs,
  preflightRebuild,
  rebuildDatabase,
  safeDbErrorMessage,
  validateBusinessConfig,
  verifyRestoreInScratchDatabase,
  writeBackupFileExclusive,
} from "./upgrade.js";
import type {
  BusinessRow,
  BusinessTables,
  SchemaHooks,
  UpgradeBackupFile,
} from "./upgrade.js";

function validBusinessTables(): BusinessTables {
  const tables: BusinessTables = {};
  for (const table of IMPORT_ORDER) {
    tables[table] = [];
  }
  tables["users"] = [
    { id: "u1", username: "admin", password_hash: "hash", created_at: 1, updated_at: 1 },
  ];
  tables["providers"] = [
    {
      id: "p1",
      name: "P",
      description: null,
      base_url: "https://api.example.com",
      protocol_mappings: null,
      api_key: "sk-secret",
      model_mapping: null,
      enabled: 1,
      created_at: 1,
      updated_at: 1,
    },
  ];
  tables["models"] = [
    {
      id: "m1",
      name: "M",
      provider_id: "p1",
      model_identifier: "gpt-x",
      is_virtual: 0,
      routing_config_id: null,
      expert_routing_id: null,
      enabled: 1,
      model_attributes: null,
      compression_config: null,
      created_at: 1,
      updated_at: 1,
    },
  ];
  tables["virtual_keys"] = [
    {
      id: "vk1",
      key_value: "vk-plain",
      key_hash: "hash",
      name: "k",
      provider_id: "p1",
      model_id: "m1",
      routing_strategy: "single",
      model_ids: null,
      routing_config: null,
      enabled: 1,
      rate_limit: null,
      cache_enabled: 0,
      disable_logging: 0,
      dynamic_compression_enabled: 0,
      image_compression_enabled: 0,
      intercept_zero_temperature: 0,
      zero_temperature_replacement: null,
      pii_protection_enabled: 0,
      prompt_capture_enabled: 0,
      context_normalization_enabled: 0,
      created_at: 1,
      updated_at: 1,
    },
  ];
  tables["worker_plugins"] = [
    {
      id: "w1",
      version: "1.0.0",
      digest: "d",
      name: "W",
      description: null,
      manifest_json: "{}",
      bundle_files_json: "[]",
      changelog: null,
      bundle_url: null,
      signature: null,
      status: "published",
      published_at: 1,
      deprecated_at: null,
      revoked_at: null,
      created_at: 1,
    },
  ];
  tables["user_plugin_enrollments"] = [
    { user_id: "u1", plugin_id: "w1", version: "1.0.0", enabled: 1, is_default: 0, updated_at: 1 },
  ];
  tables["expert_routing_configs"] = [
    {
      id: "e1",
      name: "E",
      description: null,
      enabled: 1,
      config: JSON.stringify({
        version: 2,
        experts: [
          { id: "x1", type: "real", provider_id: "p1", model: "gpt-x", band: "high" },
        ],
        session_policy: {
          mode: "escalate_only",
          idle_ttl_seconds: 86400,
          absolute_ttl_seconds: 2592000,
        },
      }),
      created_at: 1,
      updated_at: 1,
    },
  ];
  return tables;
}

function makeBackup(tables: BusinessTables, metaOverrides: Record<string, unknown> = {}): UpgradeBackupFile {
  const counts: Record<string, number> = {};
  for (const table of IMPORT_ORDER) {
    counts[table] = tables[table].length;
  }
  return {
    format: UPGRADE_BACKUP_FORMAT,
    meta: {
      host: "localhost",
      port: "3306",
      database: "llm_gateway",
      exportedAt: 1,
      counts,
      ...metaOverrides,
    },
    digest: computeTablesDigest(tables),
    tables,
  };
}

type QueryHandler = (sql: string, params?: unknown) => unknown;

function mockConnection(handler: QueryHandler): { conn: Connection; queries: string[] } {
  const queries: string[] = [];
  const conn = {
    query: vi.fn(async (sql: string, params?: unknown) => {
      queries.push(sql);
      return handler(sql, params);
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  } as unknown as Connection;
  return { conn, queries };
}

function snapshotHandler(tables: BusinessTables, extra: Record<string, unknown> = {}): QueryHandler {
  return (sql) => {
    for (const [needle, result] of Object.entries(extra)) {
      if (sql.includes(needle)) return result as unknown;
    }
    for (const table of Object.keys(tables)) {
      if (sql === `SELECT * FROM \`${table}\``) {
        return [tables[table]];
      }
    }
    if (sql.includes("SELECT COUNT(*)")) return [[{ cnt: 0 }]];
    if (sql.includes("SELECT DATABASE()")) return [[{ db: "llm_gateway" }]];
    if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
      const objects = ALL_GATEWAY_TABLES.map((name) => ({ name, type: "BASE TABLE" }));
      return [objects];
    }
    return [[]];
  };
}

const mockHooks = (): SchemaHooks => ({
  createTables: vi.fn(),
  applyMigrations: vi.fn(),
});

describe("CLI 参数守卫", () => {
  test("export 必须提供 --file", () => {
    expect(() => parseCliArgs(["export"])).toThrowError(/--file/);
  });

  test("rebuild 必须提供 --confirm-database", () => {
    expect(() => parseCliArgs(["rebuild", "--file", "/tmp/b.json", "--service-stopped"])).toThrowError(
      /--confirm-database/,
    );
  });

  test("rebuild 缺少 --service-stopped 时拒绝（防止副本写入）", () => {
    expect(() =>
      parseCliArgs(["rebuild", "--file", "/tmp/b.json", "--confirm-database", "llm_gateway"]),
    ).toThrowError(/service-stopped/);
  });

  test("未知参数报错；合法参数解析正确", () => {
    expect(() => parseCliArgs(["export", "--file", "/tmp/b.json", "--wat"])).toThrowError(/未知参数/);
    const parsed = parseCliArgs([
      "rebuild",
      "--file",
      "/tmp/b.json",
      "--confirm-database",
      "llm_gateway",
      "--service-stopped",
      "--retry-restore",
      "--verify-in-scratch-db",
    ]);
    expect(parsed).toMatchObject({
      command: "rebuild",
      serviceStopped: true,
      retryRestore: true,
      verifyInScratchDb: true,
    });
  });
});

describe("export 阶段", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "gateway-upgrade-test-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("一致性快照读取 + 0600 独占 fsync 写 + 可回读校验", async () => {
    const tables = validBusinessTables();
    const { conn, queries } = mockConnection(snapshotHandler(tables));
    const filePath = join(workDir, "backup.json");

    const backup = await exportBusinessConfig(conn, {
      filePath,
      meta: { host: "localhost", port: "3306", database: "llm_gateway" },
    });

    const snapshotIndex = queries.indexOf("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const isolationIndex = queries.indexOf("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(isolationIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(isolationIndex);
    expect(queries.indexOf("COMMIT")).toBeGreaterThan(snapshotIndex);

    const stat = await fs.stat(filePath);
    expect(isSecureFileMode(stat.mode)).toBe(true);
    expect(backup.meta.counts["providers"]).toBe(1);

    const loaded = await loadBackupFile(filePath);
    expect(loaded.digest).toBe(backup.digest);

    // 独占写：文件已存在时拒绝覆盖
    await expect(
      writeBackupFileExclusive(filePath, backup),
    ).rejects.toThrowError(/排他创建备份文件/);
  });

  test("裁剪已知退役列，并把模型级 anthropic 协议回填到供应商映射", () => {
    const tables = validBusinessTables();
    tables["providers"]![0]!["owner_node"] = "node-a";
    tables["providers"]![0]!["owner_pop"] = "pop-a";
    tables["models"]![0]!["supported_protocols"] = JSON.stringify(["openai", "anthropic"]);
    tables["models"]![0]!["protocol"] = "anthropic";
    tables["models"]![0]!["health_check_protocol"] = "openai";

    const normalized = normalizeBusinessTables(tables);
    expect(normalized["providers"]![0]).not.toHaveProperty("owner_node");
    expect(normalized["providers"]![0]).not.toHaveProperty("owner_pop");
    expect(normalized["models"]![0]).not.toHaveProperty("supported_protocols");
    expect(normalized["models"]![0]).not.toHaveProperty("protocol");
    expect(normalized["models"]![0]).not.toHaveProperty("health_check_protocol");
    const mappings = JSON.parse(String(normalized["providers"]![0]!["protocol_mappings"]));
    expect(mappings).toEqual({ anthropic: "https://api.example.com" });
  });

  test("未知旧协议在导出（删库）前即失败", () => {
    const tables = validBusinessTables();
    tables["models"]![0]!["supported_protocols"] = JSON.stringify(["openai", "weird-protocol"]);
    expect(() => normalizeBusinessTables(tables)).toThrowError(/无法映射的旧协议/);
  });

  test("未知列拒绝，缺失 v2 列按旧库报错", () => {
    const tables = validBusinessTables();
    (tables["providers"]![0] as BusinessRow)["mystery_col"] = "x";
    expect(() => normalizeBusinessTables(tables)).toThrowError(/无法识别的列: mystery_col/);

    const old = validBusinessTables();
    old["virtual_keys"] = [{ id: "vk1", name: "k" } as BusinessRow];
    expect(() => normalizeBusinessTables(old)).toThrowError(/缺少 v2 必需列/);
  });
});

describe("备份文件校验（fail-before-drop）", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "gateway-upgrade-test-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function writeBackup(backup: UpgradeBackupFile): Promise<string> {
    const filePath = join(workDir, `b-${Math.random().toString(36).slice(2)}.json`);
    const handle = await fs.open(filePath, "w", 0o600);
    await handle.writeFile(JSON.stringify(backup), "utf8");
    await handle.close();
    return filePath;
  }

  test("digest 被篡改时拒绝加载", async () => {
    const backup = makeBackup(validBusinessTables());
    backup.digest = "0".repeat(64);
    const filePath = await writeBackup(backup);
    await expect(loadBackupFile(filePath)).rejects.toThrowError(/digest 校验失败/);
  });

  test("v1 专家路由配置在删库前被拒绝", async () => {
    const tables = validBusinessTables();
    tables["expert_routing_configs"]![0]!["config"] = JSON.stringify({
      classification_mode: "difficulty",
      experts: [{ id: "x1", type: "real", provider_id: "p1", model: "gpt-x" }],
    });
    const filePath = await writeBackup(makeBackup(tables));
    await expect(loadBackupFile(filePath)).rejects.toThrowError(/不是 2/);
  });

  test("专家缺 band / 重复键 / 悬空引用分别失败", async () => {
    const noBand = validBusinessTables();
    noBand["expert_routing_configs"]![0]!["config"] = JSON.stringify({
      version: 2,
      experts: [{ id: "x1", type: "real", provider_id: "p1", model: "gpt-x" }],
    });
    const filePathNoBand = await writeBackup(makeBackup(noBand));
    await expect(loadBackupFile(filePathNoBand)).rejects.toThrowError(/band/);

    const dupKey = validBusinessTables();
    dupKey["virtual_keys"] = [
      {
        id: "vk1",
        key_value: "vk-plain-A",
        key_hash: "hash-A",
        name: "a",
        provider_id: null,
        model_id: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "vk2",
        key_value: "vk-plain-B",
        key_hash: "hash-A",
        name: "b",
        provider_id: null,
        model_id: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const filePathDup = await writeBackup(makeBackup(dupKey));
    await expect(loadBackupFile(filePathDup)).rejects.toThrowError(/重复键 \(key_hash\)/);

    const dangling = validBusinessTables();
    dangling["models"]![0]!["provider_id"] = "missing-provider";
    const filePathDangling = await writeBackup(makeBackup(dangling));
    await expect(loadBackupFile(filePathDangling)).rejects.toThrowError(/悬空引用/);
  });

  test("备份含退役列/未知表时拒绝", async () => {
    const retired = validBusinessTables();
    retired["models"]![0]!["protocol"] = "openai";
    const filePathRetired = await writeBackup(makeBackup(retired));
    await expect(loadBackupFile(filePathRetired)).rejects.toThrowError(/重新 export/);

    const unknownTable = makeBackup(validBusinessTables());
    unknownTable.tables["mystery"] = [];
    const filePathUnknown = await writeBackup(unknownTable);
    await expect(loadBackupFile(filePathUnknown)).rejects.toThrowError(/未知表 mystery/);
  });
});

describe("rebuild 前置校验", () => {
  test("meta 端口不一致即失败", async () => {
    const backup = makeBackup(validBusinessTables(), { port: "3307" });
    const { conn } = mockConnection(snapshotHandler(validBusinessTables()));
    await expect(
      preflightRebuild(conn, {
        backup,
        expected: { host: "localhost", port: "3306", database: "llm_gateway" },
        confirmDatabase: "llm_gateway",
      }),
    ).rejects.toThrowError(/meta\.port/);
  });

  test("--confirm-database 与 MYSQL_DATABASE 不一致即失败", async () => {
    const backup = makeBackup(validBusinessTables());
    const { conn } = mockConnection(snapshotHandler(validBusinessTables()));
    await expect(
      preflightRebuild(conn, {
        backup,
        expected: { host: "localhost", port: "3306", database: "llm_gateway" },
        confirmDatabase: "other_db",
      }),
    ).rejects.toThrowError(/--confirm-database/);
  });

  test("未知表 / 未知视图导致拒绝", async () => {
    const tables = validBusinessTables();
    const withExtra = snapshotHandler(tables, {
      "INFORMATION_SCHEMA.TABLES": [
        [
          ...ALL_GATEWAY_TABLES.map((name) => ({ name, type: "BASE TABLE" })),
          { name: "custom_table", type: "BASE TABLE" },
        ],
      ],
    });
    const { conn } = mockConnection(withExtra);
    await expect(
      preflightRebuild(conn, {
        backup: makeBackup(tables),
        expected: { host: "localhost", port: "3306", database: "llm_gateway" },
        confirmDatabase: "llm_gateway",
      }),
    ).rejects.toThrowError(/未知表 custom_table/);

    const withView = snapshotHandler(tables, {
      "INFORMATION_SCHEMA.TABLES": [
        [
          ...ALL_GATEWAY_TABLES.map((name) => ({ name, type: "BASE TABLE" })),
          { name: "custom_view", type: "VIEW" },
        ],
      ],
    });
    const viewConn = mockConnection(withView).conn;
    await expect(
      preflightRebuild(viewConn, {
        backup: makeBackup(tables),
        expected: { host: "localhost", port: "3306", database: "llm_gateway" },
        confirmDatabase: "llm_gateway",
      }),
    ).rejects.toThrowError(/未知视图 custom_view/);
  });

  test("导出后业务配置变化（陈旧备份）即失败", async () => {
    const backup = makeBackup(validBusinessTables());
    const changed = validBusinessTables();
    changed["users"]![0]!["username"] = "renamed";
    const { conn } = mockConnection(snapshotHandler(changed));
    await expect(
      preflightRebuild(conn, {
        backup,
        expected: { host: "localhost", port: "3306", database: "llm_gateway" },
        confirmDatabase: "llm_gateway",
      }),
    ).rejects.toThrowError(/陈旧备份|digest 不一致/);
  });
});

describe("rebuild 破坏性阶段顺序", () => {
  test("FK 检查关闭 -> 仅 DROP 已知网关表 -> 恢复 FK -> 建表 -> 迁移 -> 按序导入 -> 提交", async () => {
    const tables = validBusinessTables();
    const backup = makeBackup(tables);
    const inserts: string[] = [];
    const { conn, queries } = mockConnection((sql) => {
      if (sql.startsWith("INSERT INTO")) {
        inserts.push(sql);
      }
      return snapshotHandler(tables)(sql);
    });
    const hooks = mockHooks();

    await rebuildDatabase(conn, backup, { hooks });

    const fkOff = queries.indexOf("SET FOREIGN_KEY_CHECKS = 0");
    const fkOn = queries.indexOf("SET FOREIGN_KEY_CHECKS = 1");
    expect(fkOff).toBeGreaterThanOrEqual(0);
    for (const table of ALL_GATEWAY_TABLES) {
      expect(queries).toContain(`DROP TABLE IF EXISTS \`${table}\``);
    }
    const firstDrop = queries.findIndex((sql) => sql.startsWith("DROP TABLE IF EXISTS"));
    const lastDrop = Math.max(
      ...ALL_GATEWAY_TABLES.map((table) => queries.indexOf(`DROP TABLE IF EXISTS \`${table}\``)),
    );
    expect(firstDrop).toBeGreaterThan(fkOff);
    expect(fkOn).toBeGreaterThan(lastDrop);
    expect(queries).not.toContain("DROP DATABASE");

    expect(hooks.createTables).toHaveBeenCalledWith(conn);
    expect(hooks.applyMigrations).toHaveBeenCalledWith(conn);

    // 导入顺序满足 FK：providers 先于 models，models 先于 virtual_keys
    const order = IMPORT_ORDER.filter((table) => inserts.some((sql) => sql.includes(`INSERT INTO \`${table}\``)));
    expect(order).toEqual([...order].sort((a, b) => IMPORT_ORDER.indexOf(a) - IMPORT_ORDER.indexOf(b)));
    const providersIdx = inserts.findIndex((sql) => sql.includes("INSERT INTO `providers`"));
    const modelsIdx = inserts.findIndex((sql) => sql.includes("INSERT INTO `models`"));
    const vkIdx = inserts.findIndex((sql) => sql.includes("INSERT INTO `virtual_keys`"));
    expect(providersIdx).toBeGreaterThanOrEqual(0);
    expect(modelsIdx).toBeGreaterThan(providersIdx);
    expect(vkIdx).toBeGreaterThan(modelsIdx);
    expect(conn.commit).toHaveBeenCalled();
  });

  test("导入失败时回滚事务并隐藏 SQL/行值", async () => {
    const tables = validBusinessTables();
    const backup = makeBackup(tables);
    const { conn } = mockConnection((sql) => {
      if (sql.includes("INSERT INTO `models`")) {
        throw Object.assign(new Error("Duplicate entry 'sk-secret' for key 'PRIMARY'"), {
          code: "ER_DUP_ENTRY",
          errno: 1062,
        });
      }
      return snapshotHandler(tables)(sql);
    });

    await expect(
      rebuildDatabase(conn, backup, { hooks: mockHooks() }),
    ).rejects.toThrowError(/IMPORT_FAILED|事务已回滚/);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test("retry-restore 仅在业务表为空时导入", async () => {
    const tables = validBusinessTables();
    const backup = makeBackup(tables);
    const { conn: emptyConn } = mockConnection(snapshotHandler(tables));
    await expect(
      rebuildDatabase(emptyConn, backup, { retryRestore: true, hooks: mockHooks() }),
    ).resolves.toBeUndefined();

    const { conn: nonEmptyConn } = mockConnection(
      snapshotHandler(tables, { "SELECT COUNT(*)": [[{ cnt: 3 }]] }),
    );
    await expect(
      rebuildDatabase(nonEmptyConn, backup, { retryRestore: true, hooks: mockHooks() }),
    ).rejects.toThrowError(/非空/);
  });
});

describe("v2 安全回归", () => {
  test("配置摘要不依赖行顺序", () => {
    const tables = validBusinessTables();
    tables.users.push({ ...tables.users[0], id: "u2", username: "second" });
    const reversed = structuredClone(tables);
    reversed.users.reverse();
    expect(computeTablesDigest(tables)).toBe(computeTablesDigest(reversed));
  });

  test("保留合法 fallback 和禁用的空草稿", () => {
    const tables = validBusinessTables();
    tables.expert_routing_configs[0].config = JSON.stringify({
      version: 2, experts: [], fallback: { type: "real", provider_id: "p1", model: "gpt-x" },
      session_policy: { mode: "sticky", idle_ttl_seconds: 10, absolute_ttl_seconds: 20 },
    });
    tables.expert_routing_configs[0].enabled = 0;
    expect(() => validateBusinessConfig(tables)).not.toThrow();
  });

  test("空库恢复预检查不做陈旧配置比较", async () => {
    const { conn, queries } = mockConnection(snapshotHandler(validBusinessTables(), {
      "SELECT generation": [[{ generation: 2 }]],
    }));
    await preflightRebuild(conn, {
      backup: makeBackup(validBusinessTables()), expected: { host: "localhost", port: "3306", database: "llm_gateway" },
      confirmDatabase: "llm_gateway", retryRestore: true,
    });
    expect(queries.some((sql) => sql.startsWith("SELECT *"))).toBe(false);
    expect(queries.some((sql) => sql.startsWith("DROP"))).toBe(false);
  });

  test("临时库先建立基线，完整导入后返回原库", async () => {
    const { conn, queries } = mockConnection(snapshotHandler(validBusinessTables()));
    const hooks = mockHooks();
    await verifyRestoreInScratchDatabase(conn, makeBackup(validBusinessTables()), {
      hooks, database: "llm_gateway",
    });
    expect(vi.mocked(hooks.applyMigrations).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hooks.createTables).mock.invocationCallOrder[0],
    );
    expect(queries.at(-2)).toBe("USE `llm_gateway`");
    expect(queries.at(-1)).toMatch(/^DROP DATABASE IF EXISTS `llm_gateway_verify_/);
    expect(queries.some((sql) => sql.startsWith("DROP TABLE"))).toBe(false);
  });

  test("无法返回目标库时失败关闭，不继续重建", async () => {
    const { conn, queries } = mockConnection((sql) => {
      if (sql === "USE `llm_gateway`") throw new Error("switch failed");
      return snapshotHandler(validBusinessTables())(sql);
    });
    await expect(verifyRestoreInScratchDatabase(conn, makeBackup(validBusinessTables()), {
      hooks: mockHooks(), database: "llm_gateway",
    })).rejects.toThrow("switch failed");
    expect(queries.some((sql) => sql.startsWith("DROP TABLE"))).toBe(false);
  });

  test("触发器存在时在删表前中止", async () => {
    const { conn, queries } = mockConnection(snapshotHandler(validBusinessTables(), {
      "INFORMATION_SCHEMA.TRIGGERS": [[{ TRIGGER_NAME: "custom" }]],
    }));
    await expect(preflightRebuild(conn, {
      backup: makeBackup(validBusinessTables()), expected: { host: "localhost", port: "3306", database: "llm_gateway" },
      confirmDatabase: "llm_gateway",
    })).rejects.toThrow("触发器");
    expect(queries.some((sql) => sql.startsWith("DROP"))).toBe(false);
  });
});

describe("安全输出", () => {
  test("safeDbErrorMessage 不携带原始消息/SQL/行值", () => {
    const message = safeDbErrorMessage(
      Object.assign(new Error("Duplicate entry 'sk-secret-value'"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlState: "23000",
      }),
    );
    expect(message).toContain("ER_DUP_ENTRY");
    expect(message).not.toContain("sk-secret-value");
  });
});
