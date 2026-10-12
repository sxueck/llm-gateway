import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_PORT, JWT_SECRET } from "./env.js";

const PKG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // packages/e2e
export const REPO_ROOT = path.resolve(PKG_DIR, "../..");

export interface GatewayHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startGateway(mysql: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}, jevApiUrl: string): Promise<GatewayHandle> {
  const entry = path.join(REPO_ROOT, "packages/backend/src/index.ts");
  const tsx = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  const child: ChildProcess = spawn(process.execPath, [tsx, entry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      MYSQL_HOST: mysql.host,
      MYSQL_PORT: String(mysql.port),
      MYSQL_USER: mysql.user,
      MYSQL_PASSWORD: mysql.password,
      MYSQL_DATABASE: mysql.database,
      JWT_SECRET,
      LOG_LEVEL: process.env.E2E_GATEWAY_LOG_LEVEL || "warn",
      PUBLIC_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      JEV_API_URL: jevApiUrl,
      JEV_API_KEY: "e2e-jev-key",
      JEV_MODEL: "jev-e2e-model",
      JEV_API_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const LOG_FILE = path.join(PKG_DIR, ".gateway.log");
  writeFileSync(LOG_FILE, "");
  const log = (chunk: string) => {
    output += chunk;
    appendFileSync(LOG_FILE, chunk);
  };
  child.stdout?.on("data", (d: Buffer) => log(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log(d.toString()));
  child.on("exit", (code, signal) => {
    log(`\n[gateway exited code=${code} signal=${signal}]\n`);
  });

  const baseUrl = `http://127.0.0.1:${GATEWAY_PORT}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (code ${child.exitCode}):\n${tail(output)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return { baseUrl, stop: () => stopChild(child, output) };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stopChild(child, "");
  throw new Error(`gateway did not become healthy within 90s:\n${tail(output)}`);
}

async function stopChild(child: ChildProcess, output: string): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 8_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode === null) child.kill("SIGKILL");
  void output;
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `...${s.slice(-n)}` : s;
}
