# Direct / Relay 统一 Provider Error Chain 审计

Last updated: 2026-06-15

## 0. 中心原则 (来自 Jason 2026-06-14)

1. 唯一策略真源：`Virtual Router policy + ProviderFailurePolicy + request-executor error action queue`。
   不要复活独立 `ErrorHandlingCenter`。
2. 候选优先：当前 route pool（以及产品允许的 secondary/default pool）仍有 provider 时，
   provider 执行期错误**必须先进入统一错误链**做计数 / 冷却 / 切 provider，
   候选全部耗尽才允许投影客户端。
3. `router-direct` / `provider-direct` 允许 payload / response passthrough，但
   错误策略不得 passthrough：direct consumer 必须消费 `ErrorErr05ExecutionDecision`。
4. `client_disconnect`（HTTP_499 + `client abort request` / `client closed request`）
   永不算 provider failure：不计 health、不计 cooldown、不投影 provider-visible 4xx；
   投影必须落到 204/CLIENT_DISCONNECTED。
   **2026-06-15 校正：客户端断开 = 服务器端立即停请求，保持断开。** 不再投影
   204/CLIENT_DISCONNECTED 之类的"礼貌"返回；不再做任何记录层面的伪装。直接停。
5. `primary_exhausted -> default_pool` 是 VR contract，禁止在 host 层做本地 fallback。

## 1. 当前真源（已证实）

| 段 | 唯一真源 | 文件 |
| --- | --- | --- |
| Provider error 分类（classify / affectsHealth / action） | `ProviderFailurePolicy` | `src/providers/core/runtime/provider-failure-policy.ts` |
| 错误统一动作队列（1s->2s->3s blocking wait） | `request-executor-error-action-queue` | `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts` |
| Router direct reroute decision（统一 decision consumer） | `decideDirectRouterRetry` | `src/server/runtime/http-server/direct-decision.ts` |
| Provider direct decision（统一 decision consumer） | `decideDirectProviderRetry` | `src/server/runtime/http-server/direct-decision.ts` |
| Client projection | `mapErrorToHttp` / `ErrorErr06ClientProjected` | `src/server/utils/http-error-mapper.ts` |
| Client disconnect 识别 | `isClientDisconnectLikeError` / `isClientDisconnectLikeForProjection` | `src/server/runtime/http-server/direct-client-disconnect.ts`、`src/server/utils/http-error-mapper.ts` |
| Primary exhausted -> default pool | `plan_primary_exhausted_to_default_pool` (Rust) | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/primary_exhausted_to_default_pool_blocks.rs` |

## 0.1 2026-06-15 三条硬护栏（Jason 拍板）

1. **provider-mode 端口失败直接返回**。
   - 显式豁免"只要还有 provider 就不中断"中心原则。
   - `decideDirectProviderRetry` 强制 rethrow 保留。
   - 不得退回 routingPolicyGroup。
2. **任何路由池空都切 default**；**每个模型拉黑前都校验**：
   - 拉黑这个模型是否会让 default 池空。
   - 如果会让 default 池空 → **禁止拉黑**，仍按可服务处理。
   - 这条规则必须落在唯一真源上（Rust `plan_primary_exhausted_to_default_pool`
     的扩池 / cooldown 决策前必须先做"default-pool-still-usable"检查），host 不得本地合成。
3. **客户端断开 = 服务器端立即停请求、保持断开**。
   - 不再投影 204 / CLIENT_DISCONNECTED。
   - 不再补 log；记录只用于内部去重，不再做对外响应。
   - 客户端连接断了，请求就停；不要再写任何"礼貌"返回或兼容壳。

## 2. 现状（已读代码证实）

### 2.1 Router-Direct 决策已经接进统一链
- `src/server/runtime/http-server/index.ts:1630-1780` 的 `onProviderError` 已经：
  - `resolveRequestExecutorProviderFailurePlan` 拉统一 ErrorErr05 plan
  - `decideDirectRouterRetry` 决定 `request_reroute` / `rethrow`
  - 失败时把 `retryState.excludedProviderKeys` 累加、再 `executeRouterDirectPipelineForPort(... directAttempt + 1)` 递归
- `decideDirectRouterRetry` 在以下情况 rethrow：
  1. `isClientDisconnectLikeError` 命中（`direct-decision.ts:108`）
  2. 超过 maxAttempts
  3. 无 retryable plan 或 switchAction 既不是 `exclude_and_reroute` 也不是 `retry_same_provider_once`
  4. 当前 provider 被排除后剩余 candidates <= 0
- 该路径**已经消费**了 Router 决策，不算"report-only"。

### 2.2 Provider-Direct 决策被强制 rethrow（by design）
- `decideDirectProviderRetry` 永远 rethrow（`direct-decision.ts:158-170`）
- 因为 provider-mode 端口只绑一个 provider，没有同端口扩池能力。
- 这条路径在 `index.ts:2101-2170` 走 `reportRequestExecutorProviderError` 一次性上报到 VR。
- 候选耗尽的最终投影由 `ErrorErr06` 走 `mapErrorToHttp` 落 HTTP。
- **风险**：当 `provider-mode` 端口的 provider 持续失败时，没有 secondary provider 切，只能 rethrow
  落到 5xx。Jason 中心原则要求"只要还有 provider 就不应中断对话"，但 provider-mode 端口本身就是
  单点 binding，这违反了中心原则，需要在 spec 上显式决定（见 §3 G2）。

### 2.3 Client projection 在 ErrorErr06 确实做 499 -> 204
- `http-error-mapper.ts:170-185` `isClientDisconnectLikeForProjection` 已经识别
  `status === 499 || code === 'HTTP_499'` + `hints.includes('client abort request')`
  并返回 204 + `CLIENT_DISCONNECTED`。
- `http-error-mapper.ts:275-300` `assertErr05DecisionIsProjectable` 同样会
  `client_disconnect` 短路。
- **统一决策链上 499 应当被识别为 client_disconnect。**

### 2.4 primary_exhausted -> default_pool 没接进 host
- `planPrimaryExhaustedToDefaultPoolNative` 已经在
  `src/modules/llmswitch/bridge/native-exports.ts:633` 暴露。
- 但 host（`request-executor.ts`、`http-server/index.ts`）**没有调用方**：
  ```text
  $ grep -rn planPrimaryExhaustedToDefaultPoolNative src/ sharedmodule/llmswitch-core/src/
  src/modules/llmswitch/bridge/native-exports.ts:633  (definition only)
  ```
- 当前 primary pool 耗尽后，`request-executor.ts:585-660` 走的是
  `provider.route_pool_cooldown_wait` + `hub.pool_exhausted.backoff_wait` 阻塞退避
  （3 次 1s/2s/3s），失败后直接 throw `lastError`。**没有 default pool 扩池。**

## 3. Gap（按用户问题逐条对账）

### G1. 用户报错日志里 499 真的直接返客户端了吗？ — 是。
证据：
- 用户 06-15 08:52:30 日志：
  ```
  [router-direct.send]... statusCode=499 errorCode=HTTP_499 message="Upstream rejected the request" directAttempt=1
  ❌ [/v1/responses] 08:52:30 request ... failed: HTTP 499: {"error":{"message":"client abort request"...}}
  ```
- 链路决策：
  - `isClientDisconnectLikeError` 应当命中（status=499 + code=HTTP_499 + upstreamMessage 包含 "client abort request"）
  - `decideDirectRouterRetry` rethrow
  - 错误应当流到 `ErrorErr06ClientProjected` → `mapErrorToHttp` → 204/CLIENT_DISCONNECTED
- 但日志显示 `failed: HTTP 499`。**说明 ErrorErr06 没被走或走了 fallback 路径**。
- 待验证（不修，只看代码）：
  - 是不是 `http-error-mapper` 前面某个 error try/catch 已经把 `status: 499` 替换成 raw 499 抛出，绕过了 `ErrorErr06`？
  - 是不是 router-direct 在 `rethrow` 后上游存在另一个 try/catch 直接 `res.status(499).json(...)`？
  - 还是 `extractStatusCodeFromError(error)` 在 router-direct caller 抛了 `Error` 后没有把 status 传过去？

### G2. provider-mode 单点 binding 与"永远不中断"中心原则冲突
- 当前 `decideDirectProviderRetry` 强制 rethrow。
- Jason 中心原则说"只要还有 provider 就不应中断"，但 provider-mode 端口只绑一个 provider。
- 选项：
  1. host 显式定义：provider-mode 端口本来就是单点承诺；该端口 binding 失败 = 客户端必须看到错误。
  2. host 在 provider-mode 端口 bind 的 provider 失败时，转入路由模式（用 `routingPolicyGroup`）走 VR。
- 选项 2 会改变产品语义，需要 Jason 拍板。

### G3. primary_exhausted -> default_pool 未接入
- Rust 端 `plan_primary_exhausted_to_default_pool` 已经存在并有 napi bridge。
- TS 端 `planPrimaryExhaustedToDefaultPoolNative` 暴露但无 host 调用。
- `request-executor.ts` / `http-server/index.ts` 仍在用阻塞退避（1s/2s/3s）打回 VR。
- 用户最新指令 "primary_exhausted -> default_pool" 表示需要把这条扩池路径接进 host。

### G4. router-direct 的 passthrough 错误还可能在 SSE/stream 半路被 swallow
- 用户没贴新 sample，但已知：
  - `response.sse.stream` 收口前如果 `processIncomingDirect` throw，会进入 `onProviderError`，
    但 SSE 半路错误在 `http-server/index.ts:1653-1700` 处理时**还没**消费统一 plan。
  - `direct-result-metadata-propagation.spec.ts` 等只锁 success path，没锁 midstream error。

### G5. 错误码命名不一致导致 decideDirect* 漏判
- provider runtime 当前把 upstream `499 + client abort request` wrap 成
  `statusCode: 499, errorCode: 'HTTP_499', message: 'Upstream rejected the request'`。
- host 包装时把"client abort request"塞进 `error.details.upstreamMessage` 或
  `error.response.data.error.message`。
- `isClientDisconnectLikeError` 当前依赖 `message` / `upstreamMessage` 包含 "client abort request"。
- **风险**：如果某次包装把 `upstreamMessage` 丢了（例如 snapshot/telemetry stage 重新构造 error），
  就会让 499 走正常 4xx 分支而不是 client_disconnect。

### G6. http-error-mapper 的 4xx 投影先于 client_disconnect 短路？
- 重读 `mapErrorToHttp`：
  1. `MALFORMED_REQUEST` -> 400
  2. `isClientDisconnectLikeForProjection(...)` -> 204
  3. timeout hint -> 504
  4. 429 -> 429
  5. 401/403 -> 原样
  6. 501 -> 501
  7. `status >= 400 && < 500` -> 原 status
- 短路顺序没问题。`isClientDisconnectLikeForProjection` 在第 2 步就会把 499 拉到 204。

## 4. 设计校正（已与现有 SSOT 对齐）

唯一真源不变。direct 与 relay 共用同一套 ErrorErr05 plan + 同一套 client_disconnect 识别 +
同一套 `mapErrorToHttp` 投影；差异只在"扩池能力"：
- `router-mode` 端口：error 后由 `decideDirectRouterRetry` 排除当前 provider 并递归同一 direct pipeline，
  直到 pool 耗尽再交 ErrorErr06。如果 pool 耗尽且 VR 提供 default pool plan，则再扩池一轮。
- `provider-mode` 端口：error 后由 `decideDirectProviderRetry` 强制 rethrow（Jason 拍板选项 1 / 选项 2）。

## 5. 修复计划（按 owner、必须先红后绿 + 在线复测）

### Phase A. 文档先固化（本轮）
- 本文即审计与设计真源。
- 同步更新 `docs/error-handling-v2.md` §1.0.1/1.0.2/1.0.3，把 "primary exhausted ->
  default pool" 列入"必须消费"项，把"client_disconnect 永不算 provider failure"列入硬规则。
- 同步更新 `docs/design/provider-failure-policy-ssot.md` §Rule 1/3/4：
  - Rule 1 补"只有当前合法候选集合 + default pool plan 都耗尽时，才允许 direct return"。
  - Rule 3 补"router-direct 在排除当前 provider 后剩余 candidates <= 0 时，必须把
    pool exhaustion 交给 `plan_primary_exhausted_to_default_pool`，由其结果决定
    next_attempt 的 allowedProviders"。
  - Rule 4 补"client_disconnect 必须前移到 `error.execution_decision_consumer` 入口处
    （`decideDirectRouterRetry` / `decideDirectProviderRetry`），并在 ErrorErr06 投影前
    二次确认"。
- 同步 `docs/architecture/function-map.yml`：
  - `virtual_router.primary_exhausted_to_default_pool` 标 `pending_consumer`，并指出 host 端
    `request-executor.ts:585-660` 是待替换位。
- 同步 `docs/architecture/verification-map.yml`：
  - 列出 `verify:provider-error-direct-relay-unified-chain` 作为新 gate。

### Phase B. 修 G3：把 primary_exhausted -> default_pool 接入 host
1. 红测（先红）：
   - `tests/server/runtime/http-server/router-direct-pipeline.primary-exhausted-default-pool.spec.ts`
     模拟 `routeResult.target = null` 且 `isPoolExhaustedPipelineError` 命中。
     期望：host 调用 `planPrimaryExhaustedToDefaultPoolNative` 后把
     `defaultPoolTargets` 灌进 `allowedProviders` 并再调一次
     `executeRouterDirectPipelineForPort`。
   - `tests/server/runtime/http-server/executor/request-executor.primary-exhausted-default-pool.spec.ts`
     同样在 `request-executor.ts:585-660` 处模拟 `PROVIDER_NOT_AVAILABLE`，
     期望 `resolvePrimaryExhaustedPlan` 给到 `default_pool`，并把 candidates 重置。
2. 绿：改 `request-executor.ts` 阻塞退避 + retry 之前的 catch 块；改
   `http-server/index.ts` 的 `isPoolExhaustedPipelineError` 分支。两者都必须显式
   调 `planPrimaryExhaustedToDefaultPoolNative`，并以该返回的
   `defaultPoolTargets` 作为下一轮 allowedProviders，**禁止 host 本地合成 default pool 链**。
3. 旧样本在线复测：
   - 用 5555 触发 1token 5xx、观察 `[router-direct.primary_exhausted_to_default_pool.applied]`
     日志；缺这条日志 = 接入失败。
   - 用 5520 触发同一 provider 5xx；观察同一条日志 + 切到 default pool 成功。

### Phase C. 修 G1/G5：让 client_disconnect 真正落到 204
1. 红测（先红）：
   - `tests/server/handlers/handler-utils.client-disconnect.spec.ts`
     模拟 `decideDirectRouterRetry` 命中 `isClientDisconnectLikeError` 后 rethrow
     上来到 `logRequestError`，期望日志里写 `failed: HTTP 204` 而非 `failed: HTTP 499`。
   - `tests/server/utils/http-error-mapper.client-disconnect.spec.ts`
     模拟上游 body = `{"error":{"message":"client abort request"...}}`、host wrap 后
     `statusCode=499 errorCode=HTTP_499 message="Upstream rejected the request"`，
     期望 `mapErrorToHttp` 返 204 + `CLIENT_DISCONNECTED`。
   - `tests/server/runtime/http-server/router-direct-pipeline.client-disconnect.spec.ts`
     在 `executeRouterDirectPipelineForPort` 直接 throw client_disconnect 错误，
     期望最终 res.status === 204 且 body 包含 `code: "CLIENT_DISCONNECTED"`。
2. 绿：定位真正的 `res.status(499)` 投影点（预计在 router-direct caller 上的
   `extractStatusCodeFromError` 透传），改成走 `ErrorErr06`。
3. 旧样本在线复测：用 5555 制造一个 client abort（curl --max-time 1）；
   期望日志是 `failed: HTTP 204 (status=204 code=CLIENT_DISCONNECTED)`，且 provider health
   没有 cooldown 增量。

### Phase D. 修 G2：provider-mode 单点 binding 决策
- 选项 1（保守）：host 在 `decideDirectProviderRetry` 旁增加 `provider_mode_allow_relay_on_failure`
  flag，端口显式声明才允许 host 走"provider-mode 失败 -> 切到 routingPolicyGroup"。
- 选项 2（中心原则最强）：端口 spec 必须显式声明 single-binding；声明后，host 失败
  直接 rethrow 不扩池，与中心原则的"还有 provider 就不应中断"差异必须由 spec
  显式豁免。
- 等 Jason 拍板（见 §6 决策项）。

### Phase E. 修 G4：SSE 半路 error 进入统一链
1. 红测：midstream error（`response.sse.stream` 已经发了 N 帧后 provider 报错），
   期望 SSE 关闭前先 emit 一帧 `event: error` + 客户端投影走 5xx/4xx 而非被吃掉。
2. 绿：把 midstream error 也路由到 `decideDirectRouterRetry`（在 `processIncomingDirect`
   的 promise 包装层 catch）。

### Phase F. 收口验证
- `pnpm jest tests/server/runtime/http-server/direct-*.spec.ts tests/server/runtime/http-server/router-direct-*.spec.ts tests/server/runtime/http-server/provider-direct-*.spec.ts tests/server/handlers/handler-utils.client-disconnect.spec.ts tests/server/utils/http-error-mapper.client-disconnect.spec.ts tests/server/runtime/http-server/executor/request-executor.primary-exhausted-default-pool.spec.ts --runInBand`
- `pnpm jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts --runInBand`
- `node scripts/build-core.mjs` + `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- root `npx tsc --noEmit --pretty false`
- `npm run verify:architecture-error-chain-bypass` 新增
- live：5555 / 5520 / 10000 三端口 0.90.3071 升级、curl 三条用例。

## 6. 决策项（需 Jason 拍板）

- D1：provider-mode 端口在 provider 失败时是否允许 host 退回 routingPolicyGroup 走 VR？
  默认 = 否（保守），等显式 flag。
- D2：primary_exhausted -> default pool 触发时，host 是否允许跳过阻塞退避直接走 default pool？
  默认 = 允许（中心原则优先）。
- D3：client_disconnect 在 ErrorErr06 投影时是否连 `usageLogInfo` 都不写？
  默认 = 写 `providerKey=client_disconnect, routeName=client_disconnect`，避免 usage 漏算。

## 7. 完成定义

- D1/D2/D3 由 Jason 拍板。
- Phase A 文档已落盘并被引用。
- Phase B-F 全部先红后绿、live 复测通过。
- 红测/复测日志共同证明：
  - 499 不再走到客户端 status=499；
  - primary 池耗尽后自动切 default pool；
  - direct 与 relay 共用同一套 ErrorErr05 plan / 同一套 client_disconnect / 同一套投影；
  - 一个 provider 错误不再"拖死一个 session"（除 D1 选否时的 provider-mode 单点）。

## 8. /goal 提示词（落地修复执行）

```
/goal
主目标：
  把 direct 与 relay 的 provider 错误统一进入 ErrorErr05 plan 消费链，并把
  primary_exhausted -> default_pool 接入 host；保证一个 provider 错误不会再
  拖死一个 session（除 provider-mode 单点 binding 由 Jason 显式豁免）。

实现文档：
  - docs/goals/direct-relay-unified-error-chain-audit.md（本文件，权威真源）
  - docs/error-handling-v2.md §1.0.1/1.0.2/1.0.3（同步）
  - docs/design/provider-failure-policy-ssot.md §Rule 1/3/4（同步）
  - docs/architecture/function-map.yml、docs/architecture/verification-map.yml（同步）

执行规范：
  - 严格按 Phase A -> B -> C -> D -> E -> F 顺序执行；
  - 每个 Phase 必须先红测（红->绿）再改唯一 owner；
  - 不允许 host 层在 primary pool 耗尽后合成 default pool 链；
  - direct/relay 两条链必须共用同一套 ErrorErr05 plan 消费与同一套 client_disconnect 识别；
  - 不允许 router-direct 在客户端投影出 499；client_disconnect 必须落到 204/CLIENT_DISCONNECTED；
  - provider-mode 单点 binding 由 Jason 显式 flag 控制是否允许转 routingPolicyGroup。

验证要求：
  - 单元 + 红测：见 Phase F 命令；
  - 编译：`node scripts/build-core.mjs`、root + llmswitch-core tsc；
  - 构建/安装/重启：Node 22 `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`；
  - 在线复测：5555 / 5520 / 10000 三个端口、curl 三条用例：
    1. client abort 制造 499 -> 期望 204/CLIENT_DISCONNECTED 且 provider health 无 cooldown；
    2. 制造 primary pool 5xx 耗尽 -> 期望日志
       `[router-direct.primary_exhausted_to_default_pool.applied]` + default pool 成功；
    3. provider-mode 端口故障 -> 按 D1 决策决定行为，并在审计报告里记下。

完成标准：
  - 本文件 §7 全部勾完；
  - live 复测日志与单测结果均贴回本文件 §7 末尾；
  - CACHE.md 写入本次 closeout 时间戳与版本号；
  - MEMORY.md 追加 "2026-06-15 unified direct/relay provider error chain closeout" 记录。
```
