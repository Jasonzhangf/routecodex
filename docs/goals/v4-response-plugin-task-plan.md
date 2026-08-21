# V4 响应链插件任务计划

## 目标

完成 V4 响应链全部大节点插件，并按 Cordis 架构拆成小插件。响应链目标形态：

```text
V4ProviderSseIn01FrameBoundary
  -> V4HubRespInbound02Parsed
  -> V4HubRespChatProcess03Governed
  -> V4HubRespOutbound04ClientSemantic
  -> V4ServerSseOut05FrameBoundary
  -> V4ServerRespOutbound06ClientFrame
```

响应侧控制语义：continuation save 只在 RespChatProcess，restore 只在下一轮 ReqChatProcess；中间不可变区只能传输/投影/校验，禁止 handler/SSE/outbound 补偿。

## 当前真源与缺口

- 响应数据面 worktree（response inbound/outbound）与 continuation 控制面 worktree 已在组合 worktree `playground/v4-response-chain-plugins-combined-integration-20260819T050500Z-Macstudio-15000-v4respintegration` 合并验证，25 个 standard plugin descriptors，source gate 全绿。
- 响应 ChatProcess worktree已实现 response governance、tool harvest、continuation commit，并有独立 evidence。
- 这些 worktree 都尚未 commit/merge 到 main，也未做全局 install/restart/live replay/DSH review。
- 当前真实响应路径是否真正经过 SkeletonRuntime 插件链需要以合并后的 source 为准；目标是让真实 JSON/SSE 响应经过插件链，而不是把 provider 流直接透传。

## 任务列表

### M1：合并响应链 source worktree

1. 从当前 main HEAD 建立 clean worktree。
2. 合并组合 worktree（response inbound/outbound + continuation control）与响应 ChatProcess worktree。
3. 合并冲突按已有 handoff 结论处理：Worker A/B 描述符都保留，node permission 以 data-plane owner 为准，descriptor 数量从源码派生。
4. 合并后跑 `cargo test -p routecodex-v4-standard-plugins --locked`、`cargo test -p routecodex-v4-cordis-bridge --locked`、`node scripts/verify.mjs`、`node scripts/verify-red.mjs`。

### M2：Node 01/02：Provider SSE In + Response Inbound

1. `V4ProviderSseIn01FrameBoundary`：只做 provider SSE frame -> JSON；不做语义决策。
2. `V4HubRespInbound02Parsed`：provider raw -> normal response payload；malformed provider response fail-fast。
3. 小插件拆分：frame parse、JSON parse、protocol decode、semantic normalize；每个插件只做相邻转换。

### M3：Node 03：Response ChatProcess

1. `V4HubRespChatProcess03Governed`：响应侧工具治理、tool harvest、continuation save 唯一入口。
2. 拆小插件：response governance、tool harvest、continuation commit、stopless/servertool 投影（若 V3 基线要求）。
3. 禁止在 resp_outbound、SSE、handler、server adapter 做 continuation 保存或恢复。

### M4：Node 04-06：Client Semantic / SSE Out / Client Frame

1. `V4HubRespOutbound04ClientSemantic`：normal response -> client semantic；不保存 continuation、不修 provider 特例。
2. `V4ServerSseOut05FrameBoundary`：client semantic -> SSE frame boundary；不做 required_action/tool_call 语义判断。
3. `V4ServerRespOutbound06ClientFrame`：最终 client frame projection，单一 success terminal。

### M5：Continuation 控制面

1. continuation facts 只走 `v4.control.metadata_center` -> `v4.scope.session` typed bridge -> `ScopeRegistry`。
2. 保存位置固定 RespChatProcess；恢复位置固定下一轮 ReqChatProcess；不可变区禁止 payload 重建。
3. Direct/Relay continuation owner 隔离：Direct 只续 Direct，Relay 只续 Relay；entry protocol + owner + session/conversation 三键校验。
4. 正反测试：正常保存/恢复通过；跨 owner、跨入口、不可变区修改、payload 携带 control state 全部 fail-fast。

### M6：真实 Response 接线

1. SkeletonRuntime 执行响应插件链；真实 provider Responses JSON/SSE 响应经 Node 01-06 返回客户端。
2. Direct 与 Relay 响应路径都有：Direct 保持 Responses 同协议；Relay 从目标 provider 原始响应归一化后投影到客户端入口协议。
3. 禁止 provider SSE 到 client SSE 的直接 pipe-through shortcut。
4. 错误统一进入 Error01-06；SSE 已提交后发生错误必须显式 `event:error`，禁止 silent EOF。
5. client disconnect 是 transport 语义，不投影成 provider error。

### M7：Maps / Gates / Live

1. 同步 resource/function/mainline/verification maps、node-graph、standard-plugin gate。
2. 跑 `verify:ci`、isolation、red suites；source gate 绿后再做全局安装、V4 restart、真实 live replay。
3. 用真实 provider 样本复测 JSON/SSE/continuation/error；V3 同入口样本作为行为基线。
4. DSH review（opencode-go/deepseek-v4-flash）语义 PASS。

## 验证矩阵

| 类别 | 最小验证 |
|---|---|
| 插件层 | standard-plugins L2、response inbound/outbound、continuation control、response chat-process tests |
| Runtime | `cargo test -p routecodex-v4-runtime --test l2_runtime --locked` |
| Cordis | `cargo test -p routecodex-v4-cordis-bridge --locked`；NodeContainer 黑盒 |
| 架构 | verify-v4-standard-plugins、node-graph、plane isolation、capability isolation、relay continuation、responses direct compat |
| Live | 真实 Responses JSON/SSE、continuation、错误响应；Direct/Relay 各一条；V3 baseline 对照 |
| Review | DSH review（opencode-go/deepseek-v4-flash）语义 PASS |

## 完成定义（DoD）

- 响应链 Node 01-06 插件全部存在、小插件可插拔、Direct/Relay 都有真实路径。
- continuation save/restore 只发生在 RespChatProcess/ReqChatProcess；不可变区无语义修改。
- 无 provider SSE pipe-through、无 silent EOF、无 fallback、无控制面入 payload。
- map/gate/CI 同步；DSH 无 P0/P1。
