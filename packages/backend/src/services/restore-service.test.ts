import { beforeEach, describe, expect, it, vi } from "vitest";

// 备份归档内各文件内容，按“相对 backupDir 的路径”提供。
type ArchiveFiles = Record<string, string>;

const mocks = vi.hoisted(() => {
  const queries: Array<{ sql: string; params?: any[] }> = [];

  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      return [[], []];
    }),
  };

  return {
    queries,
    connection,
    getConnection: vi.fn(async () => connection),
    readFile: vi.fn(async (..._args: any[]) => ""),
    readdir: vi.fn(async (..._args: any[]) => ["backup_dir"]),
    unlink: vi.fn(async (..._args: any[]) => undefined),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    downloadFile: vi.fn(async (..._args: any[]) => undefined),
    decryptFile: vi.fn(async (..._args: any[]) => undefined),
    getBackupRecord: vi.fn(async (..._args: any[]) => ({
      id: "backup_test",
      status: "completed",
      s3_key: "backups/2026/01/01/backup_test.tar.gz.enc",
    })),
    createRestoreRecord: vi.fn(async (..._args: any[]) => undefined),
    updateRestoreRecord: vi.fn(async (..._args: any[]) => undefined),
    getRestoreRecord: vi.fn(async (id: string) => ({
      id,
      status: "completed",
    })),
    hotConfigClear: vi.fn(),
    reloadCorsEnabled: vi.fn(async () => undefined),
    reasoningReload: vi.fn(async () => undefined),
    antiBotReload: vi.fn(async () => undefined),
    headerForwardingReload: vi.fn(async () => undefined),
    upstreamSslReload: vi.fn(async () => undefined),
  };
});

vi.mock("../db/index.js", () => ({
  getPool: () => ({ getConnection: mocks.getConnection }),
}));

vi.mock("../db/backup.js", () => ({
  backupDb: { getBackupRecord: mocks.getBackupRecord },
  restoreDb: {
    createRestoreRecord: mocks.createRestoreRecord,
    updateRestoreRecord: mocks.updateRestoreRecord,
    getRestoreRecord: mocks.getRestoreRecord,
  },
}));

vi.mock("./s3-storage.js", () => ({
  getS3Service: () => ({ downloadFile: mocks.downloadFile }),
}));

vi.mock("./backup-service.js", () => ({
  BackupService: class {
    decryptFile = mocks.decryptFile;
  },
}));

vi.mock("./hot-config-cache.js", () => ({
  hotConfigCache: { clear: mocks.hotConfigClear },
}));

vi.mock("./runtime-system-config-cache.js", () => ({
  runtimeSystemConfigCache: { reloadCorsEnabled: mocks.reloadCorsEnabled },
}));

vi.mock("./reasoning-effort-suffixes.js", () => ({
  reasoningEffortSuffixesCache: { reload: mocks.reasoningReload },
}));

vi.mock("./anti-bot.js", () => ({
  antiBotService: { reloadConfig: mocks.antiBotReload },
}));

vi.mock("./request-header-forwarding.js", () => ({
  requestHeaderForwardingService: {
    reloadConfig: mocks.headerForwardingReload,
  },
}));

vi.mock("./upstream-ssl-config.js", () => ({
  upstreamSslConfigService: { reloadConfig: mocks.upstreamSslReload },
}));

vi.mock("tar", () => ({
  extract: vi.fn(async () => undefined),
}));

vi.mock("fs", () => ({
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync,
}));

vi.mock("fs/promises", () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  unlink: mocks.unlink,
}));

import { RestoreService } from "./restore-service.js";

// 默认构造一个包含 users/providers/models 三表的最小合法备份。
function defaultArchive(overrides: ArchiveFiles = {}): ArchiveFiles {
  return {
    "metadata.json": JSON.stringify({
      backup_id: "backup_test",
      backup_type: "full",
      version: "1.0",
    }),
    "index.json": JSON.stringify({
      backup_id: "backup_test",
      tables: ["users", "providers", "models"],
    }),
    "data/users.json": JSON.stringify([]),
    "data/providers.json": JSON.stringify([
      { id: "p1", name: "openai", enabled: 1, created_at: 1 },
      { id: "p2", name: "anthropic", enabled: 1, created_at: 2 },
    ]),
    "data/models.json": JSON.stringify([
      { id: "m1", provider_id: "p1", name: "gpt-4o" },
    ]),
    ...overrides,
  };
}

function mockArchive(files: ArchiveFiles): void {
  mocks.readFile.mockImplementation(async (path: unknown) => {
    const relative = String(path).split("backup_dir").pop()!.replace(/^\//, "");
    if (!(relative in files)) {
      const err: any = new Error(
        `ENOENT: no such file or directory, open '${String(path)}'`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return files[relative];
  });
}

function completedCall(): any[] | undefined {
  return mocks.updateRestoreRecord.mock.calls.find(
    (call: any[]) => call[1]?.status === "completed",
  );
}

function failedCall(): any[] | undefined {
  return mocks.updateRestoreRecord.mock.calls.find(
    (call: any[]) => call[1]?.status === "failed",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  // vi.clearAllMocks 只清调用记录，这里显式恢复默认实现，避免用例间串扰。
  mocks.readFile.mockImplementation(async () => {
    throw new Error("archive not configured");
  });
  mocks.readdir.mockImplementation(async () => ["backup_dir"]);
  mocks.unlink.mockImplementation(async () => undefined);
  mocks.rmSync.mockImplementation(() => undefined);
  mocks.mkdirSync.mockImplementation(() => undefined);
  mocks.connection.query.mockImplementation(
    async (sql: string, params?: any[]) => {
      mocks.queries.push({ sql, params });
      return [[], []];
    },
  );
  mocks.getConnection.mockImplementation(async () => mocks.connection);
  mocks.getRestoreRecord.mockImplementation(async (id: string) => ({
    id,
    status: "completed",
  }));
});

describe("RestoreService.restoreFromBackup", () => {
  it("full restore: runs all DELETE/INSERT in one transaction on one connection and commits", async () => {
    mockArchive(defaultArchive());
    const service = new RestoreService();

    await service.restoreFromBackup("backup_test", { restore_type: "full" });

    expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    expect(mocks.connection.beginTransaction).toHaveBeenCalledTimes(1);
    // BEGIN 必须先于任何 SQL 语句
    expect(
      mocks.connection.beginTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.connection.query.mock.invocationCallOrder[0]);

    const sqls = mocks.queries.map((q) => q.sql);
    expect(sqls).toEqual(
      expect.arrayContaining([
        "DELETE FROM `users`",
        "DELETE FROM `providers`",
        "DELETE FROM `models`",
      ]),
    );
    expect(sqls.filter((sql) => sql.startsWith("INSERT INTO"))).toHaveLength(3); // 2 providers + 1 model

    expect(mocks.connection.commit).toHaveBeenCalledTimes(1);
    expect(mocks.connection.rollback).not.toHaveBeenCalled();
    expect(mocks.connection.release).toHaveBeenCalledTimes(1);

    const completed = completedCall();
    expect(completed).toBeTruthy();
    expect(JSON.parse(completed![1].changes_made)).toEqual({
      users: 0,
      providers: 2,
      models: 1,
    });
    expect(failedCall()).toBeUndefined();
  });

  it("clears hot config cache and reloads runtime config caches only after a successful commit", async () => {
    mockArchive(defaultArchive());
    const service = new RestoreService();

    await service.restoreFromBackup("backup_test", { restore_type: "full" });

    const commitOrder = mocks.connection.commit.mock.invocationCallOrder[0];
    expect(mocks.hotConfigClear).toHaveBeenCalledTimes(1);
    expect(mocks.hotConfigClear.mock.invocationCallOrder[0]).toBeGreaterThan(
      commitOrder,
    );
    expect(mocks.reloadCorsEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.reasoningReload).toHaveBeenCalledTimes(1);
    expect(mocks.antiBotReload).toHaveBeenCalledTimes(1);
    expect(mocks.headerForwardingReload).toHaveBeenCalledTimes(1);
    expect(mocks.upstreamSslReload).toHaveBeenCalledTimes(1);
  });

  it("rolls back the whole restore on any statement failure and reports failure only after rollback", async () => {
    mockArchive(defaultArchive());
    mocks.connection.query.mockImplementation(async (sql: string) => {
      mocks.queries.push({ sql });
      if (sql.startsWith("INSERT INTO `models`")) {
        throw new Error("ER_DUP_ENTRY on models");
      }
      return [[], []];
    });
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", { restore_type: "full" }),
    ).rejects.toThrow("ER_DUP_ENTRY on models");

    expect(mocks.connection.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.connection.commit).not.toHaveBeenCalled();
    expect(mocks.connection.release).toHaveBeenCalledTimes(1);

    // 失败状态必须在回滚之后写入
    expect(mocks.connection.rollback.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateRestoreRecord.mock.invocationCallOrder[0],
    );
    const failed = failedCall();
    expect(failed![1].error_message).toBe("ER_DUP_ENTRY on models");

    // 失败路径不得清理/重载缓存
    expect(mocks.hotConfigClear).not.toHaveBeenCalled();
    expect(mocks.reloadCorsEnabled).not.toHaveBeenCalled();
  });

  it("invalid backup data file fails before any table mutation", async () => {
    mockArchive(defaultArchive({ "data/providers.json": "{not valid json" }));
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", { restore_type: "full" }),
    ).rejects.toThrow(/Invalid JSON in backup data file for table providers/);

    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(mocks.queries).toHaveLength(0);
    expect(failedCall()).toBeTruthy();
  });

  it("missing backup data file fails before any table mutation", async () => {
    const files = defaultArchive();
    delete files["data/models.json"];
    mockArchive(files);
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", { restore_type: "full" }),
    ).rejects.toThrow(/Backup data file missing for table models/);

    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(mocks.queries).toHaveLength(0);
  });

  it("rows with inconsistent columns fail validation before any table mutation", async () => {
    mockArchive(
      defaultArchive({
        "data/providers.json": JSON.stringify([
          { id: "p1", name: "openai", enabled: 1 },
          { id: "p2", name: "anthropic" },
        ]),
      }),
    );
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", { restore_type: "full" }),
    ).rejects.toThrow(
      /Inconsistent columns in backup data for table providers at row 1/,
    );

    expect(mocks.queries).toHaveLength(0);
  });

  it("table names from the backup index are whitelisted before writes", async () => {
    mockArchive(
      defaultArchive({
        "index.json": JSON.stringify({
          tables: ["providers", "evil`; DROP TABLE users"],
        }),
        "data/evil`; DROP TABLE users.json": JSON.stringify([]),
      }),
    );
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", { restore_type: "full" }),
    ).rejects.toThrow(/Unsupported table in backup index/);

    expect(mocks.queries).toHaveLength(0);
  });

  it("partial restore upserts without deleting, independent of backup metadata", async () => {
    mockArchive(defaultArchive());
    const service = new RestoreService();

    await service.restoreFromBackup("backup_test", {
      restore_type: "partial",
      tables_to_restore: ["providers"],
    });

    const sqls = mocks.queries.map((q) => q.sql);
    expect(sqls.some((sql) => sql.includes("DELETE FROM"))).toBe(false);
    expect(sqls).toHaveLength(2); // 两行 providers，均走 upsert
    for (const sql of sqls) {
      expect(sql).toContain("INSERT INTO `providers`");
      expect(sql).toContain("ON DUPLICATE KEY UPDATE");
      expect(sql).toContain("`name` = VALUES(`name`)");
    }
    expect(mocks.connection.commit).toHaveBeenCalledTimes(1);
    const completed = completedCall();
    expect(JSON.parse(completed![1].changes_made)).toEqual({ providers: 2 });
  });

  it("partial restore requests for tables absent from the backup fail precisely before writes", async () => {
    mockArchive(defaultArchive()); // 索引只含 users/providers/models
    const service = new RestoreService();

    await expect(
      service.restoreFromBackup("backup_test", {
        restore_type: "partial",
        tables_to_restore: ["virtual_keys"],
      }),
    ).rejects.toThrow(/Tables not present in backup backup_test: virtual_keys/);

    expect(mocks.queries).toHaveLength(0);
  });

  it("cleanup failures do not mask a successful restore", async () => {
    mockArchive(defaultArchive());
    mocks.rmSync.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const service = new RestoreService();

    const record = await service.restoreFromBackup("backup_test", {
      restore_type: "full",
    });

    expect(record.status).toBe("completed");
    expect(failedCall()).toBeUndefined();
    expect(mocks.rmSync).toHaveBeenCalled();
  });
});
