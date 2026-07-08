# Direct Path Error Reroute + Candidate Exhaustion 修复计划

> Owner: Jason
> Theme: 让 direct/provider/provider-pool 错误回到统一策略中心，按“候选优先”原则恢复对话
> Date: 2026-06-14
> Status: in_progress (Phase 6.5 true-state cleanup)
> Last revision: 2026-06-14 19:20 (provider-direct / guard / default-pool truth sync)
>
> 本文是 `docs/error-handling-v2.md` §1.0 与 `docs/design/provider-failure-policy-ssot.md` 中
> 2026-06-14 校正条款的落地计划。
> 它只描述修复方向与落点，不重写 SSOT 本身；SSOT 真源仍是上面两份文档。
>
> 同时它也是本次产品中心原则的最小合规落点：
> 只要当前 route pool（含 VR 允许的 secondary/default pool）还有候选 provider，
> provider 执行期错误就不得直接中断对话；必须先进入统一策略中心做计数/排除/切换。

## 0. 审计现状（2026-06-14 19:20，对比 handoff 摘要与当前文件真相）

### 0.1 已真实落盘（本轮仍需重新跑 gate）
- F1 + F2：`src/providers/core/runtime/provider-failure-policy-impl.ts:115-170` 识别 upstream 499 / `client abort request` / `client closed request` / `peer reset` / `connection reset`；`:1091` 的 `isProviderFailureHealthNeutral` 前几行短路 → `affectsHealth=false`。
- F6：`src/server/utils/http-error-mapper.ts:160-176` 拦截 → 实际投影 `formatPayload(204, { code: 'CLIENT_DISCONNECTED', ... })`（**不是 handoff 摘要写的 499**）。这更稳：客户端不会看见任何上游错误文本。
- F4：`src/server/runtime/http-server/index.ts` 的 `router-direct.onProviderError` 已消费 `resolveRequestExecutorProviderFailurePlan(...)`，并通过 `decideDirectRouterRetry(...)` 决定递归重选 / rethrow。
- F5：`provider-direct.onProviderError` 已进入 `resolveRequestExecutorProviderFailurePlan(...)`，但保持单绑定 provider 边界，不合成 route-pool reroute。
- F8：`primary_exhausted -> default_pool` 已采用 Option A：Rust/VR selection 是真源，`select_provider_falls_to_default_route_when_requested_route_is_exhausted` 已锁 requested route exhausted 后进入 `default` route；新增 `plan_primary_exhausted_to_default_pool_json` 只作为 Rust-owned contract / native export，不允许 host 合成 fallback。
- 5 个 spec 文件真实存在（本轮需重跑确认）：
  1. `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`
  2. `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
  3. `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  4. `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
  5. `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`

### 0.2 与 handoff 摘要的偏差校正（**禁止叙事护短**）

| # | 偏差 | 当前真源 | 影响 | 当前状态 |
|---|------|------|------|----------|
| D1 | handoff 曾写 provider-direct spec 已 PASS，但当时文件不存在 | 当前文件已存在：`tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts` | 已从“无红测”变成“需重跑验证” | 本轮 gate 必跑 |
| D2 | handoff 曾写 `suppressRouterDirectRetry` 已删，但审计时仍在 | 当前 `src/server/runtime/http-server/index.ts` 已无该 guard，改由 `decideDirectRouterRetry(...)` 统一判断 | router-direct 不再有该早返回 gap | 本轮通过 candidate-exhaustion spec 锁住 |
| D3 | handoff 写"投影 499/CLIENT_DISCONNECTED"，实际是 `formatPayload(204, ...)` | `http-error-mapper.ts` | live replay 证据应是“不泄漏 499 / client abort request 错误体” | goal prompt 已按该口径写 |
| D4 | P4 写“待 Jason 拍板” | Jason 已明确：`primary_exhausted -> default_pool` | 不能再写 Option B | 采用 Rust/VR Option A，host 禁止 fallback |

### 0.3 中心思想 × 现状 gap（用户原话）

> "只要有 provider 就不应该中断对话，当前池空还有 default"

| 用户要求 | 现状 | gap |
|----------|------|-----|
| (a) 错误必须统一回到错误处理中心 | ✅ F4 已接 `resolveRequestExecutorProviderFailurePlan` | 已闭合，待 gate 重跑 |
| (b) provider 错误冷却计数由中心做 | ✅ `isProviderFailureHealthNeutral` 短路 client_disconnect；其它 5xx 走 ErrorErr05 决策 | 已闭合 |
| (c) 切 provider 由中心做 | ⚠️ router-direct 已接 decision；provider-direct 是单绑定端口，只消费 decision 不合成 reroute | 需要 gate 重跑 + live probe |
| (d) 非持续问题下次恢复，持续问题过段时间再试 | ✅ 已走 `request-executor-error-action-queue` 1s/2s/3s 队列 | 已闭合 |
| (e) 持续问题过段时间再尝试 | ✅ cooldown 由 `error.backoff_action_queue` + `virtual_router_engine` 协同 | 已闭合 |
| (f) 只要有 provider 就不应中断对话 | ⚠️ provider send 阶段已收口；post-send SSE incomplete 仍是另一个 gap | 本 plan 锁 send/reroute；SSE gap 另起 plan |
| (g) 当前池空还有 default | ✅ Rust selection 已支持 requested route exhausted -> default route；新增 primary_exhausted contract/native export 可查询 | 需要 Rust cargo test + live probe |

### 0.4 未做但本计划剩余
- live replay 5555 旧 499 样本（D3 修正：断言"客户端收不到 499 / `client abort request` 错误体"）
- live probe 2+ 候选切 provider（构造 5xx 复现）
- live probe client_disconnect 不可见（强制中断 SSE）
- default pool 扩池 live probe（P4 已采用 Option A）
- `docs/architecture/verification-map.yml` integration 段未同步
- note.md → MEMORY.md 提炼已追加初稿，最终需按本轮验证结果校正

## 0.5 SSOT 校正要点（Jason 2026-06-14 用户口径，6 条必须锁死）

1. 唯一策略中心不变：`Virtual Router policy + ProviderFailurePolicy + 错误动作队列`（`request-executor-error-action-queue`）。不得复活 `ErrorHandlingCenter` 第二中心。
2. direct path 责任划分：`payload/response passthrough` 保留；`error passthrough` 删除。`router-direct` / `provider-direct` 必须消费 `ErrorErr05ExecutionDecision`。
3. 候选优先：`recoverable` / `unrecoverable` / `periodic_recovery` 都必须先回统一策略；**候选耗尽**才允许进入 `ErrorErr06ClientProjected`。
4. `secondary / default pool` 扩池只能由 **VR 显式建模**；host / `http-server` / `RequestExecutor` **禁止** 本地补 fallback。
5. `client_disconnect`（含 upstream `HTTP_499` + `client abort request`）必须在 `error.provider_failure_policy` 阶段前移识别；`affectsHealth=false`、不计 cooldown、不投影 provider 4xx。
6. `ErrorErr06ClientProjected` 增加 `policy exhausted / candidate exhausted` 前置门；未 exhausted 的 provider 4xx 不得直接投影。

## 0.6 F1–F10 唯一 owner 锁定

| ID | 唯一 owner | 备注 |
|----|------------|------|
| F1 | `src/providers/core/runtime/provider-failure-policy-impl.ts` | `isProviderFailureClientDisconnect` 识别 upstream 499 / `client abort request` / `client closed request` / `peer reset` / `connection reset` |
| F2 | `src/providers/core/runtime/provider-failure-policy-impl.ts` | `isProviderFailureHealthNeutral` 前几行短路 client_disconnect → `affectsHealth=false` |
| F3 | `src/server/runtime/http-server/router-direct-pipeline.ts` | JSDoc / 契约说明：payload passthrough 保留；error passthrough 删除 |
| F4 | `src/server/runtime/http-server/index.ts` | `router-direct.onProviderError` 消费 `resolveRequestExecutorProviderFailurePlan`；维护 `excludedProviderKeys` / `switchAction` 实际切换 |
| F5 | `src/server/runtime/http-server/index.ts` | `provider-direct.onProviderError` 同 F4；单绑定端口在唯一候选失败时进入 `ErrorErr06` |
| F6 | `src/server/utils/http-error-mapper.ts` | 增加 `policy exhausted / candidate exhausted` 前置门；`isClientDisconnectLikeForProjection` 短路 client_disconnect |
| F7 | `src/server/runtime/http-server/request-executor.ts` | 注释同步：secondary pool 完全由 VR contract 决定 |
| F8 | `sharedmodule/llmswitch-core/.../virtual_router_engine` | 已采用 Option A：Rust selection / Rust contract 显式表达 `primary_exhausted -> default_pool`；host 不得本地补 fallback |
| F9 | 旧错误设计物理删除 | `router-direct / provider-direct` 报告后立即 rethrow 的死语义；`http-error-mapper` 普通 4xx 早投影分支；任何 host 端 `default fallback` 尝试 |
| F10 | `docs/architecture/function-map.yml` / `verification-map.yml` | 新增 / 调整 `error.direct_path_unified_decision` / `error.client_disconnect_classification` 等 `feature_id` 同步 |

### 已知偏差（必须在下个 Phase 收口，不在本次 SSOT 校正范围）
- D1：`tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts` 已存在 → 本轮重跑确认
- D2：`src/server/runtime/http-server/index.ts` 已无 `suppressRouterDirectRetry` guard → 本轮 candidate-exhaustion spec 锁住
- D3：live replay 证据口径 → 客户端收不到任何 499 / `client abort request` 错误体（不是"收到 499"）
- D4：`upstream_stream_incomplete` 属于 post-send SSE terminal-missing gap，不在本 plan 实现面 → 另起 plan 追踪

## 1. 背景样本

- requestId: `openai-responses-router-gpt-5.4-20260614T085154756-341633-1419`
- provider: `asxs.crsa.gpt-5.4-mini`
- upstream status: `499`
- upstream body: `{"error":{"message":"client abort request","type":"invalid_request_error"}}`
- 直接现象：HTTP 499 + 错误 body 返回客户端
- 实际语义：client 提前断开，upstream nginx 返回 499，并不是真实 provider 错误
- 期望行为：识别为 client_disconnect，不计 cooldown、不污染 health、不投影 provider-visible 4xx

## 2. 设计目标

1. 唯一策略中心：仍为 `Virtual Router policy + ProviderFailurePolicy + request-executor error action queue`，不新增、不复活 `ErrorHandlingCenter` 第二中心。
2. direct path 责任划分：
   - payload/response passthrough：保留
   - error passthrough：删除
   - direct consumer 必须消费 `ErrorErr05ExecutionDecision`，在候选耗尽前不得直接 client-visible
3. 候选优先：
   - 任何 provider 执行期错误（recoverable / unrecoverable / periodic_recovery），若当前 pool 仍有未排除候选，必须先按统一策略动作：
     1) 进入统一错误动作队列 blocking wait（`1s -> 3s -> 5s -> repeat`）
     2) 由策略决定 `retry_same_provider_once` 或 `exclude_and_reroute`
   - 候选耗尽后，才允许进入 `ErrorErr06ClientProjected`
4. secondary / default pool 扩池：
   - 若产品允许“主池空扩到 default 池”，必须在 VR policy / route contract 中显式建模
   - host / `http-server` / `RequestExecutor` 禁止在主池空时本地补 fallback
5. client_disconnect 不算 provider failure：
   - `CLIENT_DISCONNECTED` / `client_request_aborted` / `client_response_closed` / upstream `HTTP_499` + `client abort request` / `client closed request`
   - 必须 `affectsHealth=false`，不计 cooldown，不投影成 provider-visible 4xx
6. client projection 收口：
   - `ErrorErr06ClientProjected` 只能在策略中心 + 候选耗尽后才投影
   - 禁止 `http-error-mapper` 仅凭 `status in 4xx` 立即投影 provider 错误
7. 物理删除旧错误设计：
   - 删除 direct path “只 report 不消费 decision” 的死语义
   - 删除 `http-error-mapper` 中“普通 4xx 早投影”的错误边界
   - 删除“local fallback 到 default provider”的 host 端尝试

## 3. 当前代码 gap 与唯一真源落点

| Gap | 当前文件 / 行号 | 期望唯一 owner | 备注 |
|---|---|---|---|
| G1 | `src/server/runtime/http-server/router-direct-pipeline.ts:1` 仍把 direct 定义为 `fail-fast: no fallback` | router-direct 直接契约 | 只删除 error passthrough；保留 payload passthrough |
| G2 | `src/server/runtime/http-server/index.ts:1605` 的 `router-direct.onProviderError` 只 report + 极窄本地 retry，不消费完整 reroute decision | router-direct 改为 unified decision consumer |  |
| G3 | `src/server/runtime/http-server/index.ts:2056` 的 `provider-direct.onProviderError` 只 report，不 reroute | provider-direct 改为 unified decision consumer | 单绑定 provider 端口也要至少消费 policy decision |
| G4 | `src/server/utils/http-error-mapper.ts:178` 对 `400 <= status < 500` 过早投影 | `ErrorErr06ClientProjected` | 加 `policy exhausted` 前置门 |
| G5 | `src/providers/core/runtime/provider-failure-policy-impl.ts:116` 的 `isProviderFailureClientDisconnect` 未识别 upstream 499 / `client abort request` | `error.provider_failure_policy` | 前移到分类前 |
| G6 | `src/server/runtime/http-server/request-executor.ts:585` relay 池耗尽后无 default 扩池能力 | Virtual Router 真源 | host 不补 fallback |
| G7 | `src/server/runtime/http-server/router-direct-pipeline.ts:9` 的注释 `Fail-fast: no fallback` 与本计划冲突 | 注释 + JSDoc 同步 |  |

## 4. 唯一修改点（最小合规修改表）

| ID | 文件 | 修改类型 | 目的 |
|---|---|---|---|
| F1 | `src/providers/core/runtime/provider-failure-policy-impl.ts` | 改 | `isProviderFailureClientDisconnect` 识别 upstream 499 / `client abort request` / `client closed request` |
| F2 | `src/providers/core/runtime/provider-failure-policy-impl.ts` | 改 | `isProviderFailureHealthNeutral` 在 client_disconnect 时返回 true（affectsHealth=false） |
| F3 | `src/server/runtime/http-server/router-direct-pipeline.ts` | 改 | JSDoc 与契约说明：payload passthrough 保留，error passthrough 删除 |
| F4 | `src/server/runtime/http-server/index.ts` | 改 | `router-direct.onProviderError` 完整消费 `retryExecutionPlan`；在 `directAttempt` 之上维护 `excludedProviderKeys` / `switchAction` 实际切换循环 |
| F5 | `src/server/runtime/http-server/index.ts` | 改 | `provider-direct.onProviderError` 同样消费 decision；单绑定端口在唯一候选失败时进入 `ErrorErr06` 投影 |
| F6 | `src/server/utils/http-error-mapper.ts` | 改 | 增加 `policy exhausted / candidate exhausted` 前置门；非 exhausted 的 provider 4xx 不直接投影 |
| F7 | `src/server/runtime/http-server/request-executor.ts` | 改（可选） | 注释同步：relay 路径耗尽后是否触发 secondary pool 完全由 VR contract 决定 |
| F8 | `sharedmodule/llmswitch-core/.../virtual_router_engine` | 改（按需） | 若 Jason 决定支持 default pool 扩池：加 `primary_exhausted -> default_pool` contract；不加则记录 “不支持，primary exhausted 即 fail” |
| F9 | 旧错误设计物理删除 | 删 | `router-direct / provider-direct` 报告后立即 rethrow 的死语义；`http-error-mapper` 普通 4xx 早投影分支 |
| F10 | function-map / verification-map | 改 | 新增 / 调整 `error.direct_path_unified_decision` / `error.client_disconnect_classification` 等 `feature_id` 同步 |

## 5. 阶段顺序

### Phase A：设计 / 文档收口（已完成）

- 写入 `docs/error-handling-v2.md` §1.0
- 写入 `docs/design/provider-failure-policy-ssot.md` 校正条款
- 写入本计划

### Phase B：红测先红后绿

新增 / 复用以下红测；改造前必须确认 red：

1. `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`
2. `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
3. `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
   - 正向：direct 路径仍有 >=2 候选时，recoverable transport 错误不直接 client-visible，必须进入排除当前 provider + reroute 循环
   - 反向：direct 路径只剩当前一个候选时，recoverable 错误经统一策略后允许 fail-fast
   - 反向：direct 路径收到 `client_disconnect`（`HTTP_499` + `client abort request`）时，不投影到客户端
4. `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`
   - 正向：单绑定端口错误经 policy 投影，不走无门 4xx 早投影
   - 反向：`client_disconnect` ���投影
5. `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
   - 正向：未 exhausted 的 provider 4xx 不再走 `Upstream rejected the request` 早投影
   - 反向：exhausted 之后的 4xx 仍然正确投影
6. 反向测试（AGENTS 第 24 条强制要求）：
   - `special_400` 不会被误判为 recoverable 而切 provider
   - 池中只剩当前一个 provider 时不会无限重打同 provider
   - 普通成功响应不会因错误链误触发 fail

### Phase C：实现最小合规修改

1. F1 / F2：补全 client_disconnect 识别与 health-neutral
2. F3：JSDoc 与契约同步
3. F4 / F5：direct consumer 改造成 unified decision consumer
4. F6：client projection 增加 policy-exhausted 前置门
5. F8：按 Jason 决定实施 default pool 扩池
6. F9：物理删除旧错误设计
7. F10：function-map / verification-map 同步

每个修改后立即跑对应红测；红测转绿后再继续下一步。

### Phase D：旧样本在线重放 + 新样本 live probe

1. 在线重放 5555 旧样本（499 + `client abort request`）→ 必须不再 client-visible 499
2. live probe：构造 2+ 候选路由 + 1 个 provider 返 5xx → 内部应切到候选 2，客户端正常收到响应
3. live probe：构造 primary pool exhausted → 若支持 default pool 扩池，必须在 VR 切到 default；若不支持，文档明确 fail-fast
4. live probe：构造 `client_disconnect`（强制中断 SSE）→ 客户端不能收到 499 / `client abort request`

### Phase E：gate

- `npm run verify:error-pipeline-contract`
- `npm run verify:provider-failure-ban-blackbox`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-error-chain-bypass`
- `npm run verify:architecture-provider-specific-leaks`
- `npm run verify:architecture-thin-wrapper-only`
- `npx tsc --noEmit --pretty false`

### Phase F：build / install / restart / live

按 rcc-dev-skills / `install-global.sh` 流程执行；记录 `routecodex --version` / `/health` / live `/v1/responses` SSE 完成证据。

## 6. 风险与边界

1. direct path 改造成 unified decision consumer 可能影响 `router-direct-pipeline.spec.ts` / `provider-direct-pipeline.spec.ts` 的本地 retry 假设；必须先跑这两个 spec 确认 baseline，再做改造。
2. `http-error-mapper.policy-exhausted-gate` 改造需要新的元数据载体（policy-exhausted 标志），必须放在已有的 `ErrorErr*` 链 carrier，不得新开第二通道。
3. default pool 扩池：Jason 已选择 `primary_exhausted -> default_pool`；执行边界是 Rust/VR selection 显式建模，host 仍不得偷偷补 fallback。
4. client_disconnect 识别：必须前移到 `error.provider_failure_policy` 分类阶段；不得在 client projection 才“事后擦除”状态。
5. 物理删除：F9 的旧错误设计删除前必须确认所有调用方已迁移到统一 decision 路径。

### Phase 6.5：偏差收口（D1 + D2 + D3 + P4 已拍板）

> 触发条件：handoff 摘要与 git 实证之间的偏差必须被收口；default pool 扩池已按 Jason 指令采用 Rust/VR Option A。

#### P1 — 补 `provider-direct-pipeline.candidate-exhaustion.spec.ts`
- 状态：文件已存在，待本轮 gate 重跑
- 正向 case：单绑定端口 `provider-direct.onProviderError` 收到 recoverable 5xx → 必须消费 `resolveRequestExecutorProviderFailurePlan` 的 decision
- 反向 case：单绑定端口 `provider-direct` 收到 `client_disconnect` → `affectsHealth=false` 且不投影 4xx 错误体
- 反向 case：单绑定端口 `provider-direct` 只剩当前一个 provider 失败时允许 fail-fast
- 边界：provider-direct 不拥有 route-pool 扩展，不合成 reroute；它只消费 decision 并进入最终投影边界
- 关联 file-map：`error.execution_decision_consumer`

#### P2 — 拆 `index.ts:1752-1767` 的 `suppressRouterDirectRetry` 早返回
- 状态：当前文件已无 `suppressRouterDirectRetry` guard，待本轮 candidate-exhaustion spec 重跑
- 移除 `suppressRouterDirectRetry` 变量与旧 line 1752-1756 守卫
- 移除旧 line 1765-1767 的 `exclude_and_reroute + isClientDisconnectLikeError` 二次 if
- 把 client_disconnect 的"不计 cooldown / 不投影"职责完全交给：
  1. `isProviderFailureHealthNeutral(args.error) === true`（provider 阶段）→ 不会进入 `affectsHealth=true` 链路
  2. `isClientDisconnectLikeForProjection(...)`（projection 阶段）→ 收口为 HTTP 204 + `CLIENT_DISCONNECTED` 码
- 任何"已 decision 后是否还递归重打"统一由 `directAttempt < retryState.maxAttempts` 控制
- 关联 file-map：`error.execution_decision_consumer`

#### P3 — live replay / live probe 证据口径修正
- 旧版："客户端收到 499/CLIENT_DISCONNECTED"
- 新版："客户端**收不到任何错误体**（HTTP 204，或 SSE 中无 `event:error`，或响应体里无 `client abort request`/`client abort request` 文本）"
- live replay 脚本断言改为 grep 响应里 `client abort request` / `HTTP 499` 子串必须 0 命中

#### P4 — default pool 扩池（Jason 已拍板：Option A）
- Rust/VR selection 是唯一真源：`select_provider_falls_to_default_route_when_requested_route_is_exhausted` 锁 requested route exhausted 后进入 `default` route。
- `primary_exhausted_to_default_pool` contract/native export 只用于显式表达和 gate，不授权 host 本地合成 fallback。
- `request-executor.ts` 只能携带 excluded provider 状态并再次调用 Hub/VR；不得自己拼 default target list。
- 决定落点：本计划 §6.5-P4 / `docs/error-handling-v2.md` §1.0 / `docs/design/provider-failure-policy-ssot.md` / function-map + verification-map。

#### P5 — verification-map integration 段同步
- `docs/architecture/verification-map.yml` 在 `error.provider_failure_policy` / `error.client_projection` / `error.execution_decision_consumer` 三组下补 integration 段：
  - `pnpm run verify:error-pipeline-contract`
  - `pnpm exec jest tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`

#### P6 — note.md → MEMORY.md 提炼
- 提炼到 `MEMORY.md` 2026-06-14：唯一中心不变；direct 错误必须回中心；client_disconnect 前移；候选耗尽才允许 ErrorErr06；provider-direct 偏差已收口
- 旧版本 "handoff 摘要已完成 5 个 spec 13 PASS" 的不实叙事不进入 MEMORY.md

- P6 MEMORY.md 2026-06-14 已追加唯一中心 + 候选优先条款；最终需按本轮 gate/live 结果补证据。

## 8. 与本 plan 一起落盘的另一条 SSE 收口 gap（out-of-scope，登记备查）

- 现象样本：5520 `openai-responses-router-gpt-5.4-20260614T142012141-342968-546`。
  链路：`router-direct` 切到 `cc.key1.gpt-5.4-mini.gpt-5.5` 后，第二候选也超时
  （`UPSTREAM_HEADERS_TIMEOUT`），随后 SSE 流只发 `response.created` 即
  close；客户端 SSE 收到 `event: error code=upstream_stream_incomplete`，
  且 session-request/usage 记 `finish_reason=unknown`。
- 状态：本次 direct-path 修复**已经正确切到第二候选**（日志
  `provider-switch ... switch=exclude_and_reroute ... -> cc.key1.gpt-5.4-mini.gpt-5.5`），
  因此段 1（候选切）已收口；但**段 2（第二候选 SSE 收口）不在本 plan 范围**，
  也没有任何反向红测锁住 "第二候选 `upstream_stream_incomplete` 时
  客户端 SSE 不得出现 `finish_reason=unknown`"。
- 责任 owner：`src/modules/llmswitch/bridge/responses-response-bridge.ts:1376`
  投影 `upstream_stream_incomplete`；`src/server/handlers/handler-response-utils.ts`
  的 SSE finishReason 推导；与 `handler-response-utils.sse-finish-reason.spec.ts`
  既有 RED 关系密切。
- 处置：另起新 plan `docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md`
  收口；本 plan 不动代码、不补 spec。来源：用户 2026-06-14 给的 live 日志段。

## 7. 完成信号

1. `error.provider_failure_policy` 是仓内唯一允许产生 `classification + affectsHealth` 的地方
2. `router-direct` / `provider-direct` 错误都进入统一 decision 消费路径
3. `ErrorErr06ClientProjected` 不会再把“未 exhausted”的 provider 4xx 投影给客户端
4. `client_disconnect` 不再被当作 provider failure / cooldown / provider-visible 4xx
5. primary pool exhausted 的下一步走向由 VR 显式定义为 `primary_exhausted -> default_pool`
6. 所有红测 + 旧样本在线重放 + live probe + gate + build/install/restart 均 PASS
7. `note.md` 提炼已验证结论到 `MEMORY.md`

## 8. 相关引用

- `docs/error-handling-v2.md` §1.0
- `docs/design/provider-failure-policy-ssot.md` Rule 1/3/4 补充边界
- `docs/design/error-pipeline-contract-and-routing-audit.md`
- `docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md`
- `docs/goals/error-module-function-map-closeout-plan.md`
- `.agents/skills/rcc-dev-skills/references/40-owner-registry.md`
- `.agents/skills/rcc-dev-skills/references/70-gate-discovery.md`
- `.agents/skills/rcc-dev-skills/references/92-lessons-2026-06.md`
