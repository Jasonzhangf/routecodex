# Servertool Followup Origin Reentry Contract

## 索引概要
- L1-L10 `objective`：唯一目标与非目标。
- L12-L32 `contract`：servertool 职责与正常 req/resp 链路。
- L34-L58 `stage-topology`：阶段命名和相邻转换。
- L60-L78 `forbidden`：禁止路径。
- L80-L100 `verification`：红测与验收。

## 目标 / 非目标
- 目标：servertool followup 只能 clone entry-origin request（入口协议原始请求语义），再应用 followup delta，并重新进入完整 Hub Pipeline。
- 目标：servertool 只代客户端执行本地工具或发起 followup；不拥有专用响应协议、不投影客户端 shape、不修补 provider shape。
- 目标：followup 请求与正常请求同构，保留入口协议工具列表、模型参数、entry endpoint 与协议语义；metadata 仍走 side-channel。
- 非目标：不改变 provider transport 协议。
- 非目标：不引入 fallback、双路径、灰度 flag、旧路径长期共存。
- 非目标：不改变 servertool handler 的业务语义。

## 唯一契约
1. servertool 是 `HubRespChatProcess03Governed` 内部的响应治理动作。
2. servertool 的唯一职责是绕过客户端执行本地工具工作，代客户端完成“本应由客户端执行”的步骤。
3. followup 请求必须基于 entry-origin request clone 加 delta，并从正常请求入口复入；`/v1/responses` 保持 `input`，`/v1/chat/completions` 保持 `messages`：
   `HubReqInbound02Standardized -> HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> provider runtime`。
4. followup 响应必须走正常响应链；`RespInbound` 是模型/provider 端进入 Hub，`RespOutbound` 是 Hub 出到客户端入口协议：
   `ProviderRespInbound01Raw -> HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`。
5. 如果 servertool 执行后返回的是 `HubRespChatProcess03Governed` payload，只能通过相邻 builder `buildHubRespOutbound04FromHubRespChatProcess03` 进入 `HubRespOutbound04ClientSemantic`。
6. `/v1/responses` 的最终客户端 payload 必须由 normal `HubRespOutbound04ClientSemantic` 投影为 Responses shape，顶层 `object` 必须是 `response`。
7. `/v1/chat/completions` 的最终客户端 payload 必须由 normal `HubRespOutbound04ClientSemantic` 投影为 Chat Completion shape，顶层 `object` 必须是 `chat.completion` 或兼容 chat completion；不能把 Responses payload 直接写给 Chat 客户端。
8. metadata、runtime carrier、snapshot carrier 只能作为 side-channel，不得进入 provider body 或 client body。

## 阶段拓扑

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
      -> ServertoolResp03RuntimeAction
      -> ServertoolReq04FollowupBuilt
      -> normal request reentry
      -> ProviderRespInbound01Raw
      -> HubRespInbound02Parsed
      -> HubRespChatProcess03Governed
      -> ServertoolResp03FollowupResult
  -> buildHubRespOutbound04FromHubRespChatProcess03
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
```

节点职责：
- `ServertoolResp03RuntimeAction`：Rust chat-process 根据 governed response 产出 runtime action；TS 只能执行 IO/reenter。
- `ServertoolReq04FollowupBuilt`：clone entry-origin request 并只应用 followup delta；禁止从当前污染 payload 猜测补偿。
- `ServertoolResp03FollowupResult`：followup 返回的 governed response，是后续 resp outbound 的唯一真相。
- `buildHubRespOutbound04FromHubRespChatProcess03`：唯一允许的 `03 -> 04` 相邻转换；不是 servertool 专用响应出口。

## 禁止路径
1. 禁止 servertool 专用 response projection。
2. 禁止手写 Responses wrapper 修复 `object=response`。
3. 禁止用 provider raw / client outbound / SSE frame 判定 stopless 或工具语义。
4. 禁止用 `rawBody`、当前污染 payload、pre-followup payload 重建 followup。
5. 禁止清洗工具列表、重写历史、多轮合并历史来“修复” followup；缺字段必须回到 origin 捕获修复。
6. 禁止同一 `followupRequestId` provider 重试；错误必须显式暴露。
7. 禁止 fallback 到旧 payload-injection、message-trimmer、generic followup builder。

## 红测 / 验收
1. `/v1/responses` followup 触发后，最终 client payload 顶层必须是 `object=response`。
2. Chat Completions followup 触发后，最终 client payload 不得出现 Responses 顶层 shape。
3. `HubRespChatProcess03Governed` 不能直接写 client frame，必须经 `HubRespOutbound04ClientSemantic`。
4. `servertoolRuntimeAction.payload` 缺失必须 fail-fast，禁止回退到 client payload。
5. followup body 必须保留 entry-origin request tools 与参数，不允许清洗工具列表或从 raw/context backfill。
6. client response body 不得泄露 `metadata`、`__rt`、snapshot/debug carrier。
7. stopless 红测必须断最终 `reenterPipeline.body` 与最终 client shape，不只断 `executed=true`。

## 代码真源
- Response conversion shell：`sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- Servertool engine：`sharedmodule/llmswitch-core/src/servertool/engine.ts`
- StopMessage handler：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- Rust response governance：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/`
