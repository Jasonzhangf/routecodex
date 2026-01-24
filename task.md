# RouteCodex + llmswitch-core 风控增强任务

## 任务概述

基于 gcli2api 的实践经验，对 RouteCodex 和 llmswitch-core 进行风控增强，降低被上游 API 识别和封禁的风险。

## 架构原则

- **协议级风控** → llmswitch-core（协议转换、验证、清理）
- **传输级风控** → RouteCodex Provider V2（HTTP 请求头、错误记录、配额信息上报）
- **路由级风控** → RouteCodex VirtualRouter（封禁决策、健康检查、配额视图管理）
- **配置级风控** → RouteCodex（全局策略配置）
- **Quota 管理核心** → llmswitch-core `ProviderQuotaView` 接口（由 Host 注入，VirtualRouter 使用）

---

## 任务清单

### 14. CI 基线（PR 必跑）+ 覆盖率增强（从最小集合开始）
- **位置**: `sharedmodule/.github/workflows/llmswitch-core-ci.yml` + `routecodex/.github/workflows/test.yml` + `jest.config.js`
- **优先级**: 高
- **状态**: 🟡 进行中
- **目标**:
  - PR 必跑：llmswitch-core `npm run verif`（matrix）必须作为 PR 检查项
  - RouteCodex CI 走 release 路径：npm 安装的 `@jsonstudio/llms`（不走本地 symlink）
  - 覆盖率从“CI 测试集”起步，逐步扩大到全量测试
  - 任何 CI/测试产物不入 git（`dist/`、`coverage/`、`test-results/`、`*.tgz` 等）
- **已完成**:
  - [x] 新增 sharedmodule PR workflow：llmswitch-core `npm ci` + `npm run verif`：`sharedmodule/.github/workflows/llmswitch-core-ci.yml`
  - [x] RouteCodex 基线 coverage 盘点（按 `test:ci:coverage` 的 jest 集合）：当前 lines/branches/functions/statements 约 27.8%/23.3%/29.5%/27.4%
  - [x] 仓库卫生：根目录禁止 ad-hoc 文件（md/test/debug/pid/cache），CI 增加 `verify:repo-sanity`（PR 必跑）：`.github/workflows/test.yml` + `scripts/ci/repo-sanity.mjs`
  - [x] 扩大 CI jest 测试集（仍保持 deterministic / 无外网）：`scripts/tests/ci-jest.mjs`
- **仍需你拍板**（GitHub 设置侧，代码无法强制）:
  - [ ] 分支保护规则：将 `llmswitch-core-ci` 标记为 Required status checks（PR 必过）
- **待落地/进行中**:
  - [x] RouteCodex CI 新增 `test:ci` + `test:ci:coverage`（先覆盖 CI 测试集）：`package.json` + `scripts/tests/ci-jest.mjs`
  - [x] 在 `.github/workflows/test.yml` 增加 coverage job（PR 必跑）：`.github/workflows/test.yml`
  - [ ] CI 测试集 re-enable：`@jsonstudio/llms` 仍停留在 npm `0.6.1172`，因此 release CI 暂不包含依赖新 llmswitch-core 行为的 servertool/sharedmodule 测试（待 llms 发布后再纳入）
  - [ ] 修复当前阻塞“全量 coverage”的单测（`tests/servertool/virtual-router-quota-routing.spec.ts`）或拆分为 nightly

### 13. Chat Process 协议与流水线契约（processMode=chat）
- **位置**: `docs/CHAT_PROCESS_PROTOCOL_AND_PIPELINE.md` + `docs/chat-semantic-expansion-plan.md` + `sharedmodule/llmswitch-core/src/conversion/hub/**` + `src/client/**` + `src/server/handlers/**`
- **优先级**: 高
- **状态**: ✅ 已完成（待你审阅）
- **目标不变量**（processMode=chat）:
  - 请求/响应都严格走 `inbound → (chat extension shape) → chat_process → outbound`
  - 进入 chat_process 前必须完成**强制语义映射**；可映射语义不得滞留在 `metadata`
  - 响应侧进入 chat_process 前必须是 canonical chat completion（`choices[0].message` 存在）
  - 内部环境注入字段统一 `__*` 前缀，并在 provider/client 边界统一剥离 `__*`
- **已完成**:
  - [x] 文档：统一术语/不变量/阶段命名提案与修改点：`docs/CHAT_PROCESS_PROTOCOL_AND_PIPELINE.md`
  - [x] 文档：语义扩展计划与口径收敛：`docs/chat-semantic-expansion-plan.md`
  - [x] E1：在 provider/client 边界剥离所有 `__*`（host side）：`src/utils/strip-internal-keys.ts` + `src/client/**` + `src/server/handlers/handler-utils.ts`
  - [x] 修复 `/v1/responses` 常规请求不携带 `responsesResume`（避免触发 semantic gate）：`src/server/handlers/responses-handler.ts`
  - [x] A1（第一版）：协议扫描并列出“可映射语义键”清单（以具体键枚举为策略）：`docs/CHAT_PROCESS_PROTOCOL_AND_PIPELINE.md` 3.2
  - [x] A1（第一版）：请求侧 chat_process entry 的 fail-fast gate（禁入键枚举）：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
  - [x] C：响应侧在 servertool orchestration 后强制 canonicalize（hard gate）+ resp_process 兜底归一（best-effort）：`sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` + `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts`
  - [x] D：chat_process 范围 stageId 改为点分风格（仅 stageRecorder/snapshot key）：`sharedmodule/llmswitch-core/src/conversion/hub/**`
  - [x] 修复 request outbound format_build 调错函数（buildResponse → buildRequest），避免 tools 等字段在请求侧丢失：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_outbound/req_outbound_stage2_format_build/index.ts`
  - [x] 请求侧：将 `requestSemantics` 作为响应转换的唯一语义载体（不塞 metadata）：`src/server/runtime/http-server/request-executor.ts`
  - [x] E1（落地到实现）：内部 runtime/env 注入统一迁移到 `metadata.__rt`，并在 provider/client 边界剥离 `__*`（含 `__rt`）
  - [x] Host：补齐所有响应转换入口都传递 `requestSemantics`（与 request-executor 口径一致）：`src/server/runtime/http-server/index.ts` + `src/server/runtime/http-server/request-executor.ts`
  - [x] 文档：修正 llmswitch-core stage README 对 `responsesContext` 的 legacy 叫法，统一以 `ChatEnvelope.semantics.responses.*` 为语义载体
  - [x] 移除响应侧“文本工具标记 → tool_calls”兜底提升（不掩盖上游问题；仅对结构化 tool_calls 做 canonicalize）：`sharedmodule/llmswitch-core/src/filters/special/response-tool-text-canonicalize.ts`
  - [x] Matrix：停用 text-markup uplift 相关用例（保留文件但不作为默认验证路径）：`sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs`
  - [x] 验证链：`sharedmodule/llmswitch-core` build（matrix）+ host `npm run build:dev`（含 `install:global`）通过
- **待落地/验证**:（无）

### 15. Antigravity 端点级联（transport）+ 上游错误信号收集
- **位置**: `src/providers/core/runtime/http-request-executor.ts` + `src/providers/core/runtime/http-transport-provider.ts` + `src/providers/core/runtime/gemini-cli-http-provider.ts` + `src/providers/core/utils/http-client.ts` + `src/providers/auth/antigravity-userinfo-helper.ts`
- **优先级**: 高
- **状态**: 🟡 进行中
- **目标**:
  - Transport 层支持 baseUrl 级联尝试（默认顺序：daily → autopush → prod），并在 Antigravity 下优先“切 baseUrl 再切 alias”
  - baseUrl 级联触发条件（Antigravity）：网络/timeout/5xx/403/404 + 429/400
  - 捕获并保留上游响应头（用于诊断/策略），尤其是 `x-antigravity-context-error`（仅用于内部决策；不透传到 client）
- **已完成**:
  - [x] Provider 请求执行器支持多 baseUrl 目标（不改 payload 语义）：`src/providers/core/runtime/http-request-executor.ts`
  - [x] Provider Runtime 允许下发 baseUrl candidates（默认无；仅 antigravity 运行时覆写）：`src/providers/core/runtime/http-transport-provider.ts` + `src/providers/core/runtime/gemini-cli-http-provider.ts`
  - [x] HttpClient 错误路径补齐响应头捕获，并放入 ProviderError.details.response.headers：`src/providers/core/utils/http-client.ts`
  - [x] Antigravity baseUrl candidates helper（含 env 覆写）：`src/providers/auth/antigravity-userinfo-helper.ts`
  - [x] 决策已确认：Antigravity 下遇到 429/400 时，优先尝试切 baseUrl（用尽 candidates 后再交由路由层处理 alias/retry）：`src/providers/core/runtime/http-request-executor.ts`

### 16. 工具 schema 清洗（Gemini functionDeclarations）
- **位置**: `sharedmodule/llmswitch-core/src/conversion/shared/gemini-tool-utils.ts`
- **优先级**: 高
- **状态**: 🟡 进行中
- **目标**:
  - 更贴近上游 functionDeclarations.parameters 的可接受子集（const→enum、丢弃不支持关键字、组合器收敛）
- **已完成**:
  - [x] cloneParameters 增强（const→enum + 额外 unsupported key 丢弃）：`sharedmodule/llmswitch-core/src/conversion/shared/gemini-tool-utils.ts`

### 17. Reasoning/Thinking 块策略（Claude via Antigravity）
- **位置**: `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.ts`
- **优先级**: 中
- **状态**: 🟡 进行中
- **目标**:
  - 默认对 antigravity.* + claude-* 的 outbound 文本去除 `<think>/<reflection>`（除非用户显式 opt-in）
- **已完成**:
  - [x] 在 gemini mapper 侧对特定路径启用 reasoning tag strip（`keep_thinking`/`keep_reasoning` 可 opt-in）：`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.ts`

### 12. 安装说明 + 参考配置 + rcc init（本轮）
- **位置**: `src/cli/commands/config.ts` + `src/cli/commands/*` + `docs/*` + `configsamples/*`
- **优先级**: 高
- **状态**: ✅ 已完成
- **子任务**:
  - [x] 新增脱敏参考配置：`configsamples/config.reference.json`
  - [x] `rcc init`（或 `rcc config init`）交互式选择 provider 并生成 `~/.routecodex/config.json`
  - [x] 文档：安装/启动（npm）、端口说明、provider 类型说明、内置 provider 配置说明
  - [x] 文档：`<****>` 指令语法说明（含 stopMessage / clock）
  - [x] 文档：Codex（`~/.codex/config.toml` 的 tc/tcm 示例）与 Claude Code（`rcc code`）使用说明
  - [x] 单测：覆盖 init 生成逻辑与 CLI 行为（coverage（selected files）≥ 90%）
  - [x] 回归：`npm run build:dev`（含 install:global）通过
  - [x] `rcc init` 复制内置文档到 `~/.routecodex/docs`

### 1. Claude thoughtSignature 验证增强
- **位置**: `sharedmodule/llmswitch-core/src/conversion/shared/reasoning-normalizer.ts`
- **优先级**: 高
- **状态**: ✅ 已完成
- **描述**:
  - 创建 `thought-signature-validator.ts` 模块
  - 实现 `hasValidThoughtSignature` 函数（最小 10 个字符验证）
  - 实现 `sanitizeThinkingBlock` 函数
  - 实现 `filterInvalidThinkingBlocks` 和 `removeTrailingUnsignedThinkingBlocks` 函数
  - 在 `reasoning-normalizer.ts` 中集成验证逻辑
- **参考**: gcli2api `src/converter/anthropic2gemini.py:32-93`

### 2. 工具调用 ID 风格统一管理
- **位置**: `sharedmodule/llmswitch-core/src/conversion/shared/tool-call-id-manager.ts`
- **优先级**: 高
- **状态**: ✅ 已完成
- **描述**:
  - 创建 `ToolCallIdManager` 类
  - 支持 'fc' 和 'preserve' 两种 ID 风格
  - 提供 `generateId`、`normalizeId`、`normalizeIds` 方法
  - 导出 `createToolCallIdTransformer` 和 `enforceToolCallIdStyle` 函数
- **参考**: gcli2api 工具调用 ID 管理

### 3. 实时封禁增强
- **位置**: `routecodex/src/providers/core/utils/provider-error-reporter.ts`
- **优先级**: 高
- **状态**: ✅ 已完成
- **描述**:
  - 集成 `risk-control-config.ts` 到 `emitProviderError` 函数
  - 通过 `ProviderQuotaView` 接口管理封禁状态
  - 在 `details` 中添加风控相关参数（`shouldBan`、`cooldownMs` 等）
  - 不实现独立的错误码追踪系统，完全依赖 llmswitch-core
- **参考**: llmswitch-core `ProviderQuotaView` 接口

### 4. 封禁策略配置
- **位置**: `routecodex/src/config/risk-control-config.ts`
- **优先级**: 高
- **状态**: ✅ 已完成
- **描述**:
  - 创建 `RiskControlConfig` 接口
  - 支持 `BanErrorCodesConfig`、`RetryConfig`、`CooldownConfig`
  - 支持环境变量配置（`AUTO_BAN_ENABLED`、`AUTO_BAN_ERROR_CODES` 等）
  - 提供 `shouldBanByErrorCode` 和 `computeCooldownMs` 函数
- **参考**: gcli2api `config.py` 中的风控配置

### 5. 请求头增强
- **位置**: `routecodex/src/providers/core/runtime/http-transport-provider.ts`
- **优先级**: 中
- **状态**: ✅ 已完成
- **描述**:
  - 为 Gemini/Antigravity provider 添加模拟请求头
  - 添加 `X-Goog-Api-Client` 头部
  - 添加 `Client-Metadata` 头部（包含 ideType、platform、pluginType）
  - 添加 `requestType` 和 `requestId` 头部
  - 添加 `Accept-Encoding: gzip, deflate, br` 头部
- **参考**: gcli2api `src/api/antigravity.py:60-75`

### 6. Thinking 块清理策略优化
- **位置**: `sharedmodule/llmswitch-core/src/conversion/shared/reasoning-normalizer.ts`
- **优先级**: 中
- **状态**: ✅ 已完成
- **描述**:
  - 在 `reasoning-normalizer.ts` 中集成 `filterInvalidThinkingBlocks`
  - 在 `normalizeAnthropicMessage` 中应用验证逻辑
  - 清理无效签名的 thinking 块
  - 保留有效签名的 thinking 块
- **参考**: gcli2api `src/converter/anthropic2gemini.py:125-183`

### 7. 调试请求转储功能
- **位置**: `routecodex/src/providers/core/utils/http-client.ts`
- **优先级**: 低
- **状态**: ✅ 已完成（已存在）
- **描述**:
  - 通过 `ROUTECODEX_DEBUG_ANTIGRAVITY` 环境变量启用
  - 转储请求到 `~/antigravity-rc-http.json`
  - 记录 url、method、headers、body
- **参考**: gcli2api `src/api/antigravity.py:30-56`

### 8. 配额重置时间戳解析
- **位置**: `routecodex/src/providers/core/runtime/rate-limit-manager.ts`
- **优先级**: 中
- **状态**: ✅ 已完成（已存在）
- **描述**:
  - `extractQuotaResetDelayWithSource` 函数已存在
  - 支持 `quotaResetDelay`、`X-RateLimit-Reset`、`retry-after` 头部解析
  - 返回 `delayMs` 和 `source` 信息
- **参考**: gcli2api `src/api/utils.py:426-467`

### 9. 流式响应心跳机制
- **位置**: `routecodex/src/providers/core/utils/http-client.ts`
- **优先级**: 低
- **状态**: ✅ 已完成（已存在）
- **描述**:
  - 通过 `idleTimeoutMs` 参数配置空闲超时
  - 在 `wrapStreamWithTimeouts` 中实现空闲检测
  - 超时后自动终止流式响应
- **参考**: gcli2api `src/converter/fake_stream.py:344-356`

### 10. 工具参数修复增强
- **位置**: `sharedmodule/llmswitch-core/src/conversion/shared/tool-argument-repairer.ts`
- **优先级**: 中
- **状态**: ✅ 已完成
- **描述**:
  - 创建 `ToolArgumentRepairer` 类
  - 实现 `repairToString`、`repairJsonString`、`validateAndRepair` 方法
  - 修复常见问题（单引号、缺失引号、格式错误）
  - 导出 `repairToolArguments` 和 `validateToolArguments` 快捷函数
- **参考**: gcli2api 工具参数修复逻辑

### 11. 配置驱动的风控策略
- **位置**: `routecodex/src/config/risk-control-config.ts` + `routecodex/src/providers/core/utils/provider-error-reporter.ts`
- **优先级**: 中
- **状态**: ✅ 已完成
- **描述**:
  - 在 `risk-control-config.ts` 中定义配置接口
  - 支持环境变量配置（`AUTO_BAN_ENABLED`、`AUTO_BAN_ERROR_CODES`、`RETRY_429_ENABLED`、`ROUTECODEX_RL_SCHEDULE`）
  - 在 `emitProviderError` 中集成风控配置
  - 通过 `ProviderQuotaView` 接口影响路由决策
- **参考**: gcli2api `config.py` 中的风控配置

---

## 修改位置分布

- **llmswitch-core**: 5 个任务
  - Claude thoughtSignature 验证增强
  - 工具调用 ID 风格统一管理
  - Thinking 块清理策略优化
  - 流式响应心跳机制
  - 工具参数修复增强

- **RouteCodex Provider V2**: 3 个任务
  - 错误码追踪系统（记录错误码）
  - 请求头增强
  - 配额重置时间戳解析（上报配额信息）

- **RouteCodex VirtualRouter**: 1 个任务
  - 自动封禁策略（基于错误码和配额）

- **RouteCodex 配置层**: 2 个任务
  - 配置驱动的风控策略
  - 调试请求转储功能

---

## ProviderQuotaView 集成说明

llmswitch-core 通过 `ProviderQuotaView` 接口管理配额，这是风控系统的核心集成点：

### ProviderQuotaView 接口定义
```typescript
export interface ProviderQuotaViewEntry {
  providerKey: string;
  inPool: boolean;           // 是否在候选池中
  cooldownUntil?: number;    // 冷却截止时间戳
  blacklistUntil?: number;   // 黑名单截止时间戳
  priorityTier?: number;     // 优先级层级
  selectionPenalty?: number; // 选择惩罚值
  lastErrorAtMs?: number;    // 最后错误时间
  consecutiveErrorCount?: number; // 连续错误次数
}

export type ProviderQuotaView = (providerKey: string) => ProviderQuotaViewEntry | null;
```

### 事件上报机制

Provider V2 通过 `emitProviderError` 上报配额和错误事件：

1. **配额耗尽事件** (`virtualRouterQuotaDepleted`)
   - Provider V2 解析上游 API 响应中的 `quotaResetDelay`
   - 通过 `emitProviderError` 上报，包含 `cooldownMs` 信息
   - VirtualRouter 的 `applyQuotaDepletedImpl` 处理事件
   - 更新 `ProviderQuotaViewEntry.cooldownUntil`

2. **配额恢复事件** (`virtualRouterQuotaRecovery`)
   - Provider V2 检测到配额恢复（如 token 刷新成功）
   - 通过 `emitProviderError` 上报恢复事件
   - VirtualRouter 的 `applyQuotaRecoveryImpl` 处理事件
   - 清除 `cooldownUntil` 和 `blacklistUntil`

3. **系列冷却事件** (`virtualRouterSeriesCooldown`)
   - RateLimitManager 基于 429 错误次数触发系列冷却
   - 通过 `emitProviderError` 上报冷却事件
   - 更新 `seriesBlacklist` 映射

### 职责分工

| 组件 | 职责 |
|------|------|
| **Provider V2** | - 解析上游 API 响应<br>- 提取配额信息<br>- 通过 `emitProviderError` 上报事件 |
| **RateLimitManager** | - 管理 429 错误的阶梯退避<br>- 维护 `seriesBlacklist`<br>- 计算 `cooldownMs` |
| **VirtualRouter** | - 接收配额和错误事件<br>- 更新 `ProviderQuotaViewEntry`<br>- 执行封禁/解封决策 |
| **llmswitch-core** | - 提供 `ProviderQuotaView` 接口<br>- 根据配额状态进行路由决策<br>- 控制入池/优先级 |

---

## 实施计划

### 阶段一：核心风控增强（高优先级）
1. Claude thoughtSignature 验证增强
2. 工具调用 ID 风格统一管理
3. 实时封禁增强（基于 ProviderQuotaView）
4. 封禁策略配置（通过 ProviderQuotaView）

### 阶段二：传输层优化（中优先级）
5. 请求头增强
6. Thinking 块清理策略优化
7. 配额重置时间戳解析
8. 工具参数修复增强
9. 配置驱动的风控策略

### 阶段三：调试和监控（低优先级）
10. 调试请求转储功能
11. 流式响应心跳机制

---

## 测试计划

### 单元测试
- thoughtSignature 验证逻辑测试
- 工具调用 ID 生成和规范化测试
- 错误码追踪和封禁逻辑测试
- 请求头构建测试
- 配额时间戳解析测试

### 集成测试
- 端到端请求流程测试
- 429 错误处理和重试测试
- 自动封禁和解封测试
- 多 provider 切换测试

### 回归测试
- 确保现有功能不受影响
- 验证协议转换的正确性
- 验证工具调用的兼容性

---

## 注意事项

1. 所有修改必须遵循项目的架构原则，不破坏职责分离
2. llmswitch-core 负责协议级风控，Provider V2 负责传输级风控，VirtualRouter 负责路由级风控
3. 配置驱动的风控策略应该支持动态更新和热重载
4. **实时封禁完全基于 `ProviderQuotaView` 接口**，不实现独立的错误码追踪系统
5. Provider V2 通过 `emitProviderError` 上报事件，VirtualRouter 更新 `ProviderQuotaViewEntry`
6. llmswitch-core 通过 `ProviderQuotaView` 接口读取封禁状态，自动应用路由决策
7. 封禁策略通过 `inPool`、`cooldownUntil`、`blacklistUntil` 字段控制
8. 使用事件驱动的架构模式，避免在 Provider V2 中直接管理封禁状态

---

## 参考资源

- gcli2api 项目: `/Users/fanzhang/Documents/github/gcli2api`
- llmswitch-core 项目: `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core`
- RouteCodex 项目: `/Users/fanzhang/Documents/github/routecodex`

---

## 更新日志

- 2026-01-22: 初始任务文档创建（风控增强阶段一/二）
- 2026-01-24: 新增任务 13（Chat Process 协议与流水线契约），已完成（待审阅）

## 阶段性完成总结（2026-01-22）

> 本节仅覆盖最初的“风控增强”相关任务（任务 1–11）的阶段性总结；后续新增的任务（如任务 12/13）以任务清单的状态为准。

### 已完成的文件

**llmswitch-core**:
1. `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/shared/thought-signature-validator.ts` (新建)
2. `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/shared/tool-call-id-manager.ts` (新建)
3. `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/shared/tool-argument-repairer.ts` (新建)
4. `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/shared/reasoning-normalizer.ts` (修改)
5. `/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/index.ts` (修改)

**RouteCodex**:
1. `/Users/fanzhang/Documents/github/routecodex/src/config/risk-control-config.ts` (新建)
2. `/Users/fanzhang/Documents/github/routecodex/src/providers/core/utils/provider-error-reporter.ts` (修改)
3. `/Users/fanzhang/Documents/github/routecodex/src/providers/core/runtime/http-transport-provider.ts` (修改)

### 关键改进

1. **Claude thoughtSignature 验证**: 严格验证 thinking 块签名，防止无效签名触发风控
2. **工具调用 ID 统一管理**: 支持 'fc' 和 'preserve' 两种风格，提高兼容性
3. **实时封禁增强**: 基于 `ProviderQuotaView` 接口，完全依赖 llmswitch-core 的配额管理
4. **配置驱动的风控**: 支持环境变量配置，灵活控制封禁策略
5. **请求头增强**: 模拟真实客户端请求头，降低被识别风险
6. **工具参数修复**: 自动修复格式错误的工具参数，提高成功率

### 架构原则遵循

- ✅ 协议级风控 → llmswitch-core
- ✅ 传输级风控 → RouteCodex Provider V2
- ✅ 路由级风控 → RouteCodex VirtualRouter
- ✅ 配置级风控 → RouteCodex
- ✅ Quota 管理核心 → llmswitch-core `ProviderQuotaView` 接口
