# Provider Error Chain — Direct / Relay Unified Audit (2026-06-15)

> Owner: Jason
> Date: 2026-06-15
> Status: audit finalized, no runtime changes in this round
> Last updated: 2026-06-15
> Theme: 统一 direct 与 relay 的 provider error 处理链；候选优先 / primary_exhausted -> default_pool 接入；client_disconnect 不再投影到客户端

本文件是 `docs/error-handling-v2.md` §1.0 + `docs/design/provider-failure-policy-ssot.md` + 已存的
`docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` /
`docs/goals/direct-relay-unified-error-chain-audit.md` 的最终收口。
它**只描述审计结论与修复顺序**，不写实现；实现切到本 plan §5 顺序后单独走 commit。

## 0. 中心原则（来自 Jason 2026-06-14 拍板 + 2026-06-15 校正）

1. 唯一策略真源 = `Virtual Router policy + ProviderFailurePolicy + request-executor error action queue`。
   不得复活独立 `ErrorHandlingCenter` 第二中心。
2. 候选优先：当前 route pool（以及产品允许的 secondary/default pool）仍有 provider 时，provider
   执行期错误**必须先进入统一错误链**做计数 / 冷却 / 切 provider；候选全部耗尽才允许投影客户端。
3. `router-direct` / `provider-direct` 允许 payload / response passthrough，但**错误策略不得 passthrough**：
   direct consumer 必须消费 `ErrorErr05ExecutionDecision`。
4. `client_disconnect`（HTTP_499 + `client abort request` / `client closed request` / `CLIENT_DISCONNECTED`）
   永不算 provider failure：不计 health、不计 cooldown、不投影 provider-visible 4xx；
   2026-06-15 校正 = 客户端断开 = 服务器端立即停请求、保持断开，不再投影 204/CLIENT_DISCONNECTED
   之类的"礼貌"返回，也不再做记录层面的伪装。
5. `primary_exhausted -> default_pool` 是 VR contract，禁止 host 层做本地 fallback。
6. provider-mode 单点 binding 失败 = 直接 rethrow（Jason 2026-06-15 拍板选项 1），
   由 spec 显式豁免"只要还有 provider 就不中断"中心原则。
7. `upstream_stream_incomplete`（post-send SSE 半路收口）必须**进入**统一错误链，候选耗尽前不得
   client-visible；如已向 client 发出语义帧，则 fail-fast 不重试。

## 1. 当前真源（已读代码 + log 证实）

| 段 | 唯一真源 | 文件 |
|---|---|---|
| Provider error 分类（classify / affectsHealth / action） | `ProviderFailurePolicy` | `src/providers/core/runtime/provider-failure-policy.ts` |
| 错误统一动作队列（每次固定 3s blocking wait） | `request-executor-error-action-queue` | `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts` |
| Router direct reroute decision（统一 decision consumer） | `decideDirectRouterRetry` | `src/server/runtime/http-server/direct-decision.ts` |
| Provider direct decision（统一 decision consumer） | `decideDirectProviderRetry` | `src/server/runtime/http-server/direct-decision.ts` |
| client_disconnect 识别 | `isClientDisconnectLikeError` / `isClientDisconnectLikeForProjection` | `src/server/runtime/http-server/direct-client-disconnect.ts`、`src/server/utils/http-error-mapper.ts` |
| Client projection | `mapErrorToHttp` / `ErrorErr06ClientProjected` | `src/server/utils/http-error-mapper.ts` |
| Primary exhausted -> default pool | `planPrimaryExhaustedToDefaultPoolNative` (Rust) | `sharedmodule/llmswitch-core/.../primary_exhausted_to_default_pool_blocks.rs` + `src/modules/llmswitch/bridge/native-exports.ts:633` |
| Post-send stream incomplete 触发点 | SSE terminal watch | `src/server/handlers/handler-response-sse.ts:1751` |

## 2. 现状对账（直接证据）

### 2.1 三条样本的真实走向
- 样本 A — 5555 HTTP_499 + "client abort request"：进入 `decideDirectRouterRetry` 反向分支 1
  → rethrow → 上抛至 `respondWithPipelineError` → 走 `mapErrorToHttp` → 命中
  `isClientDisconnectHttpProjectionCandidate` 短路返回 `formatPayload(204, CLIENT_DISCONNECTED)`
  → `terminateClientDisconnectedResponse(res, requestId, 'json')` 走"只 `res.end()`、不写
  body / 不写 status"路径。**实测日志中 `❌ [endpoint] ... failed: HTTP 499` 是服务端
  `console.error` 打印的 `mapErrorToPublicLogSummary(error, fallback)`，其中 fallback =
  `error.message` = `"HTTP 499: {...}"`**（raw error.message 回放，不是 client-visible
  status）。**客户端实际拿到的是"连接断开、零响应体"，符合 §0.4 校正**。`G1` 红测
  `handler-utils.client-disconnect.spec.ts` 已 GREEN（2 PASS / 0 FAIL）证明短路路径生效。
  剩余 risk = server log 的 `failed: HTTP 499` 字样会被误读为"provider 5xx"，需要在 G1
  收尾时由 timing summary 标注 `client_disconnect=true` 区分（写入 G1 收尾）。
- 样本 B — 5520 UPSTREAM_HEADERS_TIMEOUT：进入 `decideDirectRouterRetry` `request_reroute`
  → `provider-switch 1token -> cc.key1` 已发生，候选 ≥ 2 时切候选正常。
- 样本 C — 5520 `upstream_stream_incomplete`（stream closed before response.completed）：**完全
  没有**进 `resolveRequestExecutorProviderFailurePlan`，也**没有**进 `decideDirectRouterRetry`：
  `usage day.calls=1 day.fail=0 finish_reason=unknown` — provider 不被记 fail；同一 provider
  下一次被选中时不会因为"stream cut"被排除。**这是当前最实质的 gap**。

### 2.2 codex-samples 与 `note.md` 已记录的相关结论
- relay stopless CLI projection 仓库黑盒 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  仍把"relay `/v1/responses` 向客户端投影 exec_command CLI"当作正向合同。
- 5555 在 `0.90.3065` 出现过的 `captureReqInboundResponsesContextSnapshotJson is required but unavailable`
  与后续成功样本在同一 live 运行窗口内共存，归为实例态/装载态不稳定，不属"当前功能永久缺失"。
- responses outbound 已经在 Rust owner 上做 replay-safe 清理（`reasoning.content` 剥离、`status`
  剥离、`output_text/commentary -> input_text` 合法化），与本审计独立。

## 3. Gap 列表（最终 10 条，编号 = 执行顺序）

> 编号顺序为最终执行顺序 `G1 → G3 → G6 → G5 → G7 → G10 → G2 → G4 → G9`。
> `G8` 不再单列，已并入 G3（primary_exhausted）和 G6（client_disconnect）。

| ID | Gap 描述 | 唯一 owner | 修复要点 | 反向 / 正向红测 |
|---|---|---|---|---|
| **G1** | `client_disconnect` 未真正落到 204，且当前 router-direct caller 错误透传会让客户端收到 499 | `src/server/handlers/handler-utils.ts::respondWithPipelineError` + `src/server/utils/http-error-mapper.ts` | 校正：客户端断开 = 服务器端立即停请求保持断开，**不再投影 204/CLIENT_DISCONNECTED**；仅做内部去重记号，禁止对外响应。 | 反：caller rethrow 路径不能再 `res.status(499).json({...})`；正：内部日志/usage 仍记 `client_disconnect`，但 client 端拿不到任何错误体 |
| **G3** | `primary_exhausted -> default_pool` 未接入 host；`request-executor.ts` 仍走 1s/2s/3s 阻塞退避后 throw `lastError` | Rust 真源 `plan_primary_exhausted_to_default_pool` + `src/server/runtime/http-server/request-executor.ts` + `src/server/runtime/http-server/index.ts` 的 `isPoolExhaustedPipelineError` 分支 | host 必须显式调 `planPrimaryExhaustedToDefaultPoolNative`，把返回的 `defaultPoolTargets` 灌进下一轮 `allowedProviders`；**禁止 host 本地合成 default pool 链** | 正：primary 耗尽后自动切 default；反：不允许 host 偷偷补 fallback |
| **G6** | `upstream_stream_incomplete` 绕过 provider failure policy；同一 provider 连续 stream cut 不会被切/冷却/重试 | `src/server/handlers/handler-response-sse.ts:1751` raise 点 + `src/providers/core/runtime/provider-failure-policy-impl.ts` 分类扩展 | stream incomplete 必须进 `resolveRequestExecutorProviderFailurePlan` + `decideDirectRouterRetry`；已向 client 发语义帧的协议例外由 spec 显式豁免并走 `fail-fast` | 正：2+ 候选时第二候选 stream incomplete → 切到第三候选；反：完整 Responses SSE (`response.completed` + `response.done`) 不发 `upstream_stream_incomplete` |
| **G5** | 错误码 wrap 可能让 `upstreamMessage` 丢失 → `isClientDisconnectLikeError` 漏判 → 499 走普通 4xx 分支 | `src/providers/core/runtime/provider-failure-policy-impl.ts:115-170` + `src/providers/core/utils/provider-error-reporter.ts` | 在 provider-failure-policy 入口处先看 `status=499` 短路，再看 `upstreamMessage`；保留 `upstreamMessage` 在 `error.details.upstreamMessage` 和 `error.response.data.error.message` 两路 | 反：wrap 后丢 upstreamMessage 也不能让 499 走普通 4xx；正：标准 499 + "client abort request" 必命中 client_disconnect |
| **G7** | `http-error-mapper` 对 `400 <= status < 500` 过早投影 | `src/server/utils/http-error-mapper.ts:227` + `assertErr05DecisionIsProjectable` | 加 `policy exhausted` / `candidate exhausted` 前置门：未 exhausted 的 provider 4xx 不得走 `Upstream rejected the request` 早投影 | 正：未 exhausted 不投影；反：exhausted 后仍能正常投影 |
| **G10** | `provider-mode` 端口的 `decideDirectProviderRetry` 永远 rethrow；缺 spec 显式豁免"还有 provider 就不中断"中心原则 | `src/server/runtime/http-server/direct-decision.ts:158-170` + 端口 spec | Jason 拍板选项 1：provider-mode 单点 binding 失败 = 直接 rethrow；**spec 显式豁免**中心原则，并把"provider-mode single-binding"作为端口属性登记到 config schema | 正：provider-mode 失败直接 5xx；反：不允许 host 偷偷退回 routingPolicyGroup |
| **G2** | `router-direct` 注释 `Fail-fast: no fallback` 与本计划冲突；JSDoc / 契约未声明"payload passthrough 保留，error passthrough 删除" | `src/server/runtime/http-server/router-direct-pipeline.ts:9` JSDoc + 端口 spec | JSDoc 与端口 spec 同步；删除误导性 `no fallback` 字样 | 反：禁止把"no fallback"理解为"error passthrough" |
| **G4** | router-direct 的 passthrough 错误还可能在 SSE/stream 半路被 swallow | `src/server/handlers/handler-response-sse.ts` midstream error 包装层 + `src/modules/llmswitch/bridge/responses-response-bridge.ts` | midstream error 必须路由到 `decideDirectRouterRetry`（在 `processIncomingDirect` promise 包装层 catch）；已 emit 语义帧时 fail-fast | 正：midstream error 切候选；反：已 emit 语义帧不重试 |
| **G9** | 旧错误设计物理删除：`router-direct / provider-direct` 报告后立即 rethrow 的死语义；`http-error-mapper` 普通 4xx 早投影分支；任何 host 端 `default fallback` 尝试 | 全部 owner（物理删除 F9） | 物理删除，不留"以防万一"死代码 | 仓库 `rg` 扫描应 0 命中旧 short-circuit |

### 3.1 已并入的旧编号
- 旧 `D1`（provider-direct spec 已 PASS） → 已存在文件，合并到 **G10**。
- 旧 `D2`（`suppressRouterDirectRetry` 已删） → 合并到 **G7** + **G9**。
- 旧 `D3`（投影应是 204） → 校正为"客户端断开 = 立即停请求保持断开"，合并到 **G1**。
- 旧 `D4`（`upstream_stream_incomplete` 另起 plan） → 收口到 **G6**。
- 旧 `F8`（primary_exhausted 已采用 Option A） → 收口到 **G3**。
- 旧 `G8`（VR 真源 primary_exhausted contract） → 收口到 **G3**。

## 4. 设计校正（已与现有 SSOT 对齐）

唯一真源不变。direct 与 relay 共用同一套 ErrorErr05 plan + 同一套 client_disconnect 识别 +
同一套 `mapErrorToHttp` 投影；差异只在"扩池能力"与"是否已发 client 语义帧"：

- `router-mode` 端口：error 后由 `decideDirectRouterRetry` 排除当前 provider 并递归同一 direct pipeline，
  直到 pool 耗尽再交 ErrorErr06。若 pool 耗尽且 VR 提供 default pool plan，则再扩池一轮（G3）。
  stream 半路错误（G6/G4）走相同 consumer；已 emit 语义帧则 fail-fast。
- `provider-mode` 端口：error 后由 `decideDirectProviderRetry` 强制 rethrow（G10 选项 1），
  spec 显式豁免"还有 provider 就不中断"中心原则。

## 5. 修复顺序（按 Jason 拍板：G1 → G3 → G6 → G5 → G7 → G10 → G2 → G4 → G9）

> 严格按编号顺序执行；每个 Gap 必须"先红测 → 改唯一 owner → 转绿 → live 复测"四步走。
> 红测前不得进入下一步；live 复测失败回到 G0 重判真源。

### Phase A（已在本轮完成）
- 落盘本审计定稿 `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md`。
- 同步 `docs/error-handling-v2.md §1.0` + `docs/design/provider-failure-policy-ssot.md` §Rule 1/3/4。
- 同步 `docs/architecture/function-map.yml` / `verification-map.yml`（2026-06-16 已按本轮
  G3/G4/G5/G6/G7/G10/G2/G9  owner 与验证栈更新；`npm run verify:function-map-compile-gate`
  PASS）。

### Phase B — G1（client_disconnect 真正落到"立即停请求保持断开"）
1. 红测：
   - `tests/server/handlers/handler-utils.client-disconnect.spec.ts` 模拟 router-direct caller
     rethrow 客户端断开错误，期望 client 端**拿不到**任何 4xx/5xx 错误体（HTTP body 为空或 SSE
     立即结束，无 `event: error`）。
   - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts` 模拟 upstream body =
     `{"error":{"message":"client abort request"...}}`、host wrap 后 `statusCode=499`、
     `errorCode=HTTP_499`、message=`"Upstream rejected the request"`，期望
     `mapErrorToHttp` 走 `isClientDisconnectLikeForProjection` 短路，**不再投影 204/CLIENT_DISCONNECTED**，
     而是返回"停请求 + 保持断开"投影。
2. 改唯一 owner：定位 `respondWithPipelineError` 路径里真正的 `res.status(499)` 投影点
   （预计在 router-direct caller 的 `extractStatusCodeFromError` 透传链），把它改走
   `isClientDisconnectLikeForProjection` → "停请求保持断开"。
3. 旧样本在线复测：5555 制造 client abort（curl --max-time 1），期望日志记
   `client_disconnect` 但 client 端无 4xx/5xx 错误体；provider health 无 cooldown 增量。

### Phase C — G3（primary_exhausted -> default_pool 接入 host）
1. 红测：
   - `tests/server/runtime/http-server/router-direct-pipeline.primary-exhausted-default-pool.spec.ts`
     模拟 `routeResult.target = null` 且 `isPoolExhaustedPipelineError` 命中，期望 host 调用
     `planPrimaryExhaustedToDefaultPoolNative` 后把 `defaultPoolTargets` 灌进
     `allowedProviders` 并再调一次 `executeRouterDirectPipelineForPort`。
   - `tests/server/runtime/http-server/executor/request-executor.primary-exhausted-default-pool.spec.ts`
     同样在 `request-executor.ts:585-660` 模拟 `PROVIDER_NOT_AVAILABLE`，期望
     `resolvePrimaryExhaustedPlan` 给到 `default_pool`。
2. 改唯一 owner：
   - `src/server/runtime/http-server/index.ts` 的 `isPoolExhaustedPipelineError` 分支。
   - `src/server/runtime/http-server/request-executor.ts:585-660` 的阻塞退避 + retry catch 块。
   - 两者必须显式调 `planPrimaryExhaustedToDefaultPoolNative`，以返回的 `defaultPoolTargets`
     作为下一轮 `allowedProviders`，**禁止 host 本地合成 default pool 链**。
3. 旧样本在线复测：5555 触发 1token 5xx + 其它主 provider 同时不可用 → 观察
   `[router-direct.primary_exhausted_to_default_pool.applied]` 日志 + 切到 default pool 成功。

### Phase D — G6（upstream_stream_incomplete 进入统一链）
1. 红测：
   - 正向：第二候选 stream incomplete → 切到第三候选；client 端拿到完整
     `response.completed` + `response.done`。
   - 反向：完整 Responses SSE 不能发 `upstream_stream_incomplete`；client 端不会看到该 code。
   - 边界：已 emit 语义帧时 `fail-fast`，不重试（spec 显式豁免）。
2. 改唯一 owner：
   - raise 点：`src/server/handlers/handler-response-sse.ts:1751`。
   - 分类扩展：`src/providers/core/runtime/provider-failure-policy-impl.ts` 增加
     `upstream_stream_incomplete` → `recoverable` 分类。
   - 消费点：`decideDirectRouterRetry` 在 stream-incomplete 时走标准 `request_reroute` 路径。
3. 旧样本在线复测：复现 `openai-responses-router-gpt-5.4-20260614T142012141-342968-546`
   类似请求 → 期望日志出现 `[provider-switch] ... upstream_stream_incomplete` + 切到下一候选。

### Phase E — G5（错误码 wrap 保留 upstreamMessage）
1. 红测：
   - `tests/providers/core/runtime/provider-failure-policy-impl.spec.ts` 模拟 wrap 后丢
     `upstreamMessage` 但 `status=499 + code=HTTP_499` 仍命中 client_disconnect。
2. 改唯一 owner：
   - `src/providers/core/runtime/provider-failure-policy-impl.ts:115-170`
     `isProviderFailureClientDisconnect` 入口处先看 `status=499 || code=HTTP_499` 短路，
     再看 `upstreamMessage`。
   - `src/providers/core/utils/provider-error-reporter.ts` 保证
     `error.details.upstreamMessage` 与 `error.response.data.error.message` 都写上。

### Phase F — G7（http-error-mapper 4xx 早投影加 policy-exhausted 前置门）
1. 红测：
   - 正向：未 exhausted 的 provider 4xx 不再走 `Upstream rejected the request` 早投影。
   - 反向：exhausted 之后的 4xx 仍然正确投影。
2. 改唯一 owner：
   - `src/server/utils/http-error-mapper.ts:227` 普通 4xx 早投影分支。
   - `assertErr05DecisionIsProjectable` 必须把 `policyExhausted=true` / `candidateExhausted=true`
     当成投影前置门。

### Phase G — G10（provider-mode 单点 binding 显式豁免）
1. 红测：
   - `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`
     单绑定端口失败时直接 rethrow，不退回 routingPolicyGroup。
2. 改唯一 owner：
   - `src/server/runtime/http-server/direct-decision.ts:158-170` 强制 rethrow 不变。
   - 端口 spec / config schema 增加 `provider-mode single-binding` 属性显式声明豁免。

### Phase H — G2（JSDoc / 契约同步）
1. 红测：
   - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts` 已有断言覆盖
     JSDoc 描述的契约。
2. 改唯一 owner：
   - `src/server/runtime/http-server/router-direct-pipeline.ts:9` JSDoc 同步。
   - 端口 spec 同步声明 `payload passthrough 保留，error passthrough 删除`。

### Phase I — G4（midstream error 进入统一链）
1. 红测：
   - midstream error（已发 N 帧后 provider 报错）→ SSE 关闭前先 emit 一帧 `event: error`，
     客户端投影走 5xx/4xx 而非被吃掉。
   - 反向：已 emit 语义帧时 `fail-fast`，不重试。
2. 改唯一 owner：
   - `src/server/handlers/handler-response-sse.ts` midstream error 包装层 catch。
   - `src/modules/llmswitch/bridge/responses-response-bridge.ts` promise 包装层 catch。

### Phase J — G9（旧错误设计物理删除）
1. 红测：
   - `rg` 扫描必须 0 命中以下死语义：
     - `router-direct / provider-direct` 报告后立即 rethrow 的"绕过 decision consumer"分支。
     - `http-error-mapper` 普通 4xx 早投影分支（未被 policy-exhausted 门锁住的）。
     - 任何 host 端 `default fallback` 尝试（`request-executor.ts` / `http-server/index.ts`
       偷偷补 default target list）。
2. 物理删除：
   - `src/server/runtime/http-server/index.ts` 中 `suppressRouterDirectRetry` 旧 guard
     （若仍有残留）。
   - `src/server/utils/http-error-mapper.ts` 旧 4xx 早投影分支。

## 6. 决策项（已由 Jason 2026-06-15 拍板）

- **D1**：provider-mode 端口在 provider 失败时是否允许 host 退回 routingPolicyGroup 走 VR？
  - 决定：**否（选项 1）**。provider-mode 端口 = 单点承诺，binding 失败 = 客户端必须看到错误。
  - 落点：**G10** + 端口 spec 显式豁免字段。
- **D2**：primary_exhausted -> default pool 触发时，host 是否允许跳过阻塞退避直接走 default pool？
  - 决定：**允许**。中心原则优先。**G3** 接入 host。
- **D3**：client_disconnect 在 ErrorErr06 投影时如何处理？
  - 决定：**2026-06-15 校正** = 客户端断开 = 服务器端立即停请求、保持断开；不再投影
    204/CLIENT_DISCONNECTED；内部日志/usage 仍记 `client_disconnect` 做去重，不再做对外响应。
  - 落点：**G1**。

## 7. 风险与边界

1. `router-direct` / `provider-direct` 改造成 unified decision consumer 可能影响
   `router-direct-pipeline.spec.ts` / `provider-direct-pipeline.spec.ts` 的本地 retry 假设；
   改造前必须先跑这两个 spec 确认 baseline。
2. `http-error-mapper` 增加 `policy exhausted` 前置门需要新的元数据载体（`policyExhausted` /
   `candidateExhausted` 标志），必须放在已有 `ErrorErr*` 链 carrier，不得新开第二通道。
3. default pool 扩池：执行边界是 Rust/VR selection 显式建模，host 仍不得偷偷补 fallback。
4. client_disconnect 识别：必须前移到 `error.provider_failure_policy` 分类阶段；不得在
   client projection 才"事后擦除"状态。
5. 物理删除：G9 删除前必须确认所有调用方已迁移到统一 decision 路径。

## 8. 完成定义（DoD）

- Phase A 本审计定稿已落盘并被引用。
- B-J 每条 Gap 完成"红测 → 改 owner → 转绿 → live 复测"四步走。
- 红测/复测日志共同证明：
  - 客户端断开时 client 端**拿不到**任何 4xx/5xx 错误体（不投影 204/CLIENT_DISCONNECTED），
    服务器立即停请求保持断开；
  - primary 池耗尽后自动切 default pool；
  - upstream_stream_incomplete 进入统一链，第二候选 stream incomplete 可切到第三候选；
  - 未 exhausted 的 provider 4xx 不再早投影；
  - provider-mode 单点 binding 显式豁免，失败直接 5xx；
  - midstream error 进入统一链，已 emit 语义帧时 fail-fast；
  - 仓库 `rg` 扫描 0 命中旧死语义。
- 旧样本在线复测通过：
  - 5555 旧 499 样本不再让 client 端看到 4xx/5xx 错误体；
  - 5520 `1token` 5xx + 其它主 provider 不可用 → 切 default pool 成功；
  - 5520 upstream_stream_incomplete → 切到下一候选。

## 9. 关联文档

- `docs/error-handling-v2.md` §1.0（同步）
- `docs/design/provider-failure-policy-ssot.md` §Rule 1/3/4（同步）
- `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md`（已存 P1-P5 收口）
- `docs/goals/direct-relay-unified-error-chain-audit.md`（已存 §6 D1/D2/D3 决策项已并入本 plan §6）
- `docs/goals/apply-patch-direct-relay-full-audit-plan.md`（独立 audit 范围，不交叉）
- `docs/architecture/function-map.yml` / `verification-map.yml`（2026-06-16 已按本轮 owner /
  verification 栈同步，`verify:function-map-compile-gate` PASS）



## 10. Live Runtime Snapshot（2026-06-15 锁）

- `routecodex --version` = `0.90.3071`、`rcc --version` = `0.90.3071`。
- `127.0.0.1:5555` / `5520` / `10000` 三个端口 `/health` 全部 `status=ok ready=true pipelineReady=true`。
- `pnpm jest tests/server/handlers/handler-utils.client-disconnect.spec.ts --runInBand` PASS（2/2）= **G1 红测已转绿**。

### 10.1 旧样本 live 表现
- 5555 `asxs.crsa.gpt-5.4-mini` HTTP_499 + "client abort request"：live log 中
  `❌ [...] failed: HTTP 499` 仍会出现，但 **client 端零 body**（已通过
  `respondWithPipelineError` 短路 + `terminateClientDisconnectedResponse` 双重确认）。
- 5520 `1token.key1` UPSTREAM_HEADERS_TIMEOUT + `upstream_stream_incomplete`：
  `[provider-switch] ... 1token -> cc.key1` 切候选正常，但 `upstream_stream_incomplete`
  完全 **未**进 `resolveRequestExecutorProviderFailurePlan`（§2.1 样本 C）=
  **G6 红测缺口，Phase D 必须补正**。

### 10.2 已并入审计历程
- 旧 `D1/D2/D3/D4/F8/G8` 编号已在 §3.1 收口；
  `docs/goals/direct-relay-unified-error-chain-audit.md` 与
  `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` 已可标注
  "由本 plan 收口"但不强制删除（保留 audit 历程可追溯）。

### 10.3 红测缺口总览（必须按 Phase 顺序补齐）
- **G1**：已 GREEN（`handler-utils.client-disconnect.spec.ts`）。
- **G3 / G5 / G6 / G7 / G10 / G4**：红测均未在本轮新建，必须在对应 Phase 第一步落地（先红后绿）。
- **G2 / G9**：红测属"契约 / 死代码扫描"，可与对应改一并落地（`rg` 0 命中目标）。

### 10.4 剩余 risk（live 上线前必须明确接受）
1. G6 在 `upstream_stream_incomplete` 未进 error chain 状态下，5520 仍会有
   stream-cut 拖死单 session 的窗口期（G6 红测 / fix 之前不得宣称闭环）。
2. G3 在 host 端 primary_exhausted 触发 default pool 扩池前，`request-executor.ts`
   的阻塞退避仍会 throw `lastError`，对"pool 真耗尽"的 case 会让 client 收到 5xx（G3 fix 前）。
3. G10 拍板的 provider-mode 单点 binding rethrow 与中心原则的偏差 = spec 显式豁免；
   端口 spec / config schema 必须显式登记 `provider-mode single-binding` 字段，
   否则运维无法解释"为什么 provider-mode 端口不切候选"。

### 10.5 Live probe 收尾步骤（重启后）
- `curl -m 5 http://127.0.0.1:5555/health` / `5520` / `10000` 必须 `status=ok ready=true`。
- `tail -n 500 ~/.rcc/logs/server-5555.log | rg -c 'HTTP 499|event:error'` 必须 ≤ 历史窗口基线
  （G6 修复前不可宣称 0）。
- 抓一次旧 499 样本（curl --max-time 1 触发 client abort）→ 服务端日志记 `client_disconnect`
  但 `res.status` 不变 / `res.json` 不调。

**Status: finalized**。本文件 = 审计定稿 + 修复顺序 + 红测缺口 + DoD 一体。
后续 `/goal` 提示词按 `G1 → G3 → G6 → G5 → G7 → G10 → G2 → G4 → G9` 顺序收口。
