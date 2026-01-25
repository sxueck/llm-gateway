FROM ubuntu:24.04 AS bun-base

ARG DEBIAN_FRONTEND=noninteractive
ARG BUN_VERSION=1.3.5
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  unzip \
  tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/opt/bun

RUN set -eux; \
  arch="${TARGETARCH:-}"; \
  if [ -z "$arch" ]; then arch="$(dpkg --print-architecture)"; fi; \
  case "$arch" in \
    amd64) bun_zip="bun-linux-x64-baseline.zip" ;; \
    arm64) bun_zip="bun-linux-aarch64.zip" ;; \
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_zip}" -o /tmp/bun.zip; \
  unzip -q /tmp/bun.zip -d /tmp; \
  bun_dir="$(ls -d /tmp/bun-* | head -n 1)"; \
  test -n "$bun_dir"; \
  mkdir -p "$BUN_INSTALL"; \
  cp -a "$bun_dir"/* "$BUN_INSTALL"/; \
  ln -sf "$BUN_INSTALL/bun" /usr/local/bin/bun; \
  if [ -f "$BUN_INSTALL/bunx" ]; then ln -sf "$BUN_INSTALL/bunx" /usr/local/bin/bunx; else ln -sf "$BUN_INSTALL/bun" /usr/local/bin/bunx; fi; \
  rm -rf /tmp/bun.zip "$bun_dir"

FROM bun-base AS deps

WORKDIR /app

COPY package.json bunfig.toml bun.lock* ./
COPY packages ./packages

RUN bun ci --frozen-lockfile

FROM bun-base AS web-builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

COPY package.json bunfig.toml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

WORKDIR /app/packages/web
RUN bun run build

FROM bun-base AS backend-builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules

COPY package.json bunfig.toml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

WORKDIR /app/packages/backend
RUN bun run build

FROM bun-base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  docker.io \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 --system nodejs && \
  useradd --uid 1001 --gid 1001 --system --create-home --home-dir /home/nodejs --shell /usr/sbin/nologin nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules

COPY --from=backend-builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=backend-builder /app/packages/backend/package.json ./packages/backend/
COPY --from=web-builder /app/packages/web/dist ./packages/backend/public

COPY scripts ./scripts

RUN mkdir -p /app/data /app/portkey-config

ENV NODE_ENV=production \
  PORT=3000 \
  DB_PATH=/app/data/gateway.db \
  PORTKEY_CONFIG_PATH=/app/portkey-config/conf.json \
  LOG_LEVEL=info

RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --version || exit 1

WORKDIR /app/packages/backend
CMD ["bun", "run", "dist/index.js"]
