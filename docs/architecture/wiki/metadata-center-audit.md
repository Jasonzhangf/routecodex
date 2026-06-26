# Metadata Center Audit

## Purpose

这页不是第二份 SSOT，而是为后续 `MetadataCenter` 设计提供输入表：

1. 当前 request / response 各阶段到底在用哪些 metadata 数据。
2. 这些数据分别属于哪一类语义。
3. 哪些字段已经发生语义混用、重复写入、跨阶段漂移。
4. 后续集中式 metadata center 应该如何按 slot/layer 收口。

Canonical references:

- `docs/architecture/wiki/metadata-boundary-map.md`
- `docs/architecture/function-map.yml` -> `feature_id: hub.metadata_boundary`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `src/server/handlers/handler-utils.ts`
- `src/server/runtime/http-server/executor-metadata.ts`
- `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
- `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`

## Main Finding

当前 metadata 不是“一个中心，多处读取”，而是“多处写入、反复 merge、局部回填”的形态：

1. handler 入口 merge 一次
2. executor attempt / pipeline result merge 一次
3. response conversion / adapterContext 再投影一次
4. servertool / stopless 再从多来源回填一次

因此当前问题不是单点 bug，而是结构性设计问题：

- 值没有唯一真源
- 写入者没有统一 registry
- 覆盖是否合法没有统一 gate
- 字段 provenance 不可追

## Metadata Families

当前主链路里的 metadata，大致可分为 6 个 family。

### 1. Request Truth

这些字段是“当前请求是谁”的事实，后续阶段原则上只能读，不能重定义：

- `requestId`
- `pipelineId`
- `entryEndpoint`
- `sessionId`
- `conversationId`
- `clientRequestId`
- `matchedPort`
- `routingPolicyGroup`

### 2. Continuation Context

这些字段是“如何恢复上一轮/上一条 continuation”的上下文，不等于 request truth：

- `responsesRequestContext`
- `responsesResume`
- `previous_response_id`
- `response_id`
- `tool_outputs`
- `continuationOwner`
- `resumeFrom`
- `chainId`
- `stickyScope`

Clarification:

- `stickyScope` is continuation narrowing metadata, not request truth and not stopless identity;
- `responsesRequestContext.sessionId/conversationId` must stay in this family and must not be promoted into request `sessionId` or stopless state keys.

### 3. Runtime Control

这些字段用于内部控制、servertool、route、stream、followup，不应混入 provider/client payload：

- `routeHint`
- `routeName`
- `routeId`
- `providerProtocol`
- `providerFamily`
- `serverToolFollowup`
- `stopMessageEnabled`
- `routecodexPortStopMessageEnabled`
- `stopMessageClientInjectReady`
- `stopMessageClientInjectReason`
- `stopMessageClientInjectSessionScope`
- `stream`
- `inboundStream`
- `outboundStream`
- `clientAbortSignal`
- `clientConnectionState`

Clarification:

- canonical stopless control is `MetadataCenter.runtime_control.stopless`;
- `stopMessageEnabled` / `stopMessageExcludeDirect` are active runtime-control slots;
- top-level `routecodexPortStopMessageEnabled` and top-level `metadata.stopMessageEnabled` are compatibility projections, not first truth;
- `serverToolLoopState` / `stopMessageState` are still active runtime mirrors used by Rust servertool-core contracts, but they are not canonical `runtime_control` slots.

### 4. Provider / Routing Observation

这些字段描述路由和 provider 结果，属于运行时观测，不应回写 request truth：

- `target`
- `providerKey`
- `assignedModelId`
- `modelId`
- `compatibilityProfile`
- `responseSemantics`
- `finishReason`

### 5. Client Attachment Scope

这些字段和 tmux / daemon / workdir 有关，是 client attach/inject scope，不是 request session：

- `clientDaemonId`
- `sessionDaemonId`
- `sessionClientDaemonId`
- `clientTmuxSessionId`
- `tmuxSessionId`
- `clientTmuxTarget`
- `tmuxTarget`
- `clientWorkdir`
- `workdir`
- `cwd`

### 6. Debug / Snapshot / Replay

这些字段只该服务观测，不该进入 live semantic owner：

- `snapshot`
- `snapshotId`
- `bridgeHistory`
- `debug`-like carrier
- root-level snapshot metadata

## Stage Audit

下表只看 request / response 主链上的阶段，不按文件散列。

| Stage | Current writes | Current reads | Main risk |
| --- | --- | --- | --- |
| `ServerReqInbound01ClientRaw` | `clientRequestId`, request body metadata, request truth seed | client headers / body metadata | 客户端 metadata 与内部 truth 混在同一平面对象 |
| `HubReqInbound02Standardized` | stripped body + pipeline metadata carrier | request body metadata | 入口即做 merge，后续无法区分“客户端给的”还是“系统写的” |
| `HubReqChatProcess03Governed` | request semantics / continuation hints / servertool control | `responsesResume`, tools, continuation-like metadata | 语义层与 metadata carrier 仍有过渡字段重叠 |
| `VrRoute04SelectedTarget` | `routeName`, target selection metadata | route hints / continuation scope | routing observation 可能覆盖 request control slot |
| `HubReqOutbound05ProviderSemantic` | provider semantic envelope | merged request metadata | 仍依赖 merged metadata，缺 typed slot |
| `ProviderReqOutbound06WirePayload` | provider wire payload | provider semantic + runtime control | 边界靠 assert，而不是 center typed read |
| `ProviderRespInbound01Raw` | provider raw metadata / finish reason details | provider response metadata | provider observation 与 response semantic 交错 |
| `HubRespInbound02Parsed` | parsed response semantics | request metadata + provider metadata | request truth / response observation 同袋传递 |
| `HubRespChatProcess03Governed` | servertool followup state, stopless context, tool harvest | adapterContext + pipeline metadata + captured request | stopless / followup 从多来源回填，最容易语义漂移 |
| `HubRespOutbound04ClientSemantic` | client-facing protocol projection | finish reason / response semantics | response projection 仍要避开 internal metadata leak |
| `ServerRespOutbound05ClientFrame` | JSON/SSE frame | projected body + response metadata | client frame 层容易成为最后一道临时补丁层 |

## Current High-Risk Drift Points

### A. Repeated Merge

已确认至少有两次主 merge/projection：

1. `src/server/handlers/handler-utils.ts::buildHandlerPipelineMetadata`
2. `src/server/runtime/http-server/executor/request-executor-attempt-state.ts::finalizeRequestExecutorAttemptMetadata`

已完成的收口：

- `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts` 不再把 `target` / `compatibilityProfile` 写回 flat metadata，改为写入 `MetadataCenter.provider_observation`
- `servertool-adapter-context.ts`、`provider-request-context.ts`、`provider-response-utils.ts` 的 provider model / compatibility 读取已转成 center-backed 读取

结果：

- 写入来源不透明
- later stage 很容易覆盖 earlier truth
- 无法回答“当前值是谁写的”

### B. Multi-source Session Backfill

历史上 `servertool-adapter-context` / `servertool-request-normalizer` 曾会从这些来源找 `sessionId/conversationId`：

- top-level metadata
- nested `metadata`
- nested `__rt`
- `entryOriginRequest`
- `capturedEntryRequest`
- `capturedChatRequest`

这本身就说明 `sessionId` 还没有唯一 owner。

### C. Continuation Context vs Request Truth

当前最危险的混用点：

- `responsesRequestContext.sessionId/conversationId`

它属于 continuation context，不是 request truth。此前已经出现过两种相反 bug：

- 被错升格 -> stopless 误激活
- 没有正确落到 request truth -> stopless 不激活

### D. Client Attachment Scope vs Request Scope

这些字段经常容易被误认为 session truth：

- `tmuxSessionId`
- `clientTmuxSessionId`
- `conversationSessionId`
- `stopMessageClientInjectSessionScope`

实际都不应直接定义 request `sessionId`。

### E. Canonical vs Mirror Drift

当前最容易误判的不是“字段还在不在”，而是“它是不是 canonical truth”：

- `MetadataCenter.runtime_control.stopless`
  - canonical stopless control
- `stopMessageEnabled` / `stopMessageExcludeDirect`
  - active runtime-control fields
- top-level `metadata.stopMessageEnabled` / `routecodexPortStopMessageEnabled`
  - compatibility projections only
- `serverToolLoopState` / `stopMessageState`
  - active runtime mirrors consumed by Rust contracts
  - not `MetadataCenter.runtime_control` canonical slots

因此 closeout 顺序必须是：

1. 先迁 reader/writer owner；
2. 再删 projection / mirror；
3. 不能因为字段仍有 consumer 就把它们误记成 canonical center slot。

## Metadata Center Slot Proposal

后续中心建议至少拆成这 6 个 root family：

```text
MetadataCenter
  request_truth
  continuation_context
  runtime_control
  provider_observation
  client_attachment_scope
  debug_snapshot
```

### Request Truth Slots

- `request_truth.requestId`
- `request_truth.pipelineId`
- `request_truth.entryEndpoint`
- `request_truth.sessionId`
- `request_truth.conversationId`
- `request_truth.clientRequestId`
- `request_truth.portScope`

### Continuation Context Slots

- `continuation_context.responsesRequestContext`
- `continuation_context.responsesResume`
- `continuation_context.previousResponseId`
- `continuation_context.responseId`
- `continuation_context.toolOutputs`
- `continuation_context.owner`
- `continuation_context.resumeFrom`
- `continuation_context.chainId`

### Runtime Control Slots

- `runtime_control.routeHint`
- `runtime_control.routeName`
- `runtime_control.providerProtocol`
- `runtime_control.providerFamily`
- `runtime_control.serverToolFollowup`
- `runtime_control.stopMessage`
- `runtime_control.streamIntent`
- `runtime_control.clientAbort`

### Provider Observation Slots

- `provider_observation.target`
- `provider_observation.providerKey`
- `provider_observation.assignedModelId`
- `provider_observation.compatibilityProfile`
- `provider_observation.responseSemantics`
- `provider_observation.finishReason`

### Client Attachment Slots

- `client_attachment_scope.daemonId`
- `client_attachment_scope.tmuxSessionId`
- `client_attachment_scope.tmuxTarget`
- `client_attachment_scope.workdir`

### Debug Snapshot Slots

- `debug_snapshot.snapshotId`
- `debug_snapshot.bridgeHistory`
- `debug_snapshot.traceMarkers`

## Provenance Requirement

每个 slot 不能只存 value，还要至少存这些元信息：

- `writtenBy.module`
- `writtenBy.symbol`
- `writtenBy.stage`
- `status`
- `writePolicy`
- `version`
- `history[]`

最小结构建议：

```ts
type MetadataSlot<T> = {
  value: T
  family: string
  writtenBy: {
    module: string
    symbol: string
    stage: string
  }
  status: 'active' | 'consumed' | 'finalized' | 'released'
  writePolicy: 'write_once' | 'replaceable' | 'append_only'
  version: number
  history: Array<{
    value: unknown
    module: string
    symbol: string
    stage: string
    at: number
    reason?: string
  }>
}
```

## Migration Priorities

建议不要全仓一起迁，先切最容易持续出事故的 family：

1. `request_truth.sessionId / conversationId`
2. `continuation_context.responsesRequestContext / responsesResume`
3. `runtime_control.serverToolFollowup / stopMessage* / routeHint`
4. `client_attachment_scope.tmux* / workdir`

优先级理由：

- stopless / responses continuation / servertool followup 都卡在这几类
- 这几类目前也最容易相互污染

## Implementation Rules

1. 中心必须是 request-scoped，不是全局 singleton。
2. 后续各层只允许：
   - `center.write(slot, value, provenance)`
   - `center.read(slot)`
   - `center.project(viewName)`
3. 禁止继续传值式 `Record<string, unknown>` merge 当真源。
4. adapterContext 只能是 center projection，不再允许二次回填 session truth。
5. stopless 只允许读 `request_truth.sessionId`，绝不读 continuation context / tmux scope。

## Open Risks

当前这页还是审计输入面，不是完整 closeout 设计真源。仍未完成的部分：

- 尚未把所有 slot 和真实 symbol 做一一绑定
- 尚未把现有 merge/backfill 物理删除
- 尚未完成 live replay 验证
