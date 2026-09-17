# 多阶段构建：esbuild 产出单文件自包含 bundle，运行时镜像无 node_modules。
# 非 root、无 Docker socket、无宿主目录挂载；workspace 与 run 目录由 gateway 只读挂载。

FROM oven/bun:1.2.14 AS build

WORKDIR /app

# 先拷 manifests 以命中依赖缓存层
COPY package.json bunfig.toml bun.lock* ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/worker/package.json ./packages/worker/package.json
COPY packages/tsconfig ./packages/tsconfig
COPY scripts/install-hooks.sh ./scripts/install-hooks.sh
RUN bun install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker

RUN bun run --cwd=packages/worker build

FROM node:22-alpine

# ripgrep：grep_search 工具的运行时依赖（以参数数组 spawn，无 shell）
RUN apk add --no-cache ripgrep \
 && addgroup -S worker && adduser -S worker -G worker
WORKDIR /app

COPY --from=build /app/packages/worker/dist/index.js /app/index.js

USER worker
ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/index.js"]
