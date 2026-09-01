# AGENTS.md

This file provides guidance for agentic coding agents working in this repository.

## Project Overview

LLM Gateway is a lightweight gateway management system for multiple LLM providers with a Web UI: virtual API keys, routing strategies (load balancing, fallback, hash-based, affinity), prompt management, expert routing, message compression, health monitoring, and real-time monitoring.

**Tech Stack:** Fastify (Node.js) + TypeScript + Bun backend · Vue 3 + Naive UI + Vite + Pinia frontend · MySQL with connection pooling · Monorepo workspaces: `packages/backend`, `packages/web`, `packages/shared`.

## Build Commands

```bash
bun run dev:all         # Start backend + frontend dev servers (repo root)
bun run build           # Build all packages
bun run typecheck       # Type check all packages
bun run lint            # Lint all packages (TSC / vue-tsc)
```

The same script names exist inside each package (`packages/backend`, `packages/web`, `packages/shared`); `cd` into the package to run them. Backend extras: `bun run dev` (Bun watch), `bun run dev:node` (tsx watch), `bun run fix:db` (DB migration/fix scripts). Web dev server runs on port 5173.

## Code Style

- TypeScript `strict: true` everywhere (`packages/tsconfig/base.json`); ES modules only — **always include the `.js` extension in relative import specifiers**.
- Domain types live in `packages/shared/src/types/`; validate runtime input with Zod (`packages/shared/src/types/index.ts`).
- Formatting: Prettier, config in `.prettierrc`; run `bunx prettier --write .`.
- Naming: API routes kebab-case (`/api/admin/providers`), DB tables snake_case (`api_requests`, `virtual_keys`); everything else follows existing code.
- API errors use the OpenAI-style envelope `{ "error": { "message", "type", "param", "code" } }`; reply via `reply.code(...).send({ error: ... })`.
- Logging: `memoryLogger` from `src/services/logger.js` — `memoryLogger.info(message, category)` with categories such as 'System', 'Proxy', 'ExpertRouter', 'Routing'; request logging uses Pino.
- Database: use the exported `*Db` objects from `packages/backend/src/db/index.js`; all operations are promises; use transactions for multi-table writes.
- Frontend: Composition API with `<script setup>`, Pinia stores, Naive UI components.

## Architecture

Request flow: `packages/backend/src/index.ts` (Fastify init) → `routes/proxy/` handlers (`/v1/chat/completions`, `/v1/messages`, ...) → `routes/proxy/auth.ts` (virtual key auth) → `model-resolver.ts` → `routing.ts` (strategies) → services.

Key services (`packages/backend/src/services/`): `expert-router.ts` (classification-based routing), `protocol-adapter.ts` (OpenAI/Anthropic/Google conversion), `message-compressor.ts` (history compression), `circuit-breaker.ts` + `health-checker.ts` (provider health).

DB schema: `packages/backend/src/db/schema.ts` — `users`, `providers`, `models`, `virtual_keys`, `routing_configs`, `api_requests` (buffered writes), `health_targets`/`health_runs`, `backup_records`/`restore_records`.

## Testing

No automated test suite. Manual loop: `bun run dev:all` → Web UI at http://localhost:5173 → configure providers/models/virtual keys → exercise API endpoints with virtual keys.

Debug request flow: `GET /api/admin/config/logs` (memory logs), `LOG_LEVEL=debug` in `.env`, live tail via `GET /api/admin/config/debug-stream`.

Adding a routing strategy: extend `RoutingConfig` in `routes/proxy/routing.ts` and implement it in `resolveProvider`.

## Environment

Copy `.env.example` to `.env`: configure `MYSQL_*`, set `JWT_SECRET` (min 32 chars). Optional: `PUBLIC_URL`, `PORT` (default 3000), `LOG_LEVEL`, `DEMO_MODE` (demo mode with auto-reset).
