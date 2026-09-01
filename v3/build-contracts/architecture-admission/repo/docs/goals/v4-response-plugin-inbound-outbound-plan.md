# V4 Response Inbound/Outbound Plugin Implementation Plan

## 目标与验收标准

将 V4 响应链的 ingress/egress 插件从 keyless mock/validator 补齐为可编译、可执行、可验证的标准插件实现：

```text
V4ProviderSseIn01FrameBoundary
  -> V4HubRespInbound02Parsed
  -> V4HubRespOutbound04ClientSemantic
  -> V4ServerSseOut05FrameBoundary
  -> V4ServerRespOutbound06ClientFrame
```

本 worker 只负责：

- `protocol_decode`：provider raw/JSON semantic 到 `v4.response.normal_payload`；
- `client_semantic_projection`：governed response 到客户端语义；
- `frame_build`：客户端语义到客户端 frame；
- 对上述插件的 descriptor、catalog、typed handle、plan、L2/负向测试。

完成标准：

- 插件均绑定准确 `node_id`、`role_id`、`position` 和允许 operator kind；
- 只做相邻响应节点转换；
- control/error/debug/snapshot/metadata 不进入 response/client payload；
- provider SSE 与 client SSE 只由两端 frame boundary 处理；
- malformed input、非 object payload、控制面泄漏、未声明资源写入均 fail-fast；
- 不实现、不修改 RespChatProcess 的治理、tool harvest、continuation save/release。

## 范围与边界

### In scope

- `v4/crates/routecodex-v4-standard-plugins/` 中 response inbound/outbound 插件实现；
- 为避免两个 worker 争用同一注册表文件，新增的插件描述符、执行函数和 handle 映射放入本 worker 独占的模块文件；
- 仅在必要时对标准库注册入口做最小接线；
- 对应 V4 contracts、插件 catalog/plan 测试和架构 gate 的最小同步；
- 只使用已存在的 V4 contract、resource registry、NodeContainer/ExecCtx API。

### Out of scope

- `V4HubRespChatProcess03Governed` 内部治理；
- `response_governance`、`tool_harvest`、`continuation_commit`、`continuation_release`；
- Responses continuation scope/owner 判定；
- provider 特例、请求链、router、error chain；
- 真实运行时 kernel 重写或第二 dispatch path；
- fallback、silent strip、payload cleanup、控制面 payload 混入。

## 设计原则

1. 唯一 owner：插件行为归 `routecodex-v4-standard-plugins`；编排仍归 V4 runtime/kernel。
2. 物理隔离：正常响应数据使用 data resource；错误、控制、诊断只使用 typed side-channel。
3. 相邻转换：只允许 `provider_raw -> parsed_response`、`governed/client_semantic -> client_frame` 的登记边。
4. 显式错误：解析、类型、资源、selector、plan、contract 失败直接进入 typed error，禁止 fallback。
5. 语义等价：不得裁剪真实 response payload，不得把内部字段静默删除后当作修复。

## 技术方案与文件清单

先读取并核实：

- `v4/contracts/node-graph.contract.json`
- `v4/contracts/skeleton-plan.contract.json`
- `v4/contracts/node-plugin.contract.json`
- `v4/contracts/pipeline-abstraction.contract.json`
- `v4/docs/architecture/v4-standard-plugin-library.md`
- `v4/docs/architecture/v4-standard-nodes-and-node-graph.md`
- `v4/docs/architecture/v4-resource-operation-map.yml`
- `v4/docs/architecture/v4-responses-direct-compatibility-slice.yml`

实现目标文件：

- `v4/crates/routecodex-v4-standard-plugins/src/response_inbound.rs`：protocol decode descriptor/handle；
- `v4/crates/routecodex-v4-standard-plugins/src/response_outbound.rs`：client projection/frame build descriptor/handle；
- `v4/crates/routecodex-v4-standard-plugins/src/lib.rs`：只做模块声明、插件集合和 typed handle 的最小注册接线；
- `v4/crates/routecodex-v4-standard-plugins/tests/`：正向、反向、资源隔离和 plan/catalog 测试。

若当前 API 无法表达该插件而必须改共享 crate，先记录阻塞及调用边，修改范围限于对应 contract/plan/bridge owner；不得在本 worker 内补 runtime 旁路。

## 风险与规避

- 注册表与 Worker B 可能同时需要 `lib.rs`：优先使用模块级 descriptors/handles，root 只做一次最小接线；若无法避免冲突，写 handoff，不覆盖另一 worker 改动。
- 当前标准库是 M5 keyless 基线：不得伪称已完成真实 provider/client 迁移；实现应明确是 V4 插件执行合同和语义测试，不替代生产 runtime。
- `client_semantic_projection` 不得承担 continuation 或 provider-specific response repair。
- `frame_build` 不得把 SSE transport 逻辑移入 Hub response semantic 节点。

## 测试计划

### 单元

- 合法 provider raw/JSON object 能生成 parsed response；
- 合法 client semantic 能生成 client frame；
- 非 object、非法 shape、缺少必要 typed data 显式失败；
- 所有 descriptor 的 selector/resource/effect/phase/order/hash 合法。

### 负向

- 未声明 data/control resource 读写失败；
- control/error/debug/snapshot 字段写入 response/client payload 失败；
- 非相邻节点 selector、错误 role/position、未知 plugin kind 被拒绝；
- malformed response 不得 fallback 成成功 response；
- plugin failure 必须进入 typed error intake。

### 集成

- catalog registration、authoring、plan compilation、typed handle execution；
- response chain 相邻边和 single terminal gate；
- 与 Worker B 的插件 ID/文件边界无冲突。

## 实施步骤

1. 刷新 `.agent-collab` runs/claims/handoff/merge-queue/KILL_SWITCH 视图。
2. 申请 `feature_id:v4.response_plugin_inbound_outbound` claim，建立独立 clean worktree。
3. 固化最小 failing test，确认当前缺口为红。
4. 实现 inbound/outbound 模块和最小注册接线。
5. 跑定向 unit/L2/architecture gates，写 `evidence.jsonl`。
6. 做模块边界自检，生成 handoff/merge-queue；未通过不得交付。

## 完成定义

代码、测试、descriptor/catalog/plan 接线和证据均在本 worker scope 内完成；无未声明 fallback、旁路、payload 控制语义或与 Worker B 的文件/claim 冲突；handoff 明确列出未覆盖的 RespChatProcess 能力。
