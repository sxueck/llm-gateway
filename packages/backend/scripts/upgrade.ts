import { existsSync, promises as fsPromises } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import mysql from "mysql2/promise";
import {
  UpgradeError,
  exportBusinessConfig,
  isSecureFileMode,
  loadBackupFile,
  parseCliArgs,
  preflightRebuild,
  rebuildDatabase,
  safeDbErrorMessage,
  verifyRestoreInScratchDatabase,
} from "../src/db/upgrade.js";
import type { ParsedCliArgs, SchemaHooks } from "../src/db/upgrade.js";

function loadEnvFile(): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(currentDir, "../../../.env"), // 仓库根 .env
    resolve(currentDir, "../../.env"), // packages/backend/.env
  ];
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath });
      break;
    }
  }
}

interface MysqlEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function readMysqlEnv(): MysqlEnv {
  return {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "llm_gateway",
  };
}

async function loadSchemaHooks(): Promise<SchemaHooks> {
  const schemaModule = await import("../src/db/schema.js");
  const migrationsModule = await import("../src/db/migrations.js");
  return {
    createTables: schemaModule.createTables,
    applyMigrations: migrationsModule.applyMigrations,
  };
}

function log(message: string): void {
  console.log(message);
}

function printRecoveryHints(file: string | undefined, database: string): void {
  const command = process.argv[1]?.endsWith(".js")
    ? "node dist/upgrade.js"
    : "node_modules/.bin/tsx packages/backend/scripts/upgrade.ts";
  console.error("[v2升级] 恢复指引（不含任何行数据/密钥）:");
  console.error("  1) 表结构已重建但导入失败时，修复问题后仅重试导入（要求业务表为空）:");
  console.error(
    `     ${command} rebuild --file ${file ?? "<备份文件>"} --confirm-database ${database} --service-stopped --retry-restore`,
  );
  console.error("  2) 或使用升级前准备的全量 mysqldump 完整恢复数据库。");
  console.error("  3) 重新走两阶段流程前，请再次确认所有网关副本已停止。");
}

async function runExport(args: ParsedCliArgs, env: MysqlEnv): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
  });
  try {
    const backup = await exportBusinessConfig(conn, {
      filePath: args.file!,
      meta: { host: env.host, port: String(env.port), database: env.database },
      onProgress: log,
    });
    log(`[v2升级] 业务配置已导出 -> ${args.file} (权限 0600, 独占写入, 已 fsync)`);
    const summary = Object.entries(backup.meta.counts)
      .map(([table, count]) => `${table}=${count}`)
      .join(" ");
    log(`[v2升级] 行数统计: ${summary}`);
    log("[v2升级] 提示: 备份包含 api_key/密码哈希/虚拟密钥明文，请按密钥文件保管，用后删除。");
  } finally {
    await conn.end();
  }
}

async function runRebuild(args: ParsedCliArgs, env: MysqlEnv): Promise<void> {
  const backup = await loadBackupFile(args.file!);
  try {
    const stat = await fsPromises.stat(args.file!);
    if (!isSecureFileMode(stat.mode)) {
      log("[v2升级] 警告: 备份文件权限宽于 0600，可能被其他用户读取，建议 chmod 600");
    }
  } catch {
    // 权限提示失败不影响流程
  }
  const conn = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
  });
  try {
    await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    await preflightRebuild(conn, {
      backup,
      expected: { host: env.host, port: String(env.port), database: env.database },
      confirmDatabase: args.confirmDatabase!,
      retryRestore: args.retryRestore,
      onProgress: log,
    });
    const hooks = await loadSchemaHooks();
    if (!args.retryRestore) {
      await verifyRestoreInScratchDatabase(conn, backup, {
        hooks,
        database: env.database,
        onProgress: log,
      });
    }
    await rebuildDatabase(conn, backup, {
      retryRestore: args.retryRestore,
      hooks,
      onProgress: log,
    });
    const summary = Object.entries(backup.meta.counts)
      .map(([table, count]) => `${table}=${count}`)
      .join(" ");
    log(`[v2升级] 重建完成，已导入业务配置: ${summary}`);
    log("[v2升级] 日志/统计/会话/run 记录已清空；请启动网关前检查 .env 与副本状态。");
  } catch (error) {
    if (
      error instanceof UpgradeError &&
      (error.code === "SCHEMA_REBUILD_FAILED" || error.code === "IMPORT_FAILED")
    ) {
      printRecoveryHints(args.file, env.database);
    }
    throw error;
  } finally {
    await conn.end();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const env = readMysqlEnv();
    if (args.command === "export") {
      await runExport(args, env);
    } else {
      await runRebuild(args, env);
    }
  } catch (error) {
    if (error instanceof UpgradeError) {
      console.error(`[v2升级] 失败 (${error.code}): ${error.message}`);
    } else {
      console.error(`[v2升级] 失败: ${safeDbErrorMessage(error)}`);
    }
    process.exitCode = 1;
  }
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedScript && invokedScript === fileURLToPath(import.meta.url)) {
  void main();
}
