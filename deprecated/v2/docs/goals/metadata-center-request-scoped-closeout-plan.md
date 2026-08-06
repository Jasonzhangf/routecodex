# Metadata Center Request-Scoped Closeout Plan

## 1. 目标与验收标准

目标：

- 把 RouteCodex 的 metadata 改造收敛为单个 request-scoped `MetadataCenter`，并明确它在 `server -> Hub Pipeline -> provider/runtime -> response closeout` 全链路中的唯一写点、合法改写点、释放点。
- 先完成 contract 真源、function map、mainline source、manifest、verification gate 的统一，再按 gate 收实现。

验收标准：

- 文档真源明确写死：一个 request 只有一个 `MetadataCenter`，不是 session-scoped，也不是按 `sessionId` 复用。
- `request_truth.sessionId/conversationId` 只能在 inbound 一次性写入，后续阶段只读，禁止 continuation/response/tmux/client attachment 回填。
- metadata families 至少覆盖：
  - `request_truth`
  - `continuation_context`
  - `runtime_control`
  - `provider_observation`
  - `response_observation`
  - `closeout_status`
  - `client_attachment_scope`
  - `debug_snapshot`
- 每个 family 有唯一初始写点、合法改写策略、禁止越权改写列表。
- function-map / mainline-call-map / wiki / manifest / verification-map 自洽，并通过对应 gate。

## 2. 范围与边界

In Scope：

- metadata center contract、manifest、wiki、function-map、mainline-call-map、verification-map 对齐
- metadata family 写点/读点/改写点/closeout 规则锁定
- metadata 相关静态 gate 增补与收紧
- 与上述 contract 冲突的旧文档引用、旧 builder 声明、过期测试映射、错误 gate 引用的物理删除

Out of Scope：

- 大规模运行时行为重写
- 为兼容旧路径新增 fallback、双写、silent catch
- 把 session-scoped truth 重新伪装成 request-scoped metadata
- 在 contract 未锁定前散改 handler / SSE / outbound / provider 语义

## 3. 设计原则

- 单 request 一个 center：`MetadataCenter` 是 request-scoped carrier，不是 session key-value store。
- request truth inbound-only：`request_truth` 只能由请求入口写入，后续只读。
- continuation 不得升级成 request truth：`continuation_context` 只服务 continuation owner，不得反向定义 request identity。
- family 隔离：不同 family 不共享平面命名空间，不允许 flat metadata / `__rt` / top-level residue 重新成为真源。
- 同一个 center 贯穿全链路：后续阶段不得新建第二个 center 再 merge 回来。
- closeout 只做 finalized/released：响应出口只写 closeout provenance，不做语义修复。
- contract 先于实现：先锁 owner、write policy、gate，再收运行时代码。

## 4. 技术方案

### 4.1 Contract 真源文件

- [function-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/function-map.yml)
- [verification-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/verification-map.yml)
- [mainline-call-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/mainline-call-map.yml)
- [metadata-center-mainline-source.md](/Users/fanzhang/Documents/github/routecodex/docs/architecture/wiki/metadata-center-mainline-source.md)
- [metadata-center-manifest.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/metadata-center-manifest.yml)
- [metadata.center.mainline.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/manifests/metadata.center.mainline.yml)

### 4.2 Family 与写点规则

`request_truth`

- 初始写点：`ServerReqInbound01ClientRaw -> HubReqInbound02Standardized`
- 写策略：`write_once`
- 合法字段：`requestId/pipelineId/entryEndpoint/sessionId/conversationId/clientRequestId/portScope`
- 禁止来源：`continuation_context`、`runtime_control`、`provider_observation`、`response_observation`、`client_attachment_scope`、`debug_snapshot`

`continuation_context`

- 初始写点：`HubReqChatProcess03Governed`
- 写策略：`replaceable_by_owner_only`
- 合法字段：`responsesRequestContext/responsesResume/previousResponseId/responseId/toolOutputs/continuationOwner/resumeFrom/chainId/stickyScope`
- 禁止行为：把任何 continuation 字段升级成 `request_truth`

`runtime_control`

- 初始写点：`HubReqChatProcess03Governed`，请求路由 owner 可在同 family 内合法改写
- 写策略：`replaceable_by_owner_only`
- 合法字段：`routeHint/routeName/routeId/providerProtocol/retryProviderKey/preselectedRoute/serverToolFollowup/serverToolFollowupSource/streamIntent/clientAbort`
- 当前明确约束：不得复活 flat metadata、`__rt`、SSE/handler/top-level projection 镜像

`provider_observation`

- 初始写点：`VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic`
- 响应侧追加点：`HubRespInbound02Parsed`
- 写策略：`append_only` 或 slot-documented owner replace
- 合法字段：`target/providerKey/assignedModelId/modelId/clientModelId/compatibilityProfile/responseSemantics/finishReason`

`response_observation`

- 初始写点：`HubRespInbound02Parsed`
- 写策略：`append_only`
- 合法字段：`responseId/status/finishReason/protocolKind`

`closeout_status`

- 初始写点：`HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`
- 写策略：`finalize_only`
- 合法字段：`finalized/released/releasedAt/releaseReason/releasedByStage`
- 禁止行为：closeout 阶段修 request truth、补 continuation、补 stopless/servertool 语义

`client_attachment_scope`

- 初始写点：client attachment owner
- 写策略：独立 family，不得写回 request truth
- 合法字段：`daemonId/tmuxSessionId/tmuxTarget/workdir`

`debug_snapshot`

- 初始写点：observability-only owners
- 写策略：`append_only`
- 约束：只用于 replay/debug，不得参与 live runtime 决策

### 4.3 代码与 gate 需要对齐的文件

- [metadata-center-types.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/metadata-center/metadata-center-types.ts)
- [metadata-center.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/metadata-center/metadata-center.ts)
- [verify-architecture-metadata-center-manifest-code-sync.mjs](/Users/fanzhang/Documents/github/routecodex/scripts/architecture/verify-architecture-metadata-center-manifest-code-sync.mjs)
- `scripts/architecture/verify-architecture-metadata-center-write-boundaries.mjs`（新增）
- [package.json](/Users/fanzhang/Documents/github/routecodex/package.json)

### 4.4 Gate 目标

必须锁住：

- 单 request 只有一个 bound `MetadataCenter`
- `request_truth` 只允许 inbound 写入
- continuation/tmux/client attachment/response/closeout 不得回填 request truth
- 不允许第二个 center merge
- 不允许 flat metadata、`__rt`、top-level control residue 重新成为真源
- 不允许 SSE/handler/outbound 越权写 metadata family

## 5. 风险与规避

风险 1：文档先收紧，但代码/类型/gate 未同步，仓库短时不一致。

- 规避：同一变更集内同步修改 manifest、types、gate 脚本和 npm script。

风险 2：旧测试/旧 gate 仍要求 continuation 回填 `request_truth.sessionId/conversationId`。

- 规避：按新 contract 修测试映射与说明；不能为了过旧测恢复错误语义。

风险 3：实现阶段继续 materialize flat metadata residue，导致 center 变成旁路装饰品。

- 规避：先加 write-boundary gate，再做运行时收口。

风险 4：把 session-scoped state 误当成 request-scoped metadata center 实例。

- 规避：所有文档、manifest、gate 明确写死 “request-scoped center, sessionId is field not key”。

## 6. 测试计划

架构/契约 gate：

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-metadata-center-manifest-code-sync`
- `npm run verify:architecture-metadata-center-write-boundaries`

必要的 build/type 验证：

- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

如果同步调整测试映射：

- 证明修正的是过期路径或错误 owner 声明，不是删除门禁

## 7. 实施步骤

1. 对齐 contract 文档
2. 完成 metadata manifest 与 types/code 同步
3. 更新 manifest-code-sync gate，使其接受新 family 和 `finalize_only`
4. 新增 metadata write-boundary gate
5. 在 `package.json` 挂载新 gate，并纳入合适验证面
6. 跑 architecture / manifest / type gate
7. gate 全绿后，再推进运行时 owner 收口与旧 residue 删除

## 8. 完成定义（DoD）

- 文档真源、manifest、mainline、function-map、verification-map 全部收敛到同一 metadata contract
- 新旧 family 集合、write policy 集合、stage owner 集合一致
- metadata write-boundary gate 已落地并通过
- 过期引用、重复 owner、错误 builder/test/gate 声明已物理删除或修正
- 下一阶段可以直接按 gate 推运行时收口，不再争论 metadata 边界
