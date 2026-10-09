import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import type { Connection, FieldPacket, RowDataPacket } from "mysql2/promise";
import { createTables } from "../src/db/schema.js";
import { getCurrentVersion } from "../src/db/migrations.js";
import { CLEARED_TABLES, IMPORT_ORDER, computeTablesDigest, normalizeBusinessTables } from "../src/db/upgrade.js";
import type { BusinessTables } from "../src/db/upgrade.js";

const imageIndex = process.argv.indexOf("--image");
const image = imageIndex < 0 ? undefined : process.argv[imageIndex + 1];
if (imageIndex >= 0 && !image) throw new Error("--image requires a locally built gateway image");
const root = resolve(import.meta.dirname, "../../..");
const prefix = `gw-v2-test-${randomBytes(5).toString("hex")}`;
const container = `${prefix}-mysql`;
const network = `${prefix}-network`;
const database = "upgrade_fixture";
const password = randomBytes(24).toString("hex");
const workDir = await fs.mkdtemp(join(tmpdir(), `${prefix}-`));
let conn: Connection | undefined;
let networkCreated = false;
let containerCreated = false;
let imageDirectoryPrepared = false;

function docker(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function snapshot(): Promise<BusinessTables> {
  const tables: BusinessTables = {};
  for (const table of IMPORT_ORDER) {
    const [rows] = await conn!.query(`SELECT * FROM \`${table}\``);
    tables[table] = rows as BusinessTables[string];
  }
  return normalizeBusinessTables(tables);
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  await conn!.query(`INSERT INTO \`${table}\` SET ?`, [row]);
}

try {
  if (image) {
    // Ownership changes are restricted to this newly created disposable bind directory.
    docker(["run", "--rm", "--user", "0", "--mount", `type=bind,source=${workDir},target=/upgrade`, image,
      "node", "-e", "require('node:fs').chownSync('/upgrade',1001,1001)"]);
    imageDirectoryPrepared = true;
  }
  docker(["network", "create", network]);
  networkCreated = true;
  docker([
    "run", "-d", "--name", container, "--network", network,
    "-p", "127.0.0.1::3306", "--env", "MYSQL_ROOT_PASSWORD", "--env", "MYSQL_DATABASE",
    "--mount", `type=bind,source=${join(root, "compose/mysql/conf.d")},target=/etc/mysql/conf.d,readonly`,
    "mysql:8.0",
  ], { ...process.env, MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: database });
  containerCreated = true;
  const port = Number(docker(["port", container, "3306/tcp"]).split(":").at(-1));
  assert(Number.isInteger(port) && port > 0);
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      conn = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", password, database });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert(conn, "isolated MySQL was not ready in 90 seconds");
  const [version] = await conn.query("SELECT VERSION() AS version");
  console.log(`MySQL ${(version as Array<{ version: string }>)[0].version}; runner=${image ?? "source tsx"}`);

  await createTables(conn);
  await conn.query("CREATE TABLE schema_migrations (version INT PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at BIGINT NOT NULL)");
  await conn.query("INSERT INTO schema_migrations VALUES (59, 'legacy_fixture', 1)");
  await conn.query("ALTER TABLE providers ADD owner_node VARCHAR(255), ADD owner_pop VARCHAR(255)");
  await conn.query("ALTER TABLE models ADD supported_protocols TEXT");
  await conn.query("CREATE TABLE intent_classify_logs (id VARCHAR(255) PRIMARY KEY)");
  await conn.query("INSERT INTO intent_classify_logs VALUES ('legacy-log')");
  await insert("users", { id: "u1", username: "fixture-admin", password_hash: "synthetic-hash", updated_at: 1 });
  await insert("providers", { id: "p1", name: "Fixture", base_url: "https://example.invalid", api_key: "fixture-only", owner_node: "retired", updated_at: 1 });
  await insert("system_config", { key: "fixture_setting", value: "preserve-me", updated_at: 1 });
  await insert("routing_configs", { id: "r1", name: "Fixture routing", type: "load_balance", config: '{"models":["m1"]}', created_at: 1, updated_at: 1 });
  await insert("expert_routing_configs", {
    id: "e1", name: "Fixture expert", config: JSON.stringify({
      version: 2, experts: [{ id: "x1", type: "real", provider_id: "p1", model: "fixture-model", band: "high" }],
      fallback: { type: "real", provider_id: "p1", model: "fixture-model" },
      session_policy: { mode: "escalate_only", idle_ttl_seconds: 10, absolute_ttl_seconds: 20 },
    }), created_at: 1, updated_at: 1,
  });
  await insert("cost_mappings", { id: "c1", pattern: "fixture-*", target_model: "fixture-model", created_at: 1, updated_at: 1 });
  await insert("worker_plugins", { id: "w1", version: "1", digest: "fixture-digest", name: "Fixture", manifest_json: "{}", bundle_files_json: "{}", created_at: 1 });
  await insert("models", { id: "m1", name: "Fixture model", provider_id: "p1", model_identifier: "fixture-model", supported_protocols: '["openai","anthropic"]', updated_at: 1 });
  await insert("models", { id: "m2", name: "Fixture virtual", model_identifier: "fixture-virtual", is_virtual: 1, routing_config_id: "r1", expert_routing_id: "e1", updated_at: 1 });
  await insert("virtual_keys", { id: "vk1", key_value: "fixture-key", key_hash: "fixture-key-hash", name: "Fixture key", model_id: "m2", model_ids: '["m1","m2"]', updated_at: 1 });
  await insert("user_plugin_enrollments", { user_id: "u1", plugin_id: "w1", version: "1", updated_at: 1 });
  await insert("api_requests", { id: "log1", virtual_key_id: "vk1", provider_id: "p1", model: "fixture-model", status: "success", prompt_tokens: 2, completion_tokens: 3, created_at: 1 });
  await insert("api_request_daily_summaries", { summary_date: "2026-01-01", model: "fixture-model", request_count: 1 });
  await insert("prompt_samples", { id: "sample1", virtual_key_id: "vk1", protocol: "openai", intent_text: "synthetic prompt", created_at: 1 });
  await insert("session_context_bindings", { virtual_key_scope: "vk1", session_id: "session1", fingerprint: "0".repeat(64), protocol: "openai", created_at: 1, last_seen_at: 1, idle_expires_at: 2, absolute_expires_at: 3 });
  await insert("agent_search_runs", { id: "run1", user_id: "u1", plugin_id: "w1", plugin_version: "1", plugin_digest: "fixture-digest", source_type: "public_git", query_encrypted: "synthetic", model_profile: "fixture", created_at: 1, expires_at: 2 });
  const expectedDigest = computeTablesDigest(await snapshot());
  await assert.rejects(getCurrentVersion(conn), /Legacy database detected/);
  console.log("PASS legacy database is refused without schema mutation");

  const cliEnv = {
    ...process.env, MYSQL_HOST: image ? container : "127.0.0.1", MYSQL_PORT: String(image ? 3306 : port),
    MYSQL_USER: "root", MYSQL_PASSWORD: password, MYSQL_DATABASE: database,
  };
  function cli(args: string[], expectedCode = 0): string {
    const executable = image ? "docker" : join(root, "node_modules/.bin/tsx");
    const cliArgs = image ? [
      "run", "--rm", "--network", network,
      "--mount", `type=bind,source=${workDir},target=/upgrade`,
      ...["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"].flatMap((name) => ["--env", name]),
      image, "node", "dist/upgrade.js", ...args,
    ] : [join(root, "packages/backend/scripts/upgrade.ts"), ...args];
    const result = spawnSync(executable, cliArgs, { cwd: root, env: cliEnv, encoding: "utf8", timeout: 120_000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert(![password, "fixture-only", "fixture-key", "synthetic-hash"].some((secret) => output.includes(secret)), "CLI leaked a fixture secret");
    assert.equal(result.status, expectedCode, `CLI status mismatch:\n${output}`);
    return output;
  }
  const file = image ? "/upgrade/config.json" : join(workDir, "config.json");
  const rebuild = ["rebuild", "--file", file, "--confirm-database", database, "--service-stopped"];
  cli(["export", "--file", file]);
  const mode = image ? Number(docker(["run", "--rm", "--mount", `type=bind,source=${workDir},target=/upgrade`, image,
    "node", "-e", "console.log(require('node:fs').statSync('/upgrade/config.json').mode & 0o777)"])) : (await fs.stat(join(workDir, "config.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  cli(["export", "--file", file], 1);
  assert(cli(["rebuild", "--file", file, "--confirm-database", "wrong", "--service-stopped"], 1).includes("CONFIRM_DATABASE_MISMATCH"));
  assert(cli(["rebuild", "--file", file, "--confirm-database", database], 1).includes("SERVICE_NOT_STOPPED"));
  await conn.query("UPDATE providers SET name = 'changed' WHERE id = 'p1'");
  assert(cli(rebuild, 1).includes("STALE_BACKUP"));
  await conn.query("UPDATE providers SET name = 'Fixture' WHERE id = 'p1'");
  const [logBefore] = await conn.query("SELECT COUNT(*) AS cnt FROM api_requests");
  assert.equal((logBefore as Array<{ cnt: number }>)[0].cnt, 1);
  console.log("PASS exclusive backup, exact database confirmation, stopped-service guard, stale backup; original data intact");

  await conn.query("ALTER TABLE providers MODIFY name TEXT NOT NULL");
  await conn.query("UPDATE providers SET name = REPEAT('x', 300) WHERE id = 'p1'");
  const incompatibleFile = image ? "/upgrade/incompatible.json" : join(workDir, "incompatible.json");
  cli(["export", "--file", incompatibleFile]);
  assert(cli(["rebuild", "--file", incompatibleFile, "--confirm-database", database, "--service-stopped"], 1).includes("IMPORT_FAILED"));
  const [untouched] = await conn.query("SELECT COUNT(*) AS cnt FROM api_requests");
  assert.equal((untouched as Array<{ cnt: number }>)[0].cnt, 1);
  await conn.query("UPDATE providers SET name = 'Fixture' WHERE id = 'p1'");
  await conn.query("ALTER TABLE providers MODIFY name VARCHAR(255) NOT NULL");
  console.log("PASS real MySQL constraint failure in scratch import leaves target rows intact");

  const output = cli(rebuild);
  assert(output.includes("干跑校验通过") && output.includes("重建完成"));
  assert.equal(await getCurrentVersion(conn), 0);
  assert.equal(computeTablesDigest(await snapshot()), expectedDigest);
  for (const table of CLEARED_TABLES) {
    const [rows]: [RowDataPacket[], FieldPacket[]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${table}\``);
    assert.equal((rows as Array<{ cnt: number }>)[0].cnt, 0, `${table} should be empty`);
  }
  const [retired] = await conn.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('owner_node', 'owner_pop', 'supported_protocols')");
  assert.equal((retired as unknown[]).length, 0);
  const [scratch] = await conn.query("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME LIKE 'upgrade_fixture_verify_%'");
  assert.equal((scratch as unknown[]).length, 0);
  assert(cli([...rebuild, "--retry-restore"], 1).includes("RETRY_NOT_EMPTY"));
  console.log("PASS all 10 business tables restored (IDs, keys, JSON and links); 19 historical tables empty; retired columns removed; scratch database cleaned");

  // Only this disposable fixture is emptied to exercise recovery after a rolled-back import.
  for (const table of [...IMPORT_ORDER].reverse()) await conn.query(`DELETE FROM \`${table}\``);
  cli([...rebuild, "--retry-restore"]);
  assert.equal(computeTablesDigest(await snapshot()), expectedDigest);
  console.log("PASS empty v2 database retry-restore; nonempty database refused");
} finally {
  if (conn) await conn.end();
  if (containerCreated) docker(["rm", "-f", "-v", container]);
  if (networkCreated) docker(["network", "rm", network]);
  if (image && imageDirectoryPrepared) {
    docker(["run", "--rm", "--user", "0", "--mount", `type=bind,source=${workDir},target=/upgrade`, image,
      "node", "-e", `const fs=require('node:fs');for(const f of fs.readdirSync('/upgrade'))fs.chownSync('/upgrade/'+f,${process.getuid!()},${process.getgid!()});fs.chownSync('/upgrade',${process.getuid!()},${process.getgid!()})`]);
  }
  await fs.rm(workDir, { recursive: true, force: true });
  console.log("Cleaned only this run's disposable MySQL, network and synthetic backup");
}
