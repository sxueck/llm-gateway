FROM node:22-slim AS node-runtime

FROM node-runtime AS bun-base

ARG DEBIAN_FRONTEND=noninteractive
ARG BUN_VERSION=1.3.5
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  unzip \
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
  rm -rf /tmp/bun.zip "$bun_dir"

RUN ln -sf /opt/bun/bun /usr/local/bin/bun && \
  if [ -f /opt/bun/bunx ]; then ln -sf /opt/bun/bunx /usr/local/bin/bunx; else ln -sf /opt/bun/bun /usr/local/bin/bunx; fi

FROM bun-base AS workspace-manifests

WORKDIR /app

COPY package.json bunfig.toml bun.lock* ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/tsconfig ./packages/tsconfig
COPY scripts/install-hooks.sh ./scripts/install-hooks.sh

FROM workspace-manifests AS deps

RUN bun install --frozen-lockfile

FROM workspace-manifests AS backend-prod-deps

RUN bun install --frozen-lockfile --production --filter @llm-gateway/backend

FROM bun-base AS web-builder

WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bunfig.toml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

RUN bun run --cwd=packages/web build

FROM bun-base AS backend-builder

WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bunfig.toml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

RUN bun run --cwd=packages/backend build

# Pinned local ONNX classifier artifacts (~615MB). Downloaded from the exact HF
# revision at image build time so the production container is self-contained —
# runtime downloads from mutable `main` are prohibited (NFR-1).
FROM bun-base AS model-assets

WORKDIR /build
COPY packages/backend/scripts/download-onnx-model.ts ./
RUN bun download-onnx-model.ts

FROM node-runtime

WORKDIR /app

# libgomp1 is required by the ONNX Runtime CPU shared library on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 --system nodejs && \
  useradd --uid 1001 --gid 1001 --system --create-home --home-dir /home/nodejs --shell /usr/sbin/nologin nodejs && \
  install -d -o nodejs -g nodejs /app/data

COPY --from=backend-prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules

COPY --from=backend-builder --chown=nodejs:nodejs /app/packages/backend/dist ./packages/backend/dist
COPY --from=web-builder --chown=nodejs:nodejs /app/packages/web/dist ./packages/backend/public
COPY --from=model-assets --chown=nodejs:nodejs /build/model-assets ./packages/backend/model-assets

COPY --chown=nodejs:nodejs scripts ./scripts

ENV NODE_ENV=production \
  PORT=3000 \
  LOG_LEVEL=info

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node --version || exit 1

WORKDIR /app/packages/backend
CMD ["node", "dist/index.js"]
