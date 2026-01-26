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

---

## Antigravity 对齐（阶段一：协议/风控/alias）

> 仅对齐 **Antigravity Tools 最新版本**，不考虑旧格式；只启用 **Antigravity 分支**。

### A. 协议层（request/response）
- **A1 System Instruction `<priority>`** ✅（已对齐）
  - 参考：`sharedmodule/llmswitch-core/src/conversion/compat/*`、`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.ts`
  - 要求：仅 `<priority>` 版，去除旧格式分支
- **A2 request wrapper `requestType: "agent"`（body wrapper）** ✅（已对齐）
  - 参考：`sharedmodule/llmswitch-core/src/conversion/compat/*`、`src/providers/core/runtime/gemini-cli-http-provider.ts`
  - 要求：仅 body wrapper，禁用 header-only
- **A3 Thought Signature（缓存/预热/恢复）** ✅（已对齐）
  - 参考：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`、`sharedmodule/llmswitch-core/src/conversion/compat/*`
  - 要求：仅 Antigravity 分支；缓存 12h / session 50 / 全局 200；不扩展 deepFilter 策略
- **A4 工具调用清理（history/tool_call）** ✅（已对齐）
  - 参考：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`、`sharedmodule/llmswitch-core/src/conversion/compat/*`
  - 要求：仅 Antigravity 分支；对齐 deepFilterThinkingBlocks
- **A5 Endpoint/路径构造** 🟡（代码对齐，待验证）
  - 参考：`src/client/gemini-cli/gemini-cli-protocol-client.ts`、`src/providers/core/runtime/gemini-cli-http-provider.ts`
  - 要求：对齐 Antigravity Tools 最新路径构造

### B. 风控与配额保护（Antigravity only）
- **B1 账号禁用（disabled/proxy_disabled）持久化** ✅（已对齐）
  - 参考：`src/providers/core/runtime/http-transport-provider.ts`、`src/providers/auth/oauth-lifecycle.ts`
  - 要求：仅 Antigravity 分支；invalid_grant/401 触发禁用；quota 已持久化
- **B2 protected_models 持久化 + 路由影响** 🟡（实现完成，待验证）
  - 参考：`src/manager/quota/**`、`sharedmodule/llmswitch-core/src/router/virtual-router/**`
  - 要求：模型级保护与恢复机制
- **B3 账号级限流** 🟡（实现完成，待验证）
  - 参考：`src/providers/core/runtime/rate-limit-manager.ts`、`sharedmodule/llmswitch-core/src/router/virtual-router/**`
  - 要求：引入账号级限流；与 session stickiness 一致

### C. Alias 与模型映射
- **C1 Alias → model 顺序（走 Hub pipeline）** ✅（已符合）
  - 参考：`sharedmodule/llmswitch-core/src/router/virtual-router/**`
  - 要求：不做特殊 provider 映射
- **C2 模型名规范化（provider 侧配置）** 🟡（进行中）
  - 参考：`src/providers/core/runtime/gemini-cli-http-provider.ts`
  - 要求：Provider 不做模型降级/回退；仅允许后缀规范化（-low/-high/-medium/-minimal）；
    具体业务映射在虚拟路由器层完成

### D. 请求头一致性（Antigravity only）
- **D1 UA / X-Goog-Api-Client / Client-Metadata** ✅（已对齐）
  - 参考：`src/providers/auth/antigravity-userinfo-helper.ts`、`src/providers/core/runtime/http-transport-provider.ts`
  - 要求：对齐 Antigravity Tools 最新版本

### E. project_id 来源（Antigravity only）
- **E1 token 缺失 project_id → OAuth 生命周期补全** ✅（已对齐）
  - 参考：`src/providers/auth/oauth-lifecycle.ts`、`src/providers/auth/antigravity-userinfo-helper.ts`
  - 要求：对齐 Antigravity Tools 最新版本（不随机）

---

## llms-wasm 逐步替换（TS → WASM）迁移任务

> [!important]
> 本任务基于 `docs/llms-wasm-migration.md`（计划概要）与 `docs/plans/llms-wasm-migration-plan.md`（可执行清单）。
>
> 责任边界：Host 只做开关读取/影子分发/指标上报；canonicalization、routing、tools、compat、diff 协议全部在 llmswitch-core。

### W1. 阶段 0：边界与基线（先做）
- **参考**: `docs/plans/llms-wasm-migration-plan.md#阶段-0边界与基线`
- **优先级**: 最高
- **状态**: ✅ 已完成（文档与基线定义完成，下一步进入双加载与开关矩阵）
- **目标**:
  - 产出“模块边界清单”（Contract + 归属 + 依赖顺序）
  - 建立“基线回放集”（可重复、可脱敏、可回放）
- **任务**:
  - [x] 产出模块边界清单文档：`docs/llms-wasm-module-boundaries.md`
  - [x] 定义每个模块的输入/输出 Contract（TypeScript interface 草案）：`docs/llms-wasm-module-boundaries.md`
  - [x] 明确依赖顺序与替换优先级：`docs/llms-wasm-module-boundaries.md`
  - [x] 确认 Owner/修复路径（wasm core vs compat adapter）：`docs/llms-wasm-module-boundaries.md`
  - [x] 设计回放集采样策略（覆盖模型/工具/路由/SSE 典型场景）：`docs/llms-wasm-replay-baseline.md`
  - [x] 定义回放集存储格式（JSON + 脱敏规则）：`docs/llms-wasm-replay-baseline.md`
  - [x] 定义 baseline 版本快照字段（TS/WASM/ruleset/compat/sse 版本号）：`docs/llms-wasm-replay-baseline.md`

---

### W2. 阶段 1：双加载与开关矩阵（进行中）
- **参考**: `docs/plans/llms-wasm-migration-plan.md#阶段-1双加载--开关矩阵`
- **优先级**: 最高
- **状态**: 🟡 进行中（已确认方案，开始实现）
- **目标**:
  - 在 Host 中实现 WASM & TS 双加载初始化
  - 实现运行模式开关（`shadow` / `wasm_primary` / `ts_primary` / `split`）
  - 实现开关优先级矩阵（全局 > 租户 > 路由 > 请求）
  - 实现影子请求分发（异步、非阻塞）
- **方案确认**:
  - WASM 侧已提供 `HubPipeline` 实现（`sharedmodule/llms-wasm/js/hub-pipeline.mjs`）
  - Host 侧已有 `hubPipelineEngineShadow` 预留字段，需实现影子加载逻辑
  - 新增 `src/runtime/wasm-runtime/` 模块负责 WASM 运行时加载
  - 扩展 `src/modules/llmswitch/bridge` 新增 `getHubPipelineCtorForImpl('wasm')` 接口
- **任务清单**:
  - [ ] 强制规则：模块必须先验证通过，才能进入“上线对比（shadow）”阶段（按模块顺序执行）
    - [x] tokenizer：先验证 → 再允许 shadow（已通过 llms-wasm compare：hub-chat-process/tool-filters）
    - [x] tool canonicalization：先验证 → 再允许 shadow（已通过 llms-wasm compare：tool-filters/tool-governance 样本）
    - [x] compat profile：先验证 → 再允许 shadow（已通过 llms-wasm compare：compat-request/compat-response）
    - [x] streaming (SSE)：先验证 → 再允许 shadow（已通过 llms-wasm compare：hub-response/provider-response）
    - [x] routing：先验证 → 再允许 shadow（已通过 llms-wasm compare：virtual-router）
    - [x] virtual-router engine-health：先验证 → 再允许 shadow（已通过 llms-wasm native compare：vr_map_provider_error/vr_handle_provider_failure/vr_apply_series_cooldown）
    - [x] virtual-router routing-policy：先验证 → 再允许 shadow（已补齐 fixtures：multi-provider round_robin / priority-fallback）
    - [x] provider-response conversion：先验证 → 再允许 shadow（已补齐 fixtures：openai-chat/openai-responses provider response conversion）
    - [ ] inbound/outbound request shaping：先验证 → 再允许 shadow（下一步：补齐 openai-chat/openai-responses request fixtures，打通 standardized_bridge/response_io）
    - [x] standardized bridge：先验证 → 再允许 shadow（已补齐 FFI + native roundtrip：ChatEnvelope <-> StandardizedRequest）
  - [ ] 新建 `src/runtime/wasm-runtime/` 模块结构与入口
  - [ ] 实现 `WasmRuntime` 类（加载、初始化、生命周期管理）
  - [ ] 扩展 `src/modules/llmswitch/bridge` 新增 `getHubPipelineCtorForImpl('wasm')`
  - [ ] 实现 `ensureHubPipelineEngineShadow()` 加载 WASM HubPipeline
  - [ ] 实现运行模式开关解析（环境变量 `ROUTECODEX_HUB_PIPELINE_IMPL`）
  - [ ] 实现开关优先级矩阵（全局 > 租户 > 路由 > 请求）
  - [ ] 实现影子请求分发逻辑（主路 + 影子异步）
  - [ ] WASM 初始化失败上报（通过 `providerErrorCenter`）
  - [ ] 验证双加载互不影响（隔离测试）
  - [x] 在 llmswitch-core CI 新增 wasm-compare job（模块顺序 gating）: `/Users/fanzhang/Documents/github/sharedmodule/.github/workflows/llmswitch-core-ci.yml`

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
  - [x] RouteCodex 基线 coverage 盘点（按 `test:ci:coverage` 的 jest 集合）：当前 lines/branches/functions/statements 约 28.5%/24.0%/30.2%/28.1%
  - [x] 仓库卫生：根目录禁止 ad-hoc 文件（md/test/debug/pid/cache），CI 增加 `verify:repo-sanity`（PR 必跑）：`.github/workflows/test.yml` + `scripts/ci/repo-sanity.mjs`
  - [x] 扩大 CI jest 测试集（仍保持 deterministic / 无外网）：`scripts/tests/ci-jest.mjs`
  - [x] CI 增加 release build 校验（防止“测试过了但 build 挂”）：`.github/workflows/test.yml`（`npm run build:min`）
  - [x] CI 稳定性：workflow 增加 concurrency + job timeout；coverage job 固定 maxWorkers（通过 `ROUTECODEX_CI_MAX_WORKERS`）防止小 runner OOM：`.github/workflows/test.yml` + `scripts/tests/ci-jest.mjs`
  - [x] servertool 回归测试兼容两套契约：旧版 `metadata.* / adapterContext.webSearch` 与新版 `metadata.__rt.* / adapterContext.__rt.*`（避免 sharedmodule 演进时 CI 断裂）；PR CI 仍以 release npm `@jsonstudio/llms@0.6.1172` 为基准，dev-only servertool suites（clock/mixed/stop-message session 等）暂不纳入 CI coverage：`tests/servertool/*.spec.ts` + `scripts/tests/ci-jest.mjs`
- **仍需你拍板**（GitHub 设置侧，代码无法强制）:
  - [ ] 分支保护规则：将 `llmswitch-core-ci` 标记为 Required status checks（PR 必过）
- **待落地/进行中**:
  - [x] RouteCodex CI 新增 `test:ci` + `test:ci:coverage`（先覆盖 CI 测试集）：`package.json` + `scripts/tests/ci-jest.mjs`
  - [x] 在 `.github/workflows/test.yml` 增加 coverage job（PR 必跑）：`.github/workflows/test.yml`
  - [x]（PR）sharedmodule：修复 `llms-wasm CI` 在 Node 20 下 `.wasm` ESM 导入失败 + 无 config 时的 bootstrap 失败（compare steps 暂时为非阻塞信号，避免 CI 噪音/漏检）：`sharedmodule/.github/workflows/llms-wasm-ci.yml` + `sharedmodule/llms-wasm/scripts/compare-virtual-router.mjs`
  - [ ] CI 测试集 re-enable：`@jsonstudio/llms` 仍停留在 npm `0.6.1172`，因此 release CI 暂不包含依赖新 llmswitch-core 行为的 servertool/sharedmodule 测试（待 llms 发布后再纳入）
  - [ ] 修复当前阻塞“全量 coverage”的单测（`tests/servertool/virtual-router-quota-routing.spec.ts`）或拆分为 nightly

---

### 19. Antigravity 429 冷却与 alias 策略重置（架构一致性修正）
- **位置**: `src/providers/core/runtime/rate-limit-manager.ts` + `src/providers/core/runtime/base-provider.ts` + `sharedmodule/llmswitch-core/src/router/virtual-router/**`
- **优先级**: 高
- **状态**: 🟡 进行中
- **原因**:
  - 现有实现存在“模型系列整体移出路由池”的行为（series cooldown/series blacklist），会扩大影响面。
  - Antigravity alias 设计是默认 sticky，仅在 429/错误时轮转；因此应以 alias 级别冷却与切换为准。
  - 冷却策略需与路由池一致：**冷却 = 移出路由池**，但不应扩展到整个模型系列。
  - 429 语义应先触发 quota 更新判断：无 quota → 冷却移出；有 quota → alias 置尾并切换 sticky。
- **目标**:
  - 移除 series-level 冷却/黑名单（不再对模型系列整体移出路由池）。
  - 429 流程改为“先 quota 更新后决策”，只影响当前 alias。
  - Antigravity alias 维持默认 sticky，出错时轮转到下一 alias。
- **待落地/进行中**:
  - [x] Provider 侧移除 series blacklist（`rate-limit-manager.ts`）
  - [x] 禁用 `virtualRouterSeriesCooldown` 生成与处理（`base-provider.ts` + `engine-health.ts`）
  - [ ] 429 流程调整为“先 quota 更新后决策”
  - [ ] 429 后 alias 轮转与 sticky 切换（`engine-selection/alias-selection.ts`）
  - [ ] 更新/补齐相关测试（`tests/servertool/virtual-router-series-cooldown.spec.ts` 等）

### 18. llmswitch-core：单测全覆盖 + Golden 回归 + 覆盖率 90%（PR 必跑）
- **位置**: `sharedmodule/llmswitch-core/tests/**` + `sharedmodule/llmswitch-core/scripts/**` + `sharedmodule/.github/workflows/llmswitch-core-ci.yml`
- **优先级**: 最高
- **状态**: 🟡 进行中（开始落地）
- **目标**:
  - 每个模块（按 `src/**` 目录边界）必须至少有 1 个单元测试用例（可通过脚本自动检查缺失）
  - 每个功能契约必须有 regression/golden 测试：chat_process 不变量、servertool followup H1/H2/H3、SSE decode/encode、compat profiles、virtual-router quota/cooldown/sticky、tool schema 清洗等
  - `src/**` 覆盖率（lines/branches/functions/statements）>= **90%**，作为 PR Required check（fail-fast）
  - 允许少量“不可测 glue”通过显式 allowlist 排除（必须可审计、可收敛）
  - Golden 样本必须在 CI 可获取（优先放 repo；如体积过大再迁 GitHub Release asset + sha256 lock）
- **落地策略**:
  - 测试分层固定：`tests/unit/**` + `tests/integration/**` + `tests/regression/**` + `tests/golden/**` + `tests/fixtures/**` + `tests/harness/**`
  - 测试 runner（先落地最小可用）：沿用现有 matrix 脚本（`scripts/tests/run-matrix-ci.mjs`），用 `c8` 做 v8 coverage，并通过 sourcemap 映射回 `src/**`
  - 新增脚本：
    - `scripts/verify-test-coverage-map.mjs`：检查“模块必须有测试”的最低覆盖（缺失即 fail）
    - `scripts/verify-coverage.mjs`：读取 `coverage-summary.json` 并执行 90% gate + glue allowlist
    - `scripts/fetch-golden.mjs`（可选）：当 golden 不在 repo 时，下载并校验 Release asset
- **CI/CD 计划**:
  - PR 必跑（workflow jobs 并行 + timeout + concurrency）：
    - `lint+typecheck`、`unit`、`integration`、`regression`、`coverage`（90% gate）、`golden-verify`
  - Nightly（schedule）：
    - 跑更重的 matrix（Node 20/22）+ 全量 regression + golden verify（可选 golden update 走 PR）
- **待落地/进行中**:
  - [x] CI 结构：workflow 拆为 `lint` / `verif` / `coverage` 三个 job：`sharedmodule/.github/workflows/llmswitch-core-ci.yml`
  - [x] Golden in CI：chat/anthropic golden 改为读 repo fixtures（可用 `CODEX_SAMPLES_DIR` 覆写）：`sharedmodule/llmswitch-core/tests/fixtures/codex-samples/**` + `sharedmodule/llmswitch-core/scripts/tests/*golden-roundtrip.mjs`
  - [x] Coverage runner：`build:coverage`（sourcemap）+ `c8` 产出 `coverage/coverage-summary.json`：`sharedmodule/llmswitch-core/scripts/run-ci-coverage.mjs` + `sharedmodule/llmswitch-core/tsconfig.coverage.json`
  - [x] Coverage gate 脚本 + glue allowlist 初版：`sharedmodule/llmswitch-core/scripts/verify-coverage.mjs` + `sharedmodule/llmswitch-core/config/coverage-exclude-glue.json`
  - [x] 增加覆盖回归用例（先覆盖核心路径）：HubPipeline 全链路 smoke + web_search backend smoke：`sharedmodule/llmswitch-core/scripts/tests/hub-pipeline-smoke.mjs` + `sharedmodule/llmswitch-core/scripts/tests/web-search-backend-smoke.mjs`
  - [x] 修复 llmswitch-core CI lint job（.d.ts ignore + no-useless-escape/no-empty/no-mixed-spaces-and-tabs）：`sharedmodule/llmswitch-core/.eslintrc.json` + `sharedmodule/llmswitch-core/src/**`
  - [x] 增加 coverage boost 用例（纯单测、无外网、deterministic）并入 matrix：`sharedmodule/llmswitch-core/scripts/tests/coverage-openai-message-normalize.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-request-tool-list-filter.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-context-diff.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-sticky-pool-via-router.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-parse-loose-json.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-instruction-target.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-guidance-augment.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-tool-harvester.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-text-markup-normalizer.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-recursive-detection-guard.mjs`
  - [x] 增加 coverage boost 用例（路由/工具 surface/patch 结构化）并入 matrix：`sharedmodule/llmswitch-core/scripts/tests/coverage-tool-surface-engine.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-structured-apply-patch.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-engine-health.mjs`
  - [x]（PR）新增 “模块必须有覆盖” gate（每个 `src/*` 模块至少 1 个文件被覆盖；`src/test` 允许排除）：`sharedmodule/llmswitch-core/scripts/verify-test-coverage-map.mjs` + `sharedmodule/llmswitch-core/config/test-coverage-map.json`
  - [x]（PR）新增 coverage boost（覆盖 `src/http` 与 `src/bridge`）：`sharedmodule/llmswitch-core/scripts/tests/coverage-http-sse-response.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-bridge-routecodex-adapter.mjs`
  - [x]（PR）新增 coverage boost（覆盖 `payload-budget/jsonish/target-utils`）：`sharedmodule/llmswitch-core/scripts/tests/coverage-payload-budget.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-jsonish.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-target-utils.mjs`
  - [x]（PR）新增 coverage boost（覆盖 `context-weighted/session-identifiers/tool-registry/reasoning-tool-parser`）：`sharedmodule/llmswitch-core/scripts/tests/coverage-context-weighted.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-session-identifiers.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-tool-registry.mjs` + `sharedmodule/llmswitch-core/scripts/tests/coverage-reasoning-tool-parser.mjs`
  - [x]（PR）新增 coverage boost（覆盖 `servertool` auto handlers）：`sharedmodule/llmswitch-core/scripts/tests/coverage-servertool-handlers.mjs`
  - [x]（PR）新增 coverage boost（覆盖 SSE sequencers）：`sharedmodule/llmswitch-core/scripts/tests/coverage-sse-sequencers.mjs`
  - [x]（PR）新增 coverage boost（覆盖 stopMessage auto handler）：`sharedmodule/llmswitch-core/scripts/tests/coverage-servertool-stop-message-auto.mjs`
  - [x]（PR）新增 coverage boost（覆盖 VirtualRouter bootstrap）：`sharedmodule/llmswitch-core/scripts/tests/coverage-virtual-router-bootstrap.mjs`
  - [ ] 90% 目标：逐步补齐 `src/**` 单测/回归并把 CI gate 从当前临时阈值提升到 90%（lines/branches/functions/statements）
  - [ ] “模块必须有测试” gate：落地 `tests/unit|integration|regression|golden` 分层，并启用 `scripts/verify-test-coverage-map.mjs`
  - [ ] Golden 扩容策略：如果 fixtures 体积膨胀，迁 GitHub Release asset + sha256 lock（仍保证 CI 可获取）
  - **当前覆盖率基线（本地，2026-01-24）**：`src/**` ≈ lines **63.13%** / branches **48.04%** / functions **63.19%** / statements **63.13%**；CI 临时 gate（min）= **48**（未达 90%，持续抬升）

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
