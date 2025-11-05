# LiteLLM 迁移实施检查清单

## 阶段一：准备工作 ✓

### 1.1 环境准备
- [ ] 创建新的 Git 分支 `feature/litellm-migration`
- [ ] 备份当前数据库
- [ ] 安装新依赖包
  ```bash
  npm install openai @anthropic-ai/sdk @google/generative-ai
  ```

### 1.2 代码准备
- [ ] 创建 `src/services/litellm-adapter.ts`
- [ ] 创建 `src/config/provider-mapping.ts`
- [ ] 创建测试文件 `src/services/__tests__/litellm-adapter.test.ts`

---

## 阶段二：核心功能迁移 ✓

### 2.1 LiteLLM Adapter 实现
- [ ] 实现 `LiteLLMAdapter` 类基础结构
- [ ] 实现 OpenAI 提供商支持
  - [ ] 非流式请求
  - [ ] 流式请求
- [ ] 实现 DeepSeek 提供商支持（复用 OpenAI SDK）
- [ ] 实现 Google/Gemini 提供商支持
- [ ] 实现 SDK 实例缓存机制
- [ ] 实现错误处理和重试逻辑

### 2.2 Provider Config Builder 重构
**文件**: `src/routes/proxy/provider-config-builder.ts`

- [ ] 移除 Portkey Gateway 选择逻辑
- [ ] 移除 `portkeyRouter.selectGateway()` 调用
- [ ] 移除 `x-portkey-config` 头构建
- [ ] 返回 `LiteLLMConfig` 对象而非 Portkey URL
- [ ] 更新函数签名和返回类型
- [ ] 更新单元测试

### 2.3 HTTP Client 重构
**文件**: `src/routes/proxy/http-client.ts`

- [ ] 移除原有的 HTTP 请求逻辑
- [ ] 导入 `litellmAdapter`
- [ ] 重构 `makeHttpRequest` 函数
  - [ ] 接收 `LiteLLMConfig` 参数
  - [ ] 调用 `litellmAdapter.chatCompletion()`
  - [ ] 返回标准化响应
- [ ] 重构 `makeStreamHttpRequest` 函数
  - [ ] 接收 `LiteLLMConfig` 参数
  - [ ] 调用 `litellmAdapter.streamChatCompletion()`
  - [ ] 处理流式响应
- [ ] 更新类型定义
- [ ] 更新单元测试

### 2.4 Proxy Handler 重构
**文件**: `src/routes/proxy/proxy-handler.ts`

- [ ] 更新 `buildProviderConfig` 调用
- [ ] 移除 `portkeyUrl` 相关逻辑
- [ ] 更新 `handleStreamRequest` 函数
  - [ ] 传递 `LiteLLMConfig` 而非 URL
  - [ ] 更新日志输出
- [ ] 更新 `handleNonStreamRequest` 函数
  - [ ] 传递 `LiteLLMConfig` 而非 URL
  - [ ] 更新日志输出
- [ ] 确保缓存逻辑正常工作
- [ ] 确保 Token 计数逻辑正常工作
- [ ] 更新单元测试

### 2.5 Provider Adapter 更新
**文件**: `src/services/provider-adapter.ts`

- [ ] 检查是否需要更新 Provider 标准化逻辑
- [ ] 确保与 LiteLLM Adapter 的兼容性
- [ ] 更新单元测试

---

## 阶段三：数据库清理 ✓

### 3.1 创建数据库迁移
**文件**: `src/db/migrations.ts`

- [ ] 添加新的迁移版本（version 3）
- [ ] 实现 `up` 函数
  - [ ] 删除 `model_routing_rules` 表
  - [ ] 删除 `portkey_gateways` 表
- [ ] 实现 `down` 函数（回滚逻辑）
- [ ] 测试迁移脚本

### 3.2 移除数据库操作代码
**文件**: `src/db/index.ts`

- [ ] 移除 `portkeyGatewayDb` 导出
- [ ] 移除 `modelRoutingRuleDb` 导出
- [ ] 移除相关的数据库操作函数
- [ ] 更新类型定义

### 3.3 移除后端路由
- [ ] 删除 `src/routes/portkey-gateways.ts`
- [ ] 删除 `src/routes/routing-rules.ts`
- [ ] 删除 `src/routes/agent.ts`
- [ ] 从 `src/index.ts` 中移除相关路由注册

### 3.4 移除服务代码
- [ ] 删除 `src/services/portkey-router.ts`
- [ ] 删除 `src/services/config-generator.ts`（如果仅用于 Portkey）
- [ ] 更新其他服务中的导入引用

### 3.5 移除 Agent 系统
- [ ] 删除 `agent/` 整个目录
- [ ] 从 `package.json` 中移除 Agent 构建脚本
- [ ] 从 `scripts/` 中移除 Agent 相关脚本

---

## 阶段四：前端调整 ✓

### 4.1 移除前端页面
- [ ] 删除 `web/src/views/PortkeyGateways.vue`
- [ ] 删除 `web/src/views/RoutingRules.vue`
- [ ] 删除 `web/src/api/portkey-gateways.ts`

### 4.2 更新路由配置
**文件**: `web/src/router/index.ts`

- [ ] 移除 Portkey Gateway 路由
- [ ] 移除 Routing Rules 路由
- [ ] 更新路由守卫（如有）

### 4.3 更新导航菜单
**文件**: `web/src/components/Layout.vue` 或类似文件

- [ ] 移除 "Portkey Gateways" 菜单项
- [ ] 移除 "Routing Rules" 菜单项
- [ ] 更新菜单顺序和分组

### 4.4 更新国际化文件
- [ ] 移除 `web/src/i18n/zh-CN.ts` 中的 Gateway 相关翻译
- [ ] 移除 `web/src/i18n/en-US.ts` 中的 Gateway 相关翻译

### 4.5 更新 Stores
- [ ] 检查 Pinia stores 中是否有 Gateway 相关状态
- [ ] 移除相关状态和 actions

---

## 阶段五：测试与验证 ✓

### 5.1 单元测试
- [ ] LiteLLM Adapter 单元测试
  - [ ] OpenAI 提供商测试
  - [ ] Anthropic 提供商测试
  - [ ] 格式转换测试
  - [ ] 错误处理测试
- [ ] Provider Config Builder 单元测试
- [ ] HTTP Client 单元测试
- [ ] Proxy Handler 单元测试

### 5.2 集成测试
- [ ] 虚拟密钥认证测试
- [ ] OpenAI 提供商端到端测试
  - [ ] 非流式请求
  - [ ] 流式请求
- [ ] Anthropic 提供商端到端测试
  - [ ] 非流式请求
  - [ ] 流式请求
- [ ] DeepSeek 提供商端到端测试
- [ ] 缓存功能测试
- [ ] Token 计数准确性测试
- [ ] Prompt 处理测试
- [ ] 专家路由测试

### 5.3 性能测试
- [ ] 响应延迟对比（迁移前后）
- [ ] 并发请求测试（100/500/1000 并发）
- [ ] 内存使用监控
- [ ] CPU 使用监控
- [ ] 长时间运行稳定性测试

### 5.4 错误处理测试
- [ ] 无效 API Key 测试
- [ ] 网络超时测试
- [ ] Provider 服务不可用测试
- [ ] 速率限制测试
- [ ] 格式错误请求测试

---

## 阶段六：文档更新 ✓

### 6.1 更新 README
- [ ] 移除 Portkey Gateway 相关描述
- [ ] 更新架构图
- [ ] 更新特性列表
- [ ] 更新快速开始指南
- [ ] 更新 Docker 部署说明

### 6.2 更新部署文档
- [ ] 更新 `docs/docker-deployment.md`
- [ ] 移除 Portkey Gateway 容器配置
- [ ] 更新环境变量说明
- [ ] 更新 docker-compose.yml

### 6.3 创建迁移指南
- [ ] 为现有用户创建迁移指南
- [ ] 说明数据迁移步骤
- [ ] 提供回滚方案

---

## 阶段七：部署准备 ✓

### 7.1 环境配置
- [ ] 更新生产环境 `.env` 文件
- [ ] 移除 `PORTKEY_GATEWAY_URL` 配置
- [ ] 添加 `USE_LITELLM=true` 配置
- [ ] 验证所有必需的环境变量

### 7.2 数据库迁移
- [ ] 在测试环境执行数据库迁移
- [ ] 验证迁移结果
- [ ] 准备生产环境迁移脚本
- [ ] 准备回滚脚本

### 7.3 Docker 镜像
- [ ] 更新 Dockerfile
- [ ] 移除 Portkey Gateway 相关配置
- [ ] 构建新的 Docker 镜像
- [ ] 测试 Docker 镜像

### 7.4 CI/CD 更新
- [ ] 更新 CI/CD 流程
- [ ] 移除 Agent 构建步骤
- [ ] 更新测试流程
- [ ] 更新部署流程

---

## 阶段八：上线与监控 ✓

### 8.1 灰度发布
- [ ] 在测试环境完整验证
- [ ] 选择部分用户进行灰度测试
- [ ] 监控错误率和性能指标
- [ ] 收集用户反馈

### 8.2 全量发布
- [ ] 执行数据库迁移
- [ ] 部署新版本代码
- [ ] 验证所有功能正常
- [ ] 监控系统指标

### 8.3 监控指标
- [ ] 请求成功率 > 99.9%
- [ ] 平均响应时间 < 2s
- [ ] P95 响应时间 < 5s
- [ ] 错误率 < 0.1%
- [ ] Token 计数准确率 > 99%

### 8.4 告警配置
- [ ] 配置错误率告警
- [ ] 配置响应时间告警
- [ ] 配置服务可用性告警
- [ ] 配置资源使用告警

---

## 回滚计划 ✓

### 如果需要回滚
1. [ ] 切换 `USE_LITELLM=false`
2. [ ] 回滚数据库迁移
3. [ ] 部署旧版本代码
4. [ ] 重启 Portkey Gateway 容器
5. [ ] 验证服务恢复正常

---

## 完成标准

所有以下条件满足时，迁移完成：

✅ 所有单元测试通过  
✅ 所有集成测试通过  
✅ 性能测试达标  
✅ 文档更新完成  
✅ 生产环境稳定运行 7 天  
✅ 无重大 Bug 报告  
✅ 用户反馈良好  

---

**预计总工时**: 8-13 个工作日  
**建议团队规模**: 2-3 人（1 后端 + 1 前端 + 1 测试）

