# 多阶段构建 - 基于 Bun

# ========================
# Stage 1: 依赖安装
# ========================
FROM oven/bun:1.3.5-alpine AS deps

WORKDIR /app

# 复制 workspace 配置
COPY package.json bunfig.toml bun.lock* ./
COPY packages ./packages

# 安装所有依赖
RUN bun ci --frozen-lockfile

# ========================
# Stage 2: 前端构建
# ========================
FROM oven/bun:1.3.5-alpine AS web-builder

WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

# 复制 workspace 配置
COPY package.json bunfig.toml ./

# 复制 tsconfig 配置（web 需要 vue.json，shared 需要 node.json）
COPY packages/tsconfig ./packages/tsconfig

# 复制 shared 包
COPY packages/shared ./packages/shared

# 复制前端源码
COPY packages/web ./packages/web

# 构建前端
WORKDIR /app/packages/web
RUN bun run build

# ========================
# Stage 3: 后端构建
# ========================
FROM oven/bun:1.3.5-alpine AS backend-builder

WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules

# 复制 workspace 配置
COPY package.json bunfig.toml ./

# 复制 tsconfig 配置（backend 需要 node.json，shared 也需要 node.json）
COPY packages/tsconfig ./packages/tsconfig

# 复制 shared 包
COPY packages/shared ./packages/shared

# 复制后端源码
COPY packages/backend ./packages/backend

# 构建后端
WORKDIR /app/packages/backend
RUN bun run build

# ========================
# Stage 4: 生产运行环境
# ========================
FROM oven/bun:1.3.5-alpine

WORKDIR /app

# 安装必要的运行时依赖
RUN apk add --no-cache \
  ca-certificates \
  tzdata \
  docker-cli

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
  adduser -S nodejs -u 1001

# 复制依赖（仅生产依赖）
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules

# 复制后端构建产物
COPY --from=backend-builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=backend-builder /app/packages/backend/package.json ./packages/backend/

# 复制前端构建产物到后端静态目录
COPY --from=web-builder /app/packages/web/dist ./packages/backend/public

# 复制其他必要文件
COPY scripts ./scripts

# 创建数据目录
RUN mkdir -p /app/data /app/portkey-config

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/gateway.db
ENV PORTKEY_CONFIG_PATH=/app/portkey-config/conf.json
ENV LOG_LEVEL=info

# 设置权限
RUN chown -R nodejs:nodejs /app

# 切换到非 root 用户
USER nodejs

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --version || exit 1

# 启动应用
WORKDIR /app/packages/backend
CMD ["bun", "run", "dist/index.js"]
