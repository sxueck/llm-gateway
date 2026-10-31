import type { Connection } from "mysql2/promise";
import { describe, expect, test, vi } from "vitest";
import { applyMigrations, getCurrentVersion, migrations } from "./migrations.js";

function connection(names: string[] = [], generation: number | null = null) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("INFORMATION_SCHEMA.TABLES")) return [names.map((name) => ({ name }))];
    if (sql.includes("SELECT generation")) return [generation === null ? [] : [{ generation }]];
    if (sql.includes("INSERT INTO schema_baseline")) generation = 2;
    if (sql.includes("MAX(version)")) return [[{ version: null }]];
    return [[]];
  });
  return { query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
}

describe("v2 database baseline", () => {
  test("establishes generation 2 on an empty database and applies pending migrations", async () => {
    const conn = connection();
    await applyMigrations(conn as unknown as Connection);
    expect(conn.query).toHaveBeenCalledWith("INSERT INTO schema_baseline (id, generation) VALUES (1, 2)");
    expect(conn.beginTransaction).toHaveBeenCalled();
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    // 空库的表由 createTables 连同 session_id 一起建；迁移只登记版本，绝不先跑 DDL。
    expect(issued.some((sql) => sql.includes("ALTER TABLE"))).toBe(false);
    expect(issued.some((sql) => /DROP |TRUNCATE /.test(sql))).toBe(false);
  });

  test.each([["users"], ["schema_migrations"], ["other_table"]])("rejects legacy objects before any writes: %s", async (name) => {
    const conn = connection([name]);
    await expect(applyMigrations(conn as unknown as Connection)).rejects.toThrow("Legacy database detected");
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  test("accepts the current baseline without reinitializing it", async () => {
    const conn = connection(["users", "schema_baseline", "schema_migrations"], 2);
    expect(await getCurrentVersion(conn as unknown as Connection)).toBe(0);
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO schema_baseline"))).toBe(false);
  });

  test.each([null, 1, 3])("rejects missing or unsupported baseline %s", async (generation) => {
    const conn = connection(["users", "schema_baseline"], generation);
    await expect(getCurrentVersion(conn as unknown as Connection)).rejects.toThrow(/baseline/);
    expect(conn.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO schema_baseline"))).toBe(false);
  });

  test("propagates metadata read failures instead of treating them as an empty database", async () => {
    const conn = connection();
    conn.query.mockRejectedValueOnce(new Error("permission denied"));
    await expect(applyMigrations(conn as unknown as Connection)).rejects.toThrow("permission denied");
  });
});

describe("migration 1: api_requests.session_id", () => {
  // 已存在 session_id 列与索引的库：迁移必须幂等，不重跑 DDL。
  function provisionedConn(appliedVersion: number | null) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [[{ name: "api_requests" }, { name: "schema_baseline" }, { name: "schema_migrations" }]];
      }
      if (sql.includes("SELECT generation")) return [[{ generation: 2 }]];
      if (sql.includes("MAX(version)")) return [[{ version: appliedVersion }]];
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [[{ name: "session_id" }]];
      if (sql.includes("INFORMATION_SCHEMA.STATISTICS")) return [[{ name: "idx_api_requests_session" }]];
      return [[]];
    });
    return { query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
  }

  test("skips DDL when the column and index already exist", async () => {
    const conn = provisionedConn(null);
    await migrations[0].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("ALTER TABLE"))).toBe(false);
  });

  test("empty schema records nothing but the version (scratch dry-run / rebuild order)", async () => {
    const conn = connection();
    await migrations[0].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("ALTER TABLE"))).toBe(false);
  });

  test("upgrades a table that predates session_id", async () => {
    const conn = connection(["api_requests", "schema_baseline", "schema_migrations"], 2);
    await migrations[0].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("ADD COLUMN session_id"))).toBe(true);
    expect(issued.some((sql) => sql.includes("ADD INDEX idx_api_requests_session"))).toBe(true);
  });

  test("does not re-apply recorded migrations once all versions are applied", async () => {
    const conn = provisionedConn(6);
    await applyMigrations(conn as unknown as Connection);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some(([sql]) => String(sql).includes("ALTER TABLE"))).toBe(false);
  });
});

describe("migration 4: model_daily_usage_batches", () => {
  test("creates the idempotency marker table idempotently", async () => {
    const conn = connection();
    await migrations[3].up!(conn as unknown as Connection);
    await migrations[3].up!(conn as unknown as Connection);

    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued).toHaveLength(2);
    expect(issued.every((sql) => sql.includes("CREATE TABLE IF NOT EXISTS model_daily_usage_batches"))).toBe(true);
  });
});

describe("migration 5: virtual_key_model_quotas", () => {
  test("creates the quota, usage and batch idempotency tables idempotently", async () => {
    const conn = connection();
    await migrations[4].up!(conn as unknown as Connection);
    await migrations[4].up!(conn as unknown as Connection);

    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued).toHaveLength(6);
    expect(
      issued.filter((sql) =>
        /CREATE TABLE IF NOT EXISTS virtual_key_model_quotas\b/.test(sql),
      ),
    ).toHaveLength(2);
    expect(
      issued.filter((sql) =>
        /CREATE TABLE IF NOT EXISTS virtual_key_model_daily_usage\b/.test(sql),
      ),
    ).toHaveLength(2);
    expect(
      issued.filter((sql) =>
        sql.includes(
          "CREATE TABLE IF NOT EXISTS virtual_key_model_daily_usage_batches",
        ),
      ),
    ).toHaveLength(2);
  });

  test("keeps the retired global quota tables' data (no DROP/TRUNCATE)", async () => {
    const conn = connection();
    await migrations[4].up!(conn as unknown as Connection);

    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    // 旧全局额度停用但数据保留：迁移绝不能删 model_daily_usage*。
    expect(issued.some((sql) => /DROP |TRUNCATE /.test(sql))).toBe(false);
  });

  test("down drops only the three new tables", async () => {
    const conn = connection();
    await migrations[4].down!(conn as unknown as Connection);

    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued).toEqual([
      expect.stringContaining(
        "DROP TABLE IF EXISTS virtual_key_model_daily_usage_batches",
      ),
      expect.stringContaining(
        "DROP TABLE IF EXISTS virtual_key_model_daily_usage",
      ),
      expect.stringContaining("DROP TABLE IF EXISTS virtual_key_model_quotas"),
    ]);
  });
});

describe("migration 6: login_ip_lockout", () => {
  test("is version 6 and rolls back reversibly", () => {
    expect(migrations[5].version).toBe(6);
    expect(migrations[5].name).toBe("login_ip_lockout");
    expect(typeof migrations[5].down).toBe("function");
  });

  test("creates both lockout tables idempotently (re-run issues the same DDL)", async () => {
    const conn = connection();
    await migrations[5].up!(conn as unknown as Connection);
    await migrations[5].up!(conn as unknown as Connection);

    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued).toHaveLength(4);
    expect(issued.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS login_attempt_lockouts"))).toHaveLength(2);
    expect(issued.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS login_lockout_events"))).toHaveLength(2);
    // 不含任何非幂等 DDL
    expect(issued.some((sql) => /ALTER TABLE|DROP /.test(sql))).toBe(false);
  });

  test("ships the bucket key and the indexes required by access and cleanup paths", async () => {
    const conn = connection();
    await migrations[5].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql)).join("\n");
    // 封锁桶 = (ip, username)：共享出口 IP 下一个用户名不能封锁其它账号
    expect(issued).toContain("username VARCHAR(64) NOT NULL");
    expect(issued).toContain("PRIMARY KEY (ip, username)");
    expect(issued).toContain("INDEX idx_login_attempt_lockouts_last_failed (last_failed_at)");
    expect(issued).toContain("INDEX idx_login_attempt_lockouts_locked_until (locked_until)");
    expect(issued).toContain("code VARCHAR(64) NOT NULL UNIQUE");
    expect(issued).toContain("INDEX idx_login_lockout_events_created_at (created_at)");
  });

  test("down drops both tables idempotently", async () => {
    const conn = connection();
    await migrations[5].down!(conn as unknown as Connection);
    await migrations[5].down!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued).toHaveLength(4);
    expect(issued.every((sql) => sql.startsWith("DROP TABLE IF EXISTS login_"))).toBe(true);
  });

  test("is applied when the recorded version is 5 and recorded afterwards", async () => {
    const recorded: Array<{ version: number; name: string }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [[{ name: "users" }, { name: "schema_baseline" }, { name: "schema_migrations" }]];
      }
      if (sql.includes("SELECT generation")) return [[{ generation: 2 }]];
      if (sql.includes("MAX(version)")) return [[{ version: 5 }]];
      if (sql.includes("INSERT INTO schema_migrations")) {
        recorded.push({ version: params![0] as number, name: params![1] as string });
      }
      return [[]];
    });
    const conn = { query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    await applyMigrations(conn as unknown as Connection);
    const issued = query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS login_attempt_lockouts"))).toBe(true);
    expect(recorded).toEqual([{ version: 6, name: "login_ip_lockout" }]);
  });
});

describe("migration 2: virtual_keys.context_budget_tokens", () => {
  function v2Conn(columns: string[]) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [[{ name: "virtual_keys" }, { name: "schema_baseline" }, { name: "schema_migrations" }]];
      }
      if (sql.includes("SELECT generation")) return [[{ generation: 2 }]];
      if (sql.includes("MAX(version)")) return [[{ version: 1 }]];
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [columns.map((name) => ({ name }))];
      return [[]];
    });
    return { query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
  }

  test("swaps dynamic_compression_enabled for context_budget_tokens", async () => {
    const conn = v2Conn(["dynamic_compression_enabled"]);
    await migrations[1].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("ADD COLUMN context_budget_tokens"))).toBe(true);
    expect(issued.some((sql) => sql.includes("DROP COLUMN dynamic_compression_enabled"))).toBe(true);
  });

  test("skips DDL when the swap already happened", async () => {
    const conn = v2Conn(["context_budget_tokens"]);
    await migrations[1].up!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("ALTER TABLE"))).toBe(false);
  });

  test("down restores the legacy column", async () => {
    const conn = v2Conn(["context_budget_tokens"]);
    await migrations[1].down!(conn as unknown as Connection);
    const issued = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(issued.some((sql) => sql.includes("DROP COLUMN context_budget_tokens"))).toBe(true);
    expect(issued.some((sql) => sql.includes("ADD COLUMN dynamic_compression_enabled"))).toBe(true);
  });
});
