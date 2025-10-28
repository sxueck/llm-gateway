# MySQL 数据库迁移指南

## 概述

为了解决 SQLite (sql.js) 导致的高频磁盘写入问题，llm-gateway 已从 SQLite 迁移到 MySQL。

### 问题背景

使用 sql.js 时存在以下问题：
- 每 5 秒完整导出整个数据库到磁盘
- 高流量场景下，20 分钟可产生 10GB+ 磁盘写入
- 数据库越大，写入量越大
- 当前随着功能增加，部分场景 Sqlite 已经出现了瓶颈

### 解决方案

迁移到 MySQL 后：
- 仅在数据变更时进行增量写入
- 磁盘写入量降低 95% 以上
- 支持更大规模的数据存储

## 配置说明

### 环境变量

在 `.env` 文件中添加以下 MySQL 配置：

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=llm_gateway
```

### Docker Compose 配置

`docker-compose.yml` 已自动配置 MySQL 服务：

```yaml
services:
  mysql:
    image: mysql:8.0
    container_name: llm-gateway-mysql
    ports:
      - "3306:3306"
    volumes:
      - mysql-data:/var/lib/mysql
    environment:
      - MYSQL_ROOT_PASSWORD=${MYSQL_PASSWORD:-your-mysql-password}
      - MYSQL_DATABASE=${MYSQL_DATABASE:-llm_gateway}
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  llm-gateway:
    depends_on:
      mysql:
        condition: service_healthy
    environment:
      - MYSQL_HOST=mysql
      - MYSQL_PORT=3306
      - MYSQL_USER=root
      - MYSQL_PASSWORD=${MYSQL_PASSWORD:-your-mysql-password}
      - MYSQL_DATABASE=${MYSQL_DATABASE:-llm_gateway}
```

## 自动迁移

### 迁移流程

应用启动时会自动检测并迁移 SQLite 数据：

1. 检测 `./data/gateway.db` 是否存在
2. 检查 MySQL 数据库是否为空
3. 如果满足条件，自动执行迁移：
   - 读取 SQLite 中的所有表数据
   - 按正确顺序迁移到 MySQL（考虑外键依赖）
   - 使用批量插入优化性能（每批 100 条）
   - 迁移成功后备份 SQLite 文件到 `./data/backup/gateway.db.backup.{timestamp}`

### 迁移的表

按以下顺序迁移：

1. `users` - 用户表
2. `providers` - 提供商表
3. `models` - 模型表
4. `virtual_keys` - 虚拟密钥表
5. `routing_configs` - 路由配置表
6. `portkey_gateways` - Portkey 网关表
7. `model_routing_rules` - 模型路由规则表
8. `expert_routing_configs` - 专家路由配置表
9. `api_requests` - API 请求日志表
10. `expert_routing_logs` - 专家路由日志表
11. `system_config` - 系统配置表

### 迁移日志

迁移过程中会输出详细日志：

```
[Migration] 检测到 SQLite 数据库文件，开始迁移到 MySQL...
[Migration] 迁移进度: users (100/100)
[Migration] 迁移进度: providers (50/50)
[Migration] 迁移进度: models (200/200)
...
[Migration] 数据迁移成功: 已迁移 11 个表，共 1234 条记录
[Migration] 已迁移的表: users, providers, models, virtual_keys, ...
[Migration] SQLite 文件已备份到: ./data/backup/gateway.db.backup.1234567890
```

## 手动迁移

如果需要手动迁移，可以使用以下步骤：

### 1. 启动 MySQL 服务

```bash
docker-compose up -d mysql
```

### 2. 配置环境变量

确保 `.env` 文件中的 MySQL 配置正确。

### 3. 启动应用

```bash
npm start
```

应用会自动检测并执行迁移。

## 回滚到 SQLite

如果需要回滚到 SQLite：

### 1. 停止应用

```bash
docker-compose down
```

### 2. 恢复备份

```bash
cp ./data/backup/gateway.db.backup.{timestamp} ./data/gateway.db
```

### 3. 切换到 SQLite 版本

```bash
mv src/db/index.ts src/db/index.ts.mysql
mv src/db/index.ts.sqlite src/db/index.ts
```

### 4. 重新构建并启动

```bash
npm run build
docker-compose up -d
```

## 注意事项

1. **备份重要**：迁移前请确保已备份 SQLite 数据库文件
2. **磁盘空间**：确保有足够的磁盘空间存储 MySQL 数据
3. **网络连接**：确保应用能够连接到 MySQL 服务
4. **密码安全**：生产环境请使用强密码
5. **数据一致性**：迁移过程使用事务，确保数据一致性

### 迁移失败

如果迁移失败：

```
[Migration] 数据迁移失败: ...
```

检查：
1. MySQL 数据库是否为空
2. SQLite 文件是否损坏
3. 磁盘空间是否充足

可以手动清空 MySQL 数据库后重试：

```sql
DROP DATABASE llm_gateway;
CREATE DATABASE llm_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 外键约束错误

如果出现外键约束错误，检查：
1. 表迁移顺序是否正确
2. 数据完整性是否有问题

## 技术细节

### 数据库引擎

- 使用 InnoDB 引擎
- 字符集：utf8mb4
- 排序规则：utf8mb4_unicode_ci

### 连接池配置

```typescript
{
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
}
```

### 批量插入

迁移时使用批量插入优化性能：
- 批量大小：100 条/批
- 使用事务确保原子性
- 禁用外键检查加速插入

## 支持

如有问题，请提交 Issue 或查看项目文档。

