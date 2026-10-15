# 数据库 v2 重建升级

v2 不再包含历史迁移。`schema.ts` 是初始表结构，`schema_baseline` 标记数据库代际为 2，`schema_migrations` 从空记录开始，后续增量迁移从 1 编号。普通启动遇到旧库会拒绝运行，**不会自动清库**。

`packages/backend/scripts/upgrade.ts` 提供显式的 `export` / `rebuild` 两阶段升级。本工具只操作当前库的已知网关表，不删除整个目标数据库。

## 保留与清空

保留原 ID、密钥与关联：

- 用户账号及密码哈希：`users`
- 供应商和模型配置：`providers`、`models`
- 虚拟密钥：`virtual_keys`
- 普通路由与专家路由：`routing_configs`、`expert_routing_configs`
- 系统配置与成本映射：`system_config`、`cost_mappings`
- 插件及用户启用配置：`worker_plugins`、`user_plugin_enrollments`

请求日志、统计汇总、Prompt 样本、会话绑定、训练记录、熔断记录、备份恢复记录、Agent 快照与运行数据、告警已读状态全部清空。历史迁移记录和已退役的健康监控、意图分类日志、IP 封禁表也删除。

专家路由必须已经使用当前 v2 配置格式；禁用的空草稿和不带 band 的 fallback 可以保留。旧专家配置或不兼容字段会在清库前中止，**不自动猜测转换或静默丢弃**。

## 执行前

1. 停止所有网关副本、后台任务和其他写入进程，升级完成前不要重启。
2. 准备全量 SQL 备份。配置 JSON 不包含日志，也不是完整的数据库灾备文件：
   ```bash
   umask 077
   mysqldump --single-transaction --routines --triggers \
     -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p "$MYSQL_DATABASE" \
     > /private/path/gateway-full.sql
   ```
3. 在仓库根目录执行命令。CLI 从环境变量或 `.env` 读取 `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`，无需 `JWT_SECRET`。确认环境指向预期实例。
4. 重建前必须在随机命名的临时数据库完整演练建表与配置导入，因此升级账号需要临时库的 `CREATE/DROP DATABASE` 权限，以及目标表的读写和 DDL 权限。无权限时会中止，不跳过校验。

## 两阶段命令

```bash
# 导出配置；文件必须不存在，父目录需已创建且私有
node_modules/.bin/tsx packages/backend/scripts/upgrade.ts export \
  --file /private/path/gateway-v2-config.json

# 检查导出结果后，确认精确库名并重建恢复
node_modules/.bin/tsx packages/backend/scripts/upgrade.ts rebuild \
  --file /private/path/gateway-v2-config.json \
  --confirm-database llm_gateway \
  --service-stopped
```

JSON 备份包含供应商 API key、虚拟密钥明文和密码哈希。文件独占创建、权限 `0600`、写入后 fsync；不要提交到仓库或公开存储。全量 SQL 备份同样按密钥文件保管。

## 线上 Docker / Compose 升级

新构建的生产镜像包含 `dist/upgrade.js`，直接使用 Node 运行，不需要源码、tsx、Bun 或开发依赖。**此前已发布的旧镜像不包含该入口**；先发布或构建包含本次改动的 v2 镜像，并确保 export/rebuild 使用同一镜像版本。不要让新网关先连接旧库启动。

以下命令在 `compose/` 目录执行，假设使用仓库默认服务名和挂载路径。自定义库名时替换 `--confirm-database llm_gateway`；所有网关副本和其他写入进程都必须停止，但 MySQL 需保持运行。

```bash
# 提前准备包含 dist/upgrade.js 的新镜像；线上 latest 需已经发布本次改动
# 更推荐将 compose 中的 image 固定为已验证的版本或 digest
# docker compose pull llm-gateway

# 停网关，不要 down -v，也不要停 MySQL
# 多台主机部署时，在每台主机停止全部网关副本
docker compose stop llm-gateway

# 全量灾备放到宿主机私有目录；不把密码写进命令参数
install -d -m 700 "$HOME/gateway-v2-backup"
umask 077
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --single-transaction --routines --triggers --set-gtid-purged=OFF -uroot "$MYSQL_DATABASE"' \
  > "$HOME/gateway-v2-backup/full.sql"
# 确认上一条命令成功退出、备份非空，并按运维规范验证可恢复

# 镜像默认 nodejs UID/GID 为 1001；仅设置新备份目录，不递归修改既有 data
sudo install -d -m 700 -o 1001 -g 1001 ../data/upgrade

# 一次性容器继承 Compose 的 MYSQL_*、网络与 /app/data 挂载；不会启动网关
docker compose run --rm --no-deps llm-gateway \
  node dist/upgrade.js export --file /app/data/upgrade/gateway-v2-config.json

docker compose run --rm --no-deps llm-gateway \
  node dist/upgrade.js rebuild --file /app/data/upgrade/gateway-v2-config.json \
  --confirm-database llm_gateway --service-stopped

# 重建成功并验收配置后，再启动新版本网关
docker compose up -d --no-deps llm-gateway
```

Compose 默认的 MySQL root 账号具有临时库 `CREATE/DROP DATABASE` 权限；自定义最小权限账号可能不具备，需要运维事先配置权限。`JWT_SECRET` 保持原值，不要在此次升级时顺便轮换。`/app/data/upgrade` 必须是持久化卷内的私有目录，不能把备份留在 `--rm` 容器的临时文件系统。

线上导入重试同样使用一次性容器，在 rebuild 命令末尾增加 `--retry-restore`。发生 DDL 失败时使用全量 SQL 灾备恢复，不能仅靠配置 JSON 修复不完整表结构。

## 安全校验与执行顺序

清库前检查：

- 文件格式、摘要、表和列、专家路由配置、唯一键及关键引用。
- 备份记录的 host、port、database 与环境和实际连接库一致。
- 拒绝未知表、视图、跨库外键和触发器，避免误删外部业务或破坏依赖。
- 当前业务配置与备份摘要一致；导出后有配置变化则要求重新导出。
- 临时数据库完整执行基线、建表和事务导入，验证实际 MySQL 约束。失败时不触碰目标表。

通过后才暂时关闭外键检查、删除已知网关表，恢复外键检查，建立 v2 基线和表结构，再在单事务中按依赖顺序导入。导入失败回滚配置写入，但 **MySQL DDL 不可事务回滚**，旧日志和旧表不会自动恢复。

仅裁剪已知退役列：`providers.owner_node/owner_pop`、`models.protocol/supported_protocols/health_check_protocol`。旧模型声明的 Anthropic/Google 协议能力会先下沉至供应商 `protocol_mappings`；无法识别的协议会中止导出。

`--service-stopped` 是操作者声明，不会自动停止服务或锁住其他进程。必须自行保证升级期间没有并发写入。

## 故障恢复

- **表结构完整、配置导入失败**：修复权限、磁盘等原因后，仅向 v2 空业务表重试导入，不再删表：
  ```bash
  node_modules/.bin/tsx packages/backend/scripts/upgrade.ts rebuild \
    --file /private/path/gateway-v2-config.json \
    --confirm-database llm_gateway \
    --service-stopped --retry-restore
  ```
  此模式要求 v2 基线存在，所有保留的业务表为空；非空库拒绝操作。
- **DDL 失败、表结构不完整或需要回退旧版本**：使用升级前的全量 SQL 备份恢复，再排查问题。不要启动网关，也不要重新导出半成品空库覆盖原备份。
- **临时库清理失败或执行被中断**：临时库名称含 `_verify_`，可能包含敏感配置。核对名称后由管理员清理；工具会在清理失败时中止目标库重建。

完成后检查供应商、模型、路由、虚拟密钥和账号，再启动服务并验证真实调用。保留私有灾备文件直到验收完成。

## 验证范围

单元测试使用 mock 连接验证失败守卫和顺序。另外提供真实 Docker MySQL 集成测试，使用合成配置、随机容器/网络和独立数据库，不读取现有数据库，结束后清理本轮资源：

```bash
node_modules/.bin/tsx packages/backend/scripts/test-upgrade-docker.ts

# 使用 Dockerfile 构建的真实生产镜像，按默认 nodejs 用户运行打包入口
docker build -t llm-gateway:v2-upgrade-test .
node_modules/.bin/tsx packages/backend/scripts/test-upgrade-docker.ts \
  --image llm-gateway:v2-upgrade-test
```

已在 MySQL 8.0.46、Compose 的实际 `my.cnf` 下通过源码和生产镜像两条路径：10 张配置表完整恢复、19 张历史表为空、退役列清除、临时库清理、空库导入重试，以及库名错误、陈旧备份、真实 MySQL 字段长度不兼容等情况下拒绝清库。

集成测试的镜像模式仅在初始化和清理新建测试备份目录时临时使用容器 root 调整所有权；实际 export/rebuild 使用镜像默认非 root 用户。线上实际数据可能含测试夹具未覆盖的旧配置，首次升级仍应先在数据库副本演练。临时库演练不能替代全量灾备。
