# Provider Error: reroutable until routePool + defaultPool are both empty

> Goal slice proposed 2026-06-20 after Jason 纠偏：
> 所有 provider 错误一律可切。唯一停止条件：相关可选池 + default 池**同时**为空。
> default 池永远不可空。必须有刚性骨架 + 红测锁定，禁止任何 owner 绕过。

## 1. 目标
- 任何一次 provider 执行期错误（4xx/5xx、network、SSE decode、protocol 错误、`INVALID_API_KEY`/`INSUFFICIENT_QUOTA`/`ACCOUNT_DISABLED`/`403`/`401`），**默认动作是"切"，不是"返"**。
- 唯一允许的"返"边界：相关可选池（按 `routePool` 排除后剩余=0）**且** default 池为空。
- `default_pool` 必须在每个 routing group 配置中显式存在。即使 tier 内暂时没有可用 provider，骨架（tier 声明 + VR contract）也必须存在。
- `client_disconnect`（包括 upstream HTTP_499 / `client abort request`）仍 health-neutral；不切、不投影 4xx（属于 client transport 取消，不属于本骨架覆盖）。

## 2. 硬约束（必须靠类型 + 运行时 + 红测锁住，不可绕过）

### 2.1 类型层
- 新增 `ErrorErr05ExecutionDecision` 必带字段：
  - `routePoolRemainingAfterExclusion: string[]`（剩余候选，**显式列出**已排除 + 未排除）
  - `defaultPoolAvailable: boolean`（default 池是否非空 + 可用）
  - `mayProject: boolean` = `routePoolRemainingAfterExclusion.length === 0 && !defaultPoolAvailable`
  - `policyExhausted: boolean` = `mayProject`（同一真源，禁止两套字段）
  - `callerMayProject(error, decision): boolean` = `decision.mayProject`
- 旧 `ErrorErr05ExecutionDecision` 字段（`shouldRetry` / `excludedCurrentProvider` / `switchAction`）保留语义但禁止直接派生 `mayProject`。

### 2.2 运行时层
- 必经 `ErrorErr01 -> 02 -> 03 -> 04 -> 05 -> 06` 链；禁止任意 owner：
  - 直接 `throw` provider error 给客户端（禁止 `rethrow` / `throw error` 出口）
  - 直接 `res.status(...).json(...)` 投影
  - 直接走 `provider-error-reporter` 后调用 `reportProviderErrorToRouterPolicy` 但跳过 `consume_error_err_05_*`
- `router-direct` / `provider-direct` 必须消费 `ErrorErr05` decision；若 decision 仍允许切，必须回到 relay Hub Pipeline / 走 default-pool plan，不得 rethrow。
- `http-error-mapper` 投影门：
  - 仅当 `decision.mayProject === true` 才允许投影
  - 否则抛 `EARLY_PROJECTION_BLOCKED` sentinel（强制 caller 退到 executor 切路径）

### 2.3 导出层
- `ErrorErr05ExecutionDecision` 只能由
  `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/decision.rs`
  + TS bridge `native-router-hotpath-loader.ts` 构造。
- `mayProject` / `callerMayProject` 不允许其他模块 export；red-gate 扫描 export 表。

### 2.4 红测层（必须先红后绿）
- `tests/red-tests/error_chain_may_project_gate.test.ts`：
  - 单 pool 1 候选 1 排除 → `mayProject=false`
  - 单 pool 1 候选 1 排除 + default 非空 → `mayProject=false`
  - 单 pool 1 候选 1 排除 + default 空 → `mayProject=true`
- `tests/red-tests/default_pool_skeleton_must_exist.test.ts`：
  - 每个 routing group 必须有显式 default tier；缺失时 VR contract fail-fast
- `tests/red-tests/router_direct_must_not_rethrow_provider_error.test.ts`：
  - 401/403/502/503 在 router-direct 路径必须进 ErrorErr05 decision，不允许 rethrow
- `tests/red-tests/http_error_mapper_early_projection_blocked.test.ts`：
  - 当 `mayProject=false` 调用 `mapErrorToHttp` 必须抛 `EARLY_PROJECTION_BLOCKED`

## 3. 现有 owner 改造清单

| owner | module | 改造 |
|---|---|---|
| `error.provider_failure_policy` | `src/providers/core/runtime/provider-failure-policy-impl.ts` | 删除 `shouldRerouteTerminalUnrecoverableProviderFailure` 的 401/403/INVALID_API_KEY 旁路；改为一律 `exclude_and_reroute`；只有 `routePoolRemainingAfterExclusion.length === 0 && !defaultPoolAvailable` 时降级为 `direct_return` |
| `error.execution_decision_consumer` | `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts` + `request-executor-retry-decision.ts` | 新增 `routePoolRemainingAfterExclusion` + `defaultPoolAvailable` 真源；`isLastAvailableProvider429` 扩展为"last available of any class"（含 default）；`holdOnLastAvailable429` 改名为 `holdOnLastAvailableProvider`；强制 `attempt += 1` 直到 `mayProject=true` |
| `error.client_projection` | `src/server/utils/http-error-mapper.ts` | 新增 `callerMayProject` 谓词；`mapErrorToHttp` 接收 `decision` 参数或调用方已确认 `mayProject=true` |
| `virtual_router.primary_exhausted_to_default_pool` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/primary_exhausted_to_default_pool_blocks.rs` | default-pool 计划必须由 `evaluate_singleton_route_pool_exhaustion` 先行；default-pool 不可空配置真源 |
| `server.responses_request_handler_bridge_surface` + `server.chat_request_handler_bridge_surface` | server handler | 不允许直接 `mapErrorToHttp`；必须先消费 `ErrorErr05` decision |

## 4. 落地顺序（每步先红后绿 + 红测必绿）

1. **新增 `routePoolRemainingAfterExclusion` + `defaultPoolAvailable` 真源**（TS helper + Rust NAPI bridge + 单测 + 红测先红后绿）
2. **`error.execution_decision_consumer` 接真源**：保证 `mayProject` 唯一派生自两个字段；401/403/INVALID_API_KEY 不再走"last-attempt direct_return"分支
3. **`error.client_projection` 加 `callerMayProject` 谓词**：先抛 sentinel；不允许在 `mayProject=false` 时映射
4. **`error.provider_failure_policy` 删 401/403 旁路**：全部走 `exclude_and_reroute`
5. **`virtual_router.primary_exhausted_to_default_pool` 写硬约束**：default-pool 不可空（routing group 配置真源）
6. **红测 + architecture gate 全部上锁**：
   - `verify:error-pipeline-contract`
   - `verify:error-chain-reroutable-until-empty`（新增）
   - `verify:default-pool-skeleton`
   - `verify:router-direct-no-rethrow`
   - `verify:http-error-mapper-may-project-gate`
   - `verify:architecture-error-chain-bypass`
   - `verify:architecture-provider-specific-leaks`
   - `verify:function-map-compile-gate`
   - `verify:architecture-owner-queryability`
   - `verify:architecture-nonadjacent-conversion`

## 5. 完成标准
- 5555 live 复测：单 routing group 单 pool 1 候选 1 排除后，必须先看到 default-pool plan 注入与新 virtual-router-hit，才能 client-visible。
- 单测 / 红测 / 架构 gate 全部 PASS。
- live 5555 sample 必须能复现"403 → 切到 default-pool provider → 200"完整链路。
- `docs/error-handling-v2.md` §1.0.x 更新到本骨架；`docs/design/pipeline-type-topology-and-module-boundaries.md` 同步 `ErrorErr05` 真源字段。

## 6. 风险
- 旧 `ErrorHandlingCenter` / `RouteErrorHub` 残留 `emit/subscribe/normalize` 行为必须物理删除（仅保留 compat adapter，参见 `docs/error-handling-v2.md` §0a 6）。
- `shouldRerouteTerminalUnrecoverableProviderFailure` 修改后必须保留 401/403 投影为 generic 502（不暴露 auth 文案 / request_id），但**先切**。
- L92-19 既有测试需要全部重跑并通过；如有依赖"401/403 立即 client-visible"的旧行为测试，必须按新骨架重写而不是 skip。

## 7. 2026-06-20 审计后执行补充

### 7.1 已验证事实
- `primary_exhausted -> default_pool` Rust planner 已存在并已接入 host：
  - `src/server/runtime/http-server/request-executor.ts`
  - `src/server/runtime/http-server/index.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/primary_exhausted_to_default_pool.rs`
- `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib` 已验证 PASS（5 tests）。
- `ErrorErr05` 类型层已有 `routePoolRemainingAfterExclusion/defaultPoolAvailable/policyExhausted/mayProject` 字段。

### 7.2 当前必须修的断点
1. `resolveRequestExecutorProviderFailurePlan -> resolveProviderRetryExecutionPlan` 未传真实 `defaultTierAvailable`，导致 `defaultPoolAvailable` 默认 false，不能证明 default 池非空时禁止投影。
2. `src/server/runtime/http-server/direct-decision.ts` 仍有 `isTerminalAuthFailure`，会让 router-direct 的 401/402/403/INVALID_API_KEY/INSUFFICIENT_QUOTA 早返，违反“所有 provider 错误可切，唯一停止条件是候选池 + default 池同时为空”。
3. `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts` 仍按旧 `details.policyExhausted` 语义调用 projection；实现已要求完整 `ErrorErr05ExecutionDecision`，测试/文档/实现需要对齐。
4. “default 池永远不可空 / default 最后一个 provider 不移出池”仍缺配置/VR gate，不能只停留在文档规则。

### 7.3 修复顺序
1. 先改红测与旧测试合同：
   - 401/403/INVALID_API_KEY/INSUFFICIENT_QUOTA/ACCOUNT_DISABLED 只要 route/default 仍有候选就必须可切。
   - `client_disconnect` 仍 health-neutral、非投影、非切换。
   - `special_400` 仍直接 client-visible，不误切 provider。
2. 接入真实 default availability：
   - 在 `resolveRequestExecutorProviderFailurePlan` 增加 `defaultTierAvailable` 输入。
   - 从 routing group + route tiers / Rust default-pool planner 得到非空 default truth。
   - 传入 `resolveProviderRetryExecutionPlan`，让 `mayProject` 成为唯一投影门。
3. 删除 `direct-decision.ts` auth/quota terminal early return：
   - 物理删除 `isTerminalAuthFailure` 早返逻辑。
   - router-direct 只能按 ErrorErr05 decision、剩余 pool、default availability、attempt budget 决定 reroute/rethrow。
4. 收口 `error.client_projection`：
   - `project_error_err_06_client_from_error_err_05_execution_decision` 只接受完整 ErrorErr05 decision。
   - 旧 `details.policyExhausted/candidateExhausted` 只允许作为 legacy negative test 或物理删除。
5. 增加 default-pool skeleton gate：
   - 每个 routing group 必须有显式 default fallback tier。
   - default 最后一个 provider 不允许因 health/quota/cooldown 被移出到空池。
6. live closeout：
   - 5555 构造 auth/quota/provider 4xx 或 5xx，证明先切下一候选/default provider。
   - 只有 route pool + default pool 同时为空时才 client-visible。

### 7.4 必跑验证矩阵
- Red/contract：
  - `tests/red-tests/error_chain_may_project_gate.test.ts`
  - `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
  - `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  - 新增 default-pool skeleton red test。
- Executor/direct:
  - `tests/server/runtime/http-server/executor/retry-execution-plan.spec.ts`
  - `tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts`
  - 相关 `request-executor.spec.ts` focused cases for 401/403 reroute。
- Rust:
  - `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`
- Architecture/build:
  - `npm run verify:error-pipeline-contract`
  - `npm run verify:provider-failure-ban-blackbox`
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-error-chain-bypass`
  - `npm run build:base`
  - `npx tsc --noEmit --pretty false`
- Runtime:
  - install/restart target port 5555.
  - `/health` confirms installed version ready.
  - live replay proves 401/403/auth/quota/provider 5xx does not client-visible until route pool + default pool both empty.

### 7.5 完成定义
- 任何 provider 执行期错误默认进入 ErrorErr01-06，并由 ErrorErr05 决定切换/投影。
- `mayProject === true` 只能来自 `routePoolRemainingAfterExclusion.length === 0 && defaultPoolAvailable === false`。
- router-direct 不再有 auth/quota 早返特例。
- default pool skeleton 有 gate；default 最后 provider 不会被移出到空池。
- Focused tests、architecture gates、build、5555 live replay 全部 PASS。

## 8. 2026-07-15 Responses direct continuation pin 冲突测试设计

### 8.1 生命周期
- 第一轮 Responses direct continuation 可把 `responsesResume.providerKey` 投影为 request-local `runtime_control.retryProviderKey`，保持 remote continuation provider affinity。
- provider 执行失败进入 ErrorErr01-05 后，ErrorErr05 将当前 provider 写入 `route.retry_exclusion_set`。
- 下一 attempt 若 continuation pin 指向已排除 provider，排除必须优先：不得删除 `excludedProviderKeys`，不得重写同 provider pin，VR 必须选择剩余 route/default provider。

### 8.2 正反测试
- 正向：continuation provider 未被排除时，仍写 `retryProviderKey`，证明正常 direct continuation affinity 不受影响。
- 反向：continuation provider 已被 ErrorErr05 排除时，保留 `excludedProviderKeys` 且不写 pin，证明 401/402/403/429/5xx 不会重选同一失败 provider。
- 模块黑盒：router-direct 402 + direct continuation metadata 必须调用第二 provider 并返回 200。
- 项目黑盒：5520 真实 `/v1/responses` 重放必须看到 402 后新 provider 的 `virtual-router-hit`，不得直接出现 client-visible 402。

### 8.3 已知缺口
- 真实 upstream 402 不可确定性较高；若 live provider 当时不再返回 402，使用同入口可控 provider error fixture 重放，并明确记录未命中真实 upstream 402 的缺口。
