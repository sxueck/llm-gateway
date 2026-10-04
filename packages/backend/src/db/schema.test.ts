import type { Connection } from "mysql2/promise";
import { describe, expect, test, vi } from "vitest";
import { createTables } from "./schema.js";
import { ALL_GATEWAY_TABLES, IMPORT_ORDER, TABLE_COLUMNS } from "./upgrade.js";

describe("v2 schema", () => {
  test("builds on the injected connection without loading application config or releasing it", async () => {
    const query = vi.fn(async () => [[]]);
    const release = vi.fn();
    await createTables({ query, release } as unknown as Connection);
    expect(release).not.toHaveBeenCalled();
    const sql = vi.mocked(query).mock.calls.map((call) => String((call as unknown[])[0]));
    for (const table of IMPORT_ORDER) {
      const statement = sql.find((text) => text.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
      expect(statement, table).toBeDefined();
      const columns = [...statement!.matchAll(/^\s+(`?\w+`?)\s+(?:VARCHAR|TEXT|MEDIUMTEXT|TINYINT|BIGINT|INT|DECIMAL)\b/gm)]
        .map((match) => match[1].replaceAll("`", ""));
      expect(columns.sort(), table).toEqual([...TABLE_COLUMNS[table]].sort());
    }
    for (const statement of sql) {
      const table = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
      expect(ALL_GATEWAY_TABLES).toContain(table);
    }
    expect(sql.find((text) => text.includes("CREATE TABLE IF NOT EXISTS api_requests (")))
      .toContain("INDEX idx_api_requests_route_log_id (route_log_id)");
    expect(sql.join("\n")).not.toMatch(/health_check_protocol|owner_node|owner_pop|supported_protocols/);
  });
});
