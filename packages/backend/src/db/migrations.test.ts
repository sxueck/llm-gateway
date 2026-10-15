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
    const conn = provisionedConn(2);
    await applyMigrations(conn as unknown as Connection);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some(([sql]) => String(sql).includes("ALTER TABLE"))).toBe(false);
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
