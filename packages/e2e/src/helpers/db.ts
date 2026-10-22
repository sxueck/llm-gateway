import mysql from "mysql2/promise";

export async function recreateDatabase(env: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
  });
  try {
    // 幂等：每次 e2e 都从空库起步，网关启动时自行跑迁移
    await conn.query(`DROP DATABASE IF EXISTS \`${env.database}\``);
    await conn.query(
      `CREATE DATABASE \`${env.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
}

export async function withConnection<T>(
  env: { host: string; port: number; user: string; password: string; database: string },
  fn: (conn: mysql.Connection) => Promise<T>,
): Promise<T> {
  const conn = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

/** api_requests 是缓冲写入，轮询直到出现匹配行或超时。 */
export async function pollApiRequestRow(
  env: Parameters<typeof withConnection>[0],
  predicate: (row: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const rows = await withConnection(env, async (conn) => {
        const [r] = await conn.query(
          "SELECT id, model, prompt_tokens, completion_tokens, status, route_tier, route_log_id, created_at FROM api_requests ORDER BY created_at DESC LIMIT 50",
        );
        return r as Record<string, unknown>[];
      });
      const hit = rows.find(predicate);
      if (hit) return hit;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `no matching api_requests row within ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr})` : ""}`,
  );
}
