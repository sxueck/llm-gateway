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
  test("has no historical migrations and establishes generation 2 on an empty database", async () => {
    const conn = connection();
    expect(migrations).toEqual([]);
    await applyMigrations(conn as unknown as Connection);
    expect(conn.query).toHaveBeenCalledWith("INSERT INTO schema_baseline (id, generation) VALUES (1, 2)");
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some(([sql]) => /DROP |DELETE |ALTER |UPDATE /.test(sql))).toBe(false);
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
