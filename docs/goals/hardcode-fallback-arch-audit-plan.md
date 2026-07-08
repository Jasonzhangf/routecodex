# 硬编码与 Fallback 架构风险审计 + 修复计划

## 1. 目标与验收标准

### 目标
把项目内"硬编码常量 / 字符串 + fallback / 降级 / 兜底 / 双路径"两类风险做一次系统化审计与修复。落到可执行计划，确保 `provider/port/model/url/header/error_code` 等常量都有唯一真源；所有"错误回退到默认值"必须显式 fail-fast，不允许静默吞错或假成功。

### 验收标准
1. 全仓硬编码（API base、port、timeout、UA、model 列表、SSE 协议字符串、provider id 字符串）有 SSOT：`src/constants/index.ts` + service profile / per-provider contract / env 入口，不再散落。
2. `provider-failure-policy-impl.ts` `UNRECOVERABLE_CODE_SET` / `NETWORK_ERROR_CODE_SET` / `BLOCKING_RECOVERABLE_CODE_SET` 等 Set 的 provider-specific / `DEEPSEEK_*` / `HTTP_*` 错误码迁到 `provider-error-catalog.ts` 作为唯一字典；删除 provider key `startsWith` 字符串硬编码。Provider 差异只允许在 provider runtime 内。
3. `rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs` 的 persisted 503 family cleanup 必须按 `reason` 匹配通用语义，禁止 provider 前缀特判。
4. 删除所有"忽略 stats / 静默 catch / best-effort log"的 silent failure；保留的 catch 必须命中 `silent-failure-audit.mjs` 的 `HAS_HANDLED_RE` 报警白名单并写理由。
5. 新增 / 强化审计门禁：`scripts/ci/hub-deterministic-audit.mjs`、`silent-failure-audit.mjs`、`llmswitch-rustification-audit.mjs` 必须能阻断 `新增硬编码 + 新增 fallback + 新增 startsWith 字符串 provider 特例`。
6. 所有改动走"红测先行 / 单元补齐 / 黑盒验证 / `pnpm run build:min` + cargo test"。

## 2. 范围与边界

### In Scope
- 硬编码常量的 SSOT 化：`src/constants/index.ts`、`src/providers/core/config/service-profiles.ts`、`src/providers/core/contracts/*-provider-contract.ts`、`src/providers/auth/*`。
- 错误码字典统一：`src/providers/core/runtime/provider-error-catalog.ts` + `provider-failure-policy-impl.ts` 的 Set 收敛。
- provider key / runtime key `startsWith` 字符串硬编码清理：`src/server/runtime/http-server/{http-server-runtime-providers,request-executor,executor/request-executor-pipeline-attempt,executor/provider-response-converter}.ts`。
- 静默 catch 清理：`src/providers/core/runtime/{base-provider,deepseek-file-upload,transport/*}.ts`、`src/server/handlers/responses-handler.ts`。
- 审计门禁脚本：`scripts/ci/silent-failure-audit.mjs` 增 provider prefix 硬编码白名单；新增 `scripts/ci/hardcode-audit.mjs`。
- AGENTS.md / rcc-dev-skills / MEMORY.md / note.md 同步更新。

### Out of Scope
- 不改 Virtual Router 选路语义（除非 provider 特例删除导致需要调整）。
- 不动 Hub Pipeline 节点类型拓扑（`docs/design/pipeline-type-topology-and-module-boundaries.md`）。
- 不改 Error Pipeline 契约（`docs/design/error-pipeline-contract-and-routing-audit.md`）。
- 不改 SSE / responses continuation / servertool followup 业务逻辑，仅做硬编码清理。
- 不改 provider wire / SDK options metadata 边界（已有 `assertProviderOutboundBodyHasNoMetadata` 守住）。

## 3. 设计原则

1. **真源唯一**：常量 → `constants/index.ts` + service profile；错误码 → `provider-error-catalog.ts`；provider key 模式 → provider contract；metadata → runtime carrier。
2. **Fail-fast + no fallback**：禁止 catch 后 `return null/false/undefined`；禁止 `// ignore` / `// best-effort` 但不触发报警。删除旧 fallback 路径必须连同 provider-specific `if` 特例一起移除（不保留兜底）。
3. **Provider 特例只能在 Provider runtime**：Hub Pipeline / Virtual Router / RequestExecutor 不得写 provider key 字符串前缀判断；改用 `providerFamily` / `runtimeKey` 抽象。
4. **物理删除**：迁出后旧 Set、旧 `if` 块、旧常量字符串必须删除。删除前必须先有红测覆盖 + `pnpm run build:min` 通过。
5. **最小合规**：不引入用户没要求的新抽象（除非迁移 Set 字典必须），不改无关链路。

## 4. 技术方案（含文件清单）

### Phase 1：硬编码常量 SSOT 化（常量层）

**文件**：
- `src/constants/index.ts` —— 增加 `API_BASE_URLS`（openai / anthropic / gemini / glm baseURL）、`PROVIDER_TIMEOUTS`（各 provider 默认 timeout）、`PROVIDER_DEFAULT_MODELS`（gpt-4 / claude-3-haiku-20240307 / glm-4 / model-a）、`SSE_DEFAULT_CAPS`。
- `src/providers/core/config/service-profiles.ts` —— 引用 `constants.API_BASE_URLS.OPENAI` 等替换裸字符串。
- `src/providers/core/runtime/provider-request-header-orchestrator.ts` —— `DEFAULT_PROVIDER.USER_AGENT` 已经统一在 `constants/index.ts`，确认调用点都走 `DEFAULT_PROVIDER.USER_AGENT`，删除散落 UA 字符串。
- `src/cli/config/bootstrap-provider-templates.ts` —— `baseURL: 'https://api.anthropic.com/v1'` 等替换为 `API_BASE_URLS.ANTHROPIC`。
- `src/index.ts` —— dev mode `5555` fallback（行 1264-1267）显式改为 `buildInfo.mode === 'dev' ? throw new Error(...)`，禁止静默兜底。

**验证**：
- 新增 `scripts/ci/hardcode-audit.mjs`：扫描 `src/providers/**` 裸 `https://` 字符串，列白名单（contract / service-profiles / cli/config），违规即 fail。
- `pnpm run build:min` 仍通过。

### Phase 2：错误码字典唯一化（错误链）

**文件**：
- `src/providers/core/runtime/provider-error-catalog.ts` —— 新增 `PROVIDER_UNRECOVERABLE_CODES` / `PROVIDER_NETWORK_CODES` / `PROVIDER_BLOCKING_RECOVERABLE_CODES` 三个冻结 Set；保留人类可读注释。
- `src/providers/core/runtime/provider-failure-policy-impl.ts` —— 删行 28-73 三个本地 Set，改为 `import { PROVIDER_UNRECOVERABLE_CODES } from './provider-error-catalog.js'`。
- `src/providers/core/runtime/provider-error-classifier.ts` —— 同样收敛：硬编码 429 细分判断逻辑迁入 catalog。
- `src/providers/core/utils/provider-error-reporter.ts` —— `normalizeCode` 的 `ERR_COMPATIBILITY` / `ERR_PROVIDER_FAILURE` / `ERR_PIPELINE_FAILURE` 字面量也迁 catalog。

**验证**：
- `pnpm jest tests/providers/core/runtime/provider-failure-policy*` 全绿。
- `pnpm jest tests/providers/core/runtime/provider-error-*` 全绿。
- 新增红测：`provider-failure-policy-impl.red.spec.ts`：provider-specific code 迁移后，断言三个 Set 的 `has(...)` 行为不变。
- `pnpm run build:min` 通过。

### Phase 3：Provider key / runtime key 字符串硬编码清理（Hub/VR 边界）

**文件**：
- `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`（行 85-86）—— 删 provider key `startsWith(...)` 特判，改为 `target.providerFamily` / `compatibilityProfile` 抽象判断。
- `src/server/runtime/http-server/request-executor.ts`（行 949-950）—— 同样改 provider family 抽象。
- `src/server/runtime/http-server/http-server-runtime-providers.ts`（行 214/233/303/432）—— 删 provider key 字符串前缀判断，改为 runtime profile 字段判断。
- `src/server/runtime/http-server/executor/provider-response-converter.ts`（行 910-921）—— provider-specific response conversion 必须只通过 provider runtime/profile 抽象进入，禁止在 executor 层写 provider key 分支。
- `src/server/runtime/http-server/executor/request-executor-traffic-soft-wait.ts` —— 2026-06-09 已物理删除；traffic saturation 必须走统一 `request-executor-error-action-queue.ts`，禁止恢复 soft-wait 白名单或 per-provider wait timeout。

**Rust 侧**：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs`（行 220-243）—— persisted 503 family cleanup 循环逻辑保留但不得 `starts_with(...)` provider 前缀，改用传入 `provider_key` 自身的 `reason.as_deref() == Some(PERSIST_REASON_HTTP_503_DAILY)` 判断；若有兄弟 provider key 通过同 family 联动，则 family 概念下沉到 `provider_family` 字段。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/load_balancer.rs`（行 279）—— 测试 provider key 用 fixture 函数生成的中性别名，不写死 provider 前缀（仍在 `#[cfg(test)]` 内，仅做命名清理）。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs`（行 1685-1730）—— provider URL 测试 fixture 保持 `#[cfg(test)]` 标记；用 `bootstrap_test_fixture` 常量统一拼装。

**验证**：
- `pnpm jest tests/server/http-server/http-server-runtime-providers*.spec.ts` 全绿。
- `pnpm jest tests/server/http-server/executor/request-executor-pipeline-attempt*.spec.ts` 全绿。
- `cargo test -p router-hotpath-napi health::tests -- --nocapture` 全绿。
- 新增红测：`http-server-runtime-providers.red.spec.ts` —— 当 provider family 只能从 runtime profile 得出、不能从 provider key 前缀推断时，旧代码会漏处理；新代码命中。

### Phase 4：静默 catch / fallback 清理（运行时）

**文件**：
- `src/providers/core/runtime/base-provider.ts`（行 218-219 / 247-248）—— `} catch { /* ignore stats errors */ }` 改为 `stats?.recordProviderUsage(event)` 用可选链 + `try` 失败时 `logger.warn('stats.recordProviderUsage.failed', { error, requestId })`。
- `src/providers/core/runtime/provider-http-executor-utils.ts`（行 38/183）—— `// never throw from best-effort logging` 改用 `logger.warn`。
- `src/providers/core/runtime/transport/oauth-header-preflight.ts`（行 62/74）—— `// ignore background repair errors` 改 `logger.warn`。
- `src/server/handlers/responses-handler.ts`（行 602）—— `} catch {}` 改为 `} catch (writeErr) { logResponsesHandlerNonBlockingError('pipeline_error_payload.write', writeErr, { requestId }) }`。

**验证**：
- `pnpm jest tests/providers/core/runtime/base-provider*.spec.ts` 全绿。
- `pnpm jest tests/server/handlers/responses-handler*.spec.ts` 全绿。
- `node scripts/ci/silent-failure-audit.mjs` 命中数 < 当前基线。

### Phase 5：审计门禁强化

**文件**：
- `scripts/ci/silent-failure-audit.mjs` —— 增加 provider prefix 字符串白名单：禁止在 `src/server/**` / `sharedmodule/llmswitch-core/src/**` 出现 provider key 前缀运行期特判（`#[cfg(test)]` / `*.test.ts` / `*.spec.ts` 例外）。
- 新增 `scripts/ci/hardcode-audit.mjs` —— 扫 `src/providers/**` 裸 `https://` / 裸 `timeout: 120000|240000|300000` / 裸 port（除 `constants/index.ts` 外），列白名单。
- `package.json` —— 新增 `"verify:hardcode": "node scripts/ci/hardcode-audit.mjs"`。
- CI / verify 脚本串接 `silent-failure-audit` + `hardcode-audit` + `hub-deterministic-audit` + `llmswitch-rustification-audit`。

**验证**：
- `pnpm run verify:hardcode` PASS。
- `pnpm run verify:silent` PASS。
- `pnpm run verify:hub-deterministic` PASS。
- `pnpm run verify:llmswitch-rustification` PASS。

## 5. 风险与规避

1. **风险 1**：删 provider key 字符串特判导致 runtime 漏处理 503 family 联动。
   - **规避**：在 health.rs 新增 `provider_family` 字段，不从 provider key 前缀推断 family；red test 覆盖 503 + 健康恢复路径。
2. **风险 2**：catalog 字典迁移破坏现有"代码 + 状态 + upstream 状态"匹配路径。
   - **规避**：catalog 暴露的 API 与原 Set 行为完全等价（`has(value)`），先加 import 保持原逻辑，再迁物理位置。
3. **风险 3**：静默 catch 改成显式 warn 后日志刷屏。
   - **规避**：仅在 `requestId` / `providerKey` 已存在时记录；用 `log*NonBlockingError` 已有的限流逻辑。
4. **风险 4**：新增 hardcode-audit 误报 provider contract 内的 URL 字符串。
   - **规避**：白名单 = `src/providers/core/contracts/*` + `src/providers/core/config/service-profiles.ts` + `src/providers/core/config/provider-oauth-configs.ts` + `src/cli/config/bootstrap-provider-templates.ts`（仅当 URL 在常量定义上下文时）。所有白名单在脚本内显式注释。
5. **风险 5**：rust 侧 persisted 503 cleanup 改名后旧测试引用断。
   - **规避**：逐测试迁移到通用函数名，迁移完成后物理删除旧名。

## 6. 测试计划

### 定向测试
- `pnpm jest tests/providers/core/runtime/provider-failure-policy*`
- `pnpm jest tests/providers/core/runtime/provider-error*`
- `pnpm jest tests/providers/core/runtime/base-provider*`
- `pnpm jest tests/server/http-server/http-server-runtime-providers*`
- `pnpm jest tests/server/http-server/executor/request-executor-pipeline-attempt*`
- `pnpm jest tests/server/handlers/responses-handler*`
- `cargo test -p router-hotpath-napi health::tests -- --nocapture`
- `cargo test -p router-hotpath-napi virtual_router_engine::health -- --nocapture`

### 黑盒 / Live 验证
- `pnpm run build:min`
- `pnpm run install:global`（仅 dev 环境）
- `routecodex restart --port 5555` + `/health` + `curl /v1/chat/completions` 走 deepseek 路径
- `routecodex restart --port 5520` + 走真实 provider-family cooldown 路径观察 503 family cleanup 行为

### 门禁验证
- `node scripts/ci/silent-failure-audit.mjs`
- `node scripts/ci/hardcode-audit.mjs`
- `node scripts/ci/hub-deterministic-audit.mjs`
- `node scripts/ci/llmswitch-rustification-audit.mjs`
- `node scripts/ci/repo-sanity.mjs`
- `node scripts/ci/secrets-check.mjs`
- `node scripts/check-file-line-limit.mjs`

## 7. 实施步骤（顺序）

1. **Step 1 — Phase 1 SSOT 化**：
   - 在 `constants/index.ts` 加 `API_BASE_URLS` / `PROVIDER_TIMEOUTS` / `PROVIDER_DEFAULT_MODELS` / `SSE_DEFAULT_CAPS`。
   - 改 `service-profiles.ts` 引用 + `bootstrap-provider-templates.ts` 引用。
   - 跑 `pnpm run build:min` + 新增 `pnpm run verify:hardcode` 基线。
2. **Step 2 — Phase 2 错误码字典迁移**：
   - `provider-error-catalog.ts` 加 `PROVIDER_UNRECOVERABLE_CODES` / `PROVIDER_NETWORK_CODES` / `PROVIDER_BLOCKING_RECOVERABLE_CODES`。
   - `provider-failure-policy-impl.ts` 三个 Set 替换为 catalog import。
   - 跑定向测试 + red test。
3. **Step 3 — Phase 3 provider key 字符串清理**：
   - TS：`request-executor-pipeline-attempt.ts` / `request-executor.ts` / `http-server-runtime-providers.ts` 改 providerFamily 抽象。
   - Rust：`health.rs` persisted 503 cleanup 改名 + 改抽象。
   - 跑 `cargo test health::tests` + `pnpm jest http-server-runtime-providers*`。
4. **Step 4 — Phase 4 静默 catch 清理**：
   - `base-provider.ts` / `responses-handler.ts` / `provider-http-executor-utils.ts` / `oauth-header-preflight.ts` 改显式 warn。
   - 跑 `pnpm jest` + `node scripts/ci/silent-failure-audit.mjs`。
5. **Step 5 — Phase 5 门禁强化**：
   - 改 `silent-failure-audit.mjs` 加 provider prefix 硬编码规则。
   - 新建 `hardcode-audit.mjs`。
   - `package.json` 加 `verify:hardcode`。
   - 跑全部 verify 脚本。
6. **Step 6 — MEMORY.md / AGENTS.md / rcc-dev-skills 同步**：
   - `MEMORY.md` 追加 2026-06-05 硬编码 + fallback 收口条目。
   - `note.md` 写执行轨迹。
   - `AGENTS.md` 第 10 / 12 / 17 条护栏引用本 plan。
   - `.agents/skills/rcc-dev-skills/SKILL.md` 加"2026-06-05 硬编码 / fallback 收口"精华段。

## 8. 完成定义（DoD）

1. `src/constants/index.ts` 增加 4 个常量字典，service-profiles / bootstrap-templates / provider-runtime-metadata / request-header-orchestrator 全部引用，无散落裸字符串。
2. `provider-error-catalog.ts` 是错误码唯一字典；`provider-failure-policy-impl.ts` 不再有本地 Set。
3. `http-server-runtime-providers.ts` / `request-executor.ts` / `request-executor-pipeline-attempt.ts` 无 provider key 字符串特判；`health.rs` 无 provider 前缀硬编码（除 `#[cfg(test)]` fixture）。
4. `base-provider.ts` / `responses-handler.ts` 静默 catch 全部改为显式 warn，silent-failure-audit 命中数 < 当前基线。
5. `pnpm run verify:hardcode` / `verify:silent` / `verify:hub-deterministic` / `verify:llmswitch-rustification` 全 PASS。
6. `pnpm run build:min` + `cargo test -p router-hotpath-napi` + `pnpm jest` 全绿。
7. `routecodex restart --port 5555` + `--port 5520` live smoke 验证 provider-family 503 cleanup 行为不变。
8. `MEMORY.md` / `note.md` / `AGENTS.md` / `.agents/skills/rcc-dev-skills/SKILL.md` 同步更新；本 plan 文件不删，下一次目标 plan 追加新章节而非覆盖。

## 9. 不在范围但需触达的辅助文件

- `scripts/ci/silent-failure-audit.mjs` —— 改白名单与 provider prefix 规则。
- `scripts/ci/hardcode-audit.mjs` —— 新建。
- `package.json` —— 新增 `verify:hardcode` 脚本。
- `MEMORY.md` / `note.md` —— 状态写入。
- `AGENTS.md` / `.agents/skills/rcc-dev-skills/SKILL.md` —— 同步规则与精华。

## 10. 关联权威文档

- `AGENTS.md`（项目级入口 + 17 条硬护栏）
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `docs/design/error-pipeline-contract-and-routing-audit.md`
- `docs/design/servertool-rust-only-architecture.md`
- `docs/goals/hubpipeline-rust-closeout-master-plan.md`
- `docs/goals/hubpipeline-rust-closeout-master-plan.md`
- `docs/goals/servertool-rust-only-fallback-ssot-audit-plan.md`
- `docs/goals/error-pipeline-contract-full-closeout-plan.md`
- `scripts/ci/silent-failure-audit.mjs`
- `scripts/ci/hub-deterministic-audit.mjs`
- `scripts/ci/llmswitch-rustification-audit.mjs`
- `scripts/verify-servertool-rust-only.mjs`
