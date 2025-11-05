FROM node:23-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci

COPY web/tsconfig*.json web/vite.config.ts web/index.html ./
COPY web/assets ./assets
COPY web/src ./src
RUN npm run build

FROM node:23-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY scripts ./scripts

RUN mkdir -p /app/data /app/portkey-config

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/gateway.db
ENV PORTKEY_CONFIG_PATH=/app/portkey-config/conf.json
ENV LOG_LEVEL=info

EXPOSE 3000

CMD ["node", "dist/index.js"]

