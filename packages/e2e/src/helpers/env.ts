/**
 * E2E 运行契约：未显式提供 MySQL 连接信息时快速失败，
 * 而不是让网关启动后莫名挂掉。CI 由 service container 提供，
 * 本地默认对齐 compose/docker-compose.yml。
 */
export interface E2EMysqlEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT || 3111);
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 3112);

export function requireMysqlEnv(): E2EMysqlEnv {
  const password = process.env.MYSQL_PASSWORD ?? process.env.MYSQL_ROOT_PASSWORD;
  if (!password) {
    throw new Error(
      "E2E needs MySQL credentials: set MYSQL_HOST/PORT/USER/PASSWORD (MYSQL_DATABASE defaults to llm_gateway_e2e). See packages/e2e/README.md.",
    );
  }
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password,
    database: process.env.MYSQL_DATABASE || "llm_gateway_e2e",
  };
}

export const MOCK_UPSTREAM_KEY = "e2e-upstream-key";
export const VIRTUAL_KEY = "sk-e2e-virtual-key-0001";
export const JWT_SECRET = "e2e-jwt-secret-0123456789abcdef0123456789";
