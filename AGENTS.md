# AGENTS.md

Guidance for coding agents working in this repository.

## Overview

LLM Gateway: a multi-provider LLM gateway with a Web UI — virtual API keys, routing strategies (load balancing, fallback, hash, affinity), prompt management, expert routing, message compression, a model Playground, worker (craft-agent) runs, and cost/traffic monitoring.

**Stack:** Fastify + TypeScript backend · Vue 3 + Naive UI + Pinia + Vite frontend · MySQL (pooled) · workspaces `packages/backend`, `packages/web`, `packages/shared`, `packages/worker` (`@llm-gateway/craft-worker`).

## Commands

Run from the repo root with **npm** — the root scripts are themselves `npm run … --workspaces`, so invoking them through bun makes them re-expand forever (`bun run lint` never terminates; `bun run dev:all`/`typecheck` are the two that do work). Package binaries are in the root `node_modules/.bin`.

```bash
npm run dev:all         # backend + web dev servers (bun only)
npm run dev:backend     # tsx watch, port 3000        npm run dev:web -> vite, port 5173
npm run build           # all packages (backend bundles with esbuild)
npm run typecheck       # all packages (bun --cwd under the hood)
npm run lint            # all packages — this IS the typecheck (tsc / vue-tsc), no linter configured
npm test --workspaces --if-present          # backend + worker vitest suites
node_modules/.bin/vitest run --root packages/web              # web suites (no test script)
node_modules/.bin/vitest run --root packages/backend <file>   # single test file
```

Per-package script names match these (`cd packages/backend && npm run test`). `cd packages/web && npm run check:i18n` verifies every `t()` key resolves in both locales. A `pre-commit` hook runs `scripts/pre-commit-secret-scan.sh`.

## Code rules

- TypeScript `strict: true`; ESM only — **relative import specifiers must end in `.js`**, also for `.ts` sources.
- Shared domain types and request validation (Zod) live in `packages/shared/src/types/`.
- **No formatter or linter is configured** (backend uses double quotes, web single — deliberately). Match the file's local style; never run a global `--write` format pass or reformat untouched lines.
- API errors use the OpenAI envelope `{ "error": { "message", "type", "param", "code" } }` via `reply.code(...).send({ error })`; log with `memoryLogger.info(message, category)` from `services/logger.js` (HTTP request logging is Pino).
- Data access goes through the promise-based `*Db` repositories exported from `packages/backend/src/db/index.js`; multi-table writes use a transaction.
- Frontend: `<script setup>` + Pinia + Naive UI; user-visible strings go through `t('...')` in **both** `i18n/locales/{zh-CN,en-US}.ts`; page titles use `components/PageHeader.vue`.
- Any schema change needs a `db/schema.ts` edit **and** a new idempotent migration appended to `db/migrations.ts` (bump `db/migrations.test.ts`); startup applies migrations automatically.

## Architecture

Proxy flow: `packages/backend/src/index.ts` (Fastify init + route registration) → `routes/proxy/` handlers (`/v1/chat/completions`, `/v1/messages`, …) → `routes/proxy/auth.ts` (virtual-key auth) → `routes/proxy/model-resolver.ts` → `routes/proxy/routing.ts` (strategy resolution via `resolveProviderFromModel`) → services.

Key services (`packages/backend/src/services/`): `expert-router.ts` (classification-based routing), `protocol-adapter.ts` (OpenAI/Anthropic/Google conversion), `message-compressor.ts` (history compression), `circuit-breaker.ts` (provider health), `agent-classifier.ts` + `agent-metrics.ts` (traffic attribution), `playground-metrics.ts`.

Worker runs: `routes/agent/` (run API + internal loopback to `/v1`); one Docker container per run launched through dockerode; the plugin manifest pins a `model_policy.profile` that must exist as an enabled row in `models`.

Schema: `packages/backend/src/db/schema.ts` — `users`, `providers`, `models`, `virtual_keys`, `routing_configs`, `api_requests` (buffered writes), `agent_search_runs`/`agent_search_usage`, `backup_records`/`restore_records`.

## Testing

Vitest covers backend, worker and web; there is no browser/E2E layer, so UI changes still need the manual loop: start the dev servers → http://localhost:5173 → configure providers/models/virtual keys → call `/v1/*` with a virtual key. Debug the request flow with `GET /api/admin/config/logs` or `LOG_LEVEL=debug`.

Adding a routing strategy: extend `RoutingConfig` in `routes/proxy/routing.ts` and implement the selection in `resolveProviderFromModel`.

## Environment

Copy `.env.example` to `.env`: `MYSQL_*`, `JWT_SECRET` (min 32 chars). Optional: `PORT` (3000), `PUBLIC_URL`, `LOG_LEVEL`, `GEO_IP_ENABLED`. Backend tests that import `config` need these injected (see `vi.hoisted` usage in `routes/agent/monitoring.test.ts`) or they fail at collect time.
