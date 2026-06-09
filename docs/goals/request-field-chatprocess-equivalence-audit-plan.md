# Request Field ChatProcess Equivalence Audit Plan

## 1. 目标与验收标准

目标：审计并重构请求字段处理链路，确保普通请求与 servertool followup 请求完全同链路：所有客户端请求字段只能从 `ReqInbound` 进入，等价转换为 `ReqChatProcess` 标准语义，再由 `ReqOutbound` 等价投影到目标 provider 协议。禁止从 raw request、context snapshot、metadata、responsesContext、toolsRaw/clientToolsRaw 反向回填 provider payload 字段。

验收标准：
- 普通请求与 followup 请求在字段转换上没有专用旁路；followup 只代客户端发起等价请求，不拥有字段补偿路径。
- provider outbound payload 只来自 chat process 标准语义产物；不得从 `__raw_request_body`、`rawBody`、`requestMetadata`、`contextSnapshot`、`responsesContext`、`metadata` 恢复 `tools/input/messages/tool_choice/model/reasoning` 等请求字段。
- 所有工具字段在唯一工具治理点完成语义转换；Codex `type: "namespace"` 聚合工具不得原样进入 provider wire body。
- 若发现 TS 中仍承担请求语义转换、工具治理、followup delta 构造职责，必须列入 Rust 下沉或物理删除计划；不在 TS 路径继续补丁。
- 红测覆盖 raw/context/metadata 回填请求字段失败场景，确保未来复发必红。

## 2. 范围与边界

### In Scope

- 请求链：`ReqInbound -> ReqChatProcess -> ReqOutbound -> ProviderReqOutbound`。
- 普通 `/v1/responses`、`/v1/chat/completions` 与 servertool followup 请求字段一致性。
- 工具字段：`tools`、`tool_choice`、`parallel_tool_calls`、tool call/result history。
- 内容字段：`input`、`messages`、`instructions`、system/developer/user/assistant/tool 消息。
- 参数字段：`model`、`reasoning`、`max_tokens`、`max_output_tokens`、`temperature`、`top_p`、`response_format`、`include`、`store`、`truncation`、`service_tier`、`stream`。
- continuation 字段：`previous_response_id`、conversation/session continuation materialization。
- side-channel：`metadata`、`__rt`、`requestMetadata`、`contextSnapshot`、`responsesContext`、snapshot/debug carrier。

### Out of Scope

- provider runtime 内部协议细节本身，除非它从 raw/context/metadata 补请求字段。
- 响应投影中为了客户端还原工具名/参数而读取 `toolsRaw/clientToolsRaw` 的只读用途；该用途必须明确标注为 response-only，不能进入 request outbound。
- direct/provider-direct passthrough 的协议直通行为；direct 不走 Hub response process，也不激活 stopless/servertool。

## 3. 设计原则

1. **Chat Process 唯一语义真源**：请求字段必须在 `ReqChatProcess` 完成等价语义治理；outbound 只做协议投影。
2. **禁止 raw/context 回填**：`rawBody`、`__raw_request_body`、snapshot、context、metadata 只能观测/审计，不能作为 live request 字段来源。
3. **followup 与普通请求同链路**：servertool 只代客户端执行本地工具；followup 请求必须从正确入口重新进入 Hub Pipeline，不允许专用字段补偿 DSL。
4. **TS 语义路径下沉 Rust**：发现 TS 承担请求语义转换时，不继续补 TS；列入 Rust owning builder/parser 迁移。
5. **物理删除错误实现**：确认错误的回填路径必须删除，不保留闲置代码或“以防万一”分支。
6. **红测锁边界**：每个已删错误路径都必须有红测，覆盖普通请求与 followup 两类入口。

## 4. 当前已收敛问题

### 4.1 线上样本根因

样本：`openai-responses-mimo.key2-mimo-v2.5-20260604T172524309-256981-624_stop_followup/provider-request.json`。

证据：
- `body.tools[11].type = "namespace"`，provider wire body 真实携带 Codex namespace 聚合工具。
- `meta.requestMetadata.__raw_request_body.tools[11..13]` 来自原始客户端 tools。
- `contextSnapshot.toolsRaw` / `responsesContext.toolsRaw` 保存并传播 raw tools。
- MiniMax 报错：`invalid tool type: namespace (2013)`。

结论：这是 raw/context tools 被回填到 provider payload 的架构错误，不是单个 provider 过滤问题。

### 4.2 已发现违规路径

#### A. TS followup root tools 恢复

文件：`src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`

问题：
- `restoreFollowupRootToolsIfNeeded(...)` 从 `requestSemantics.tools.clientToolsRaw`、`baselineTools`、`canonicalTools` 等恢复/合并 `body.tools`。
- 这绕过 `ReqChatProcess`，把 raw/semantics 里的旧 tools 直接塞回请求字段。

处理方向：
- 删除该恢复函数及相关 helper。
- followup body 只能携带当前等价客户端输入；工具由同一 Hub 请求链标准化后进入 outbound。

#### B. Rust responses conversation tools 持久化/恢复

文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

问题：
- `prepare_responses_conversation_entry(...)` 从 `context.toolsRaw` 或 `payload.tools` 保存 `tools` 到 entry/basePayload。
- `resume_responses_conversation_payload(...)`、`restore_responses_continuation_payload(...)`、`materialize_responses_continuation_payload(...)` 从 entry 恢复 `tools` 到 provider payload。

处理方向：
- 删除 entry/basePayload 中的 request `tools` 持久化与恢复。
- continuation 只恢复 conversation input/history 语义；工具由当前请求链重新治理。

#### C. TS stop-message loop seed tools 回填

文件：`sharedmodule/llmswitch-core/src/servertool/stop-message-loop-payload-block.ts`

问题：
- `buildStopMessageLoopPayload(...)` 从 captured seed 回填 `payload.tools`。
- captured seed 本质来自历史请求，不应作为 live provider request 字段来源。

处理方向：
- 删除 seed tools 回填。
- stopless followup 只注入等价用户/系统提示；工具字段由同一请求链治理。

#### D. Rust servertool followup delta DSL

文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs`

问题：
- `apply_followup_delta_plan(...)` 独立拼 `messages`、`model`、`tools`、`parameters`。
- ops 包含 `preserve_tools`、`ensure_standard_tools`、`replace_tools`、`force_tool_choice` 等专用字段操作。
- 这构成 followup 专用请求重建 DSL，与普通请求字段转换路径不一致。

处理方向：
- 审计是否可完全废弃该 DSL，改为构造“等价客户端输入”后重新进 `ReqInbound`。
- 若仍需 delta，必须改为 Rust `ReqChatProcess` 内部语义操作，不直接构造 provider request 字段。

#### E. TS legacy Responses bridge

文件：
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts`

问题：
- 仍使用 `responsesContext`、`toolsRaw`、`restoredTools`、`buildResponsesPayloadFromChat(...)` 等旧上下文机制。
- 部分用途属于响应投影还原，部分可能参与请求/响应桥接重建，边界不清。

2026-06-09 closeout:
- V2 conversion pipeline codecs have been physically deleted: `sharedmodule/llmswitch-core/src/conversion/pipeline/**` and matching dist outputs are not valid migration targets anymore.
- Deleted files such as `responses-openai-pipeline.ts`, `anthropic-openai-pipeline.ts`, `openai-openai-pipeline.ts`, and `openai-chat-helpers.ts` are forbidden duplicate request-semantics entrances; do not restore them as compatibility shims.
- The remaining active audit scope is the live Responses bridge files above plus Rust/HTTP owners listed later in this plan.

处理方向：
- 标注 `toolsRaw/clientToolsRaw` 仅允许 response projection read-only 使用。
- 请求语义转换和 Responses payload build 下沉 Rust owning builder。
- 删除 TS bridge 中会生成 live request payload 的旧路径。

#### F. DeepSeek compat raw tools restore

文件：`sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-request.ts`

问题：
- 明确从 `__hub_capture.context.toolsRaw` restore `payload.tools`。
- 这是典型 raw/context 回填 provider request 字段。

处理方向：
- 删除该 TS restore 行为。
- DeepSeek outbound 工具投影必须从 `ReqChatProcess` 标准语义进入 provider profile/Rust compat。

#### G. standardized_request raw payload 保留

文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`

问题待判定：
- `semantics.tools.clientToolsRaw` 保存 raw tools。
- `standardized_request.tools` / `raw_payload.tools` 仍携带 raw tools。

处理方向：
- 区分合法用途：ReqChatProcess 工具治理输入 vs 请求出站回填来源。
- 若 `clientToolsRaw` 仅用于 response projection 名称/参数还原，需改名/隔离到 response-only side-channel carrier。
- provider outbound 不得直接消费该字段。

## 5. 字段映射审计矩阵

| 字段族 | 正确路径 | 已发现风险 | 处理方向 |
|---|---|---|---|
| `tools` | raw tools -> ReqChatProcess 工具治理 -> provider function/native tool projection | raw/context tools 被 followup/conversation/compat 回填 | 删除回填；Rust owning tool mapper |
| `tool_choice` | inbound capture -> chatprocess policy -> outbound protocol projection | `servertool_followup_delta` 可 `force_tool_choice` | followup 不直接改字段；并入 chatprocess policy |
| `parallel_tool_calls` | inbound参数 -> chatprocess工具策略 -> outbound | followup 参数复制可能跳过治理 | 参数治理统一进 Rust |
| `input/messages` | inbound协议解析 -> chatprocess canonical conversation -> outbound协议编码 | followup delta DSL 直接拼 messages | followup 改为等价客户端输入，不拼 provider messages |
| `instructions/system/developer` | inbound角色语义 -> canonical messages/system semantics -> outbound | legacy bridge/seed 可能拼接 | 统一 canonical role semantics |
| `model` | routing/provider target + request semantics -> outbound model projection | followup delta resolve model 有专用优先级 | 移入 routing/outbound model resolver |
| `reasoning`/`thinking` | inbound reasoning semantics -> chatprocess reasoning block -> outbound provider-specific encoding | TS/provider profile 读取 metadata reasoning | 下沉 Rust；metadata 只 side-channel control |
| `max_tokens/max_output_tokens` | inbound参数标准化 -> outbound按协议命名 | followup delta 参数复制 | Rust parameter mapper |
| `temperature/top_p/response_format/include/store/truncation/service_tier` | inbound参数标准化 -> outbound投影 | 多处分散 copy | Rust parameter mapper |
| `previous_response_id`/continuation | inbound continuation semantics -> chatprocess context -> outbound continuation encoding | conversation restore 从 entry 补字段 | 只保留 continuation semantics，不补 raw fields |
| `metadata/__rt/requestMetadata/contextSnapshot/responsesContext` | Meta* side-channel only | 被用于 request payload restore | 运行时红测禁止进入 provider/client normal payload |

## 6. 技术方案

### 6.1 审计阶段

1. 为请求字段建立 owning builder 清单：
   - `HubReqInbound02Standardized`
   - `HubReqChatProcess03Governed`
   - `HubReqOutbound05ProviderSemantic`
   - `ProviderReqOutbound06WirePayload`
2. 枚举所有字段从 raw/context/metadata 进入 provider payload 的路径。
3. 将每条路径标为：
   - 合法：当前请求字段进入 ReqInbound 后由 chatprocess 消费。
   - 合法但需隔离：response-only projection context。
   - 非法：raw/context/metadata/followup DSL 回填 live request 字段。
4. 对非法路径提出删除或 Rust 下沉方案。

### 6.2 重构阶段

1. 删除 TS followup root tools restore。
2. 删除 conversation entry tools 持久化/恢复。
3. 删除 stop-message seed tools 回填。
4. 审计并收敛 `servertool_followup_delta`：
   - 优先删除工具/参数字段级 ops。
   - 保留的能力必须表达为 chatprocess semantic op，不直接构造 provider request。
5. 删除 DeepSeek TS compat 从 `__hub_capture.context.toolsRaw` 恢复 tools。
6. 将 Responses bridge 中仍参与 live request/response payload build 的语义逻辑迁入 Rust。
7. 增加 provider wire guard：`ProviderReqOutbound06WirePayload` fail-fast 禁止 `type:"namespace"`、内部 metadata、raw snapshot carrier。

### 6.3 红测阶段

必须新增/更新红测：
- Followup 中 `requestSemantics.tools.clientToolsRaw` 含 namespace，最终 nested request/provider wire 不得包含该 namespace。
- Conversation restore entry 含 `tools`，恢复 payload 不得出现 entry tools。
- stop-message loop captured seed 含 tools，loop payload 不得出现 seed tools。
- DeepSeek compat `__hub_capture.context.toolsRaw` 含 tools，不得 restore 到 provider payload。
- Provider outbound wire 中出现 `type:"namespace"` 必须 fail-fast。
- 普通请求与 followup 输入相同字段时，经过 ReqChatProcess 后 outbound 等价。

## 7. 风险与规避

- 风险：删除 tools 回填后，某些 followup 失去工具列表。
  - 规避：工具列表必须由当前请求通过标准 ReqInbound/ReqChatProcess 重新治理；若缺失，说明 followup 构造入口不完整，应修 followup origin snapshot/entry，而不是补 payload。
- 风险：response projection 仍需要 `toolsRaw` 还原客户端工具名。
  - 规避：保留 response-only side-channel，但类型命名和红测必须禁止进入 request outbound。
- 风险：TS legacy bridge 与 Rust pipeline 双路径并存。
  - 规避：发现 TS 语义路径后只列 Rust 下沉/删除，不继续在 TS 修语义。
- 风险：历史缓存命中率受影响。
  - 规避：只改最新一轮 live request 构造与 side-channel 边界，不重写历史消息内容；conversation entry 迁移只停止错误字段恢复。

## 8. 测试计划

- Rust 单元测试：router-hotpath-napi request/followup/conversation/outbound wire guard。
- TS 单元测试：servertool followup dispatch 不恢复 raw tools；stop-message loop payload 不含 seed tools。
- 红测：raw/context/metadata request field backfill 必红。
- 集成测试：普通 request 与 followup request 字段等价路径。
- 构建：`npm run build:min`。
- 部署验证：全局安装、重启 5555、健康检查、live sample provider-request 不含 `type:"namespace"`。

## 9. 实施步骤

1. 完成请求字段矩阵审计并提交审计报告。
2. 添加红测锁定当前已知非法回填路径。
3. 删除 TS followup/root tools/seed tools/DeepSeek compat raw restore。
4. 清理 Rust conversation tools 持久化/恢复。
5. 收敛或删除 `servertool_followup_delta` 字段级 DSL。
6. 将仍承担 live request 语义的 TS bridge 下沉 Rust。
7. 增加 ProviderReqOutbound wire guard。
8. 跑 targeted Rust/TS 测试。
9. build、全局安装、重启、live 验证。
10. 更新 docs/skills/MEMORY，提交。

## 10. 完成定义

- 审计报告列出所有已知 raw/context/metadata 请求字段回填路径。
- 所有非法路径有删除/下沉计划与对应红测。
- 普通请求与 followup 请求字段转换路径一致。
- provider wire payload 不再可能出现 Codex namespace 聚合工具或内部 carrier。
- TS 不再拥有请求语义转换/补偿职责；仅保留薄壳调用 Rust 或 response-only projection glue。

## 11. 追加审计：Provider Runtime / Direct / SDK 层请求字段风险

### 11.1 Direct passthrough rawBody 使用

文件：`src/server/runtime/http-server/direct-passthrough-payload.ts`

现状：
- `resolveRawPayloadForDirect(...)` 在 direct passthrough 中优先读取 `metadata.__raw_request_body`，并作为 provider body 发送。
- 仅禁止 inline `metadata`，但允许 raw body 其他字段原样进入 provider。

判定：
- 对 direct passthrough 端口，这属于 direct 协议直通边界；direct 本身不走 HubPipeline response/chatprocess，因此不适用 servertool/followup。
- 但 router-direct 若从 Hub route 预跑后仍优先 raw body，必须确保它只是 same-protocol direct，不进入 relay/followup 语义路径。

处理决策：
- direct 路径保留为 direct-only，但必须文档与红测锁住：direct 不进入 Hub response process、不激活 followup/stopless、不从 rawBody 进入 relay provider outbound。
- relay/followup 禁止使用 `__raw_request_body` 构造 provider body。

### 11.2 DeepSeek provider helpers 读取工具/消息字段

文件：`src/providers/core/runtime/deepseek-http-provider-helpers.ts`

现状：
- `shouldForceUpstreamSseForTools(...)` 读取 `direct.tools` / `data.tools` 判断上游 SSE。
- `extractPromptFromPayload(...)` 从 `body.messages` / `data.messages` 构建 prompt。

判定：
- 若输入是已通过 ReqOutbound 的 provider semantic payload，provider runtime 可读取当前 provider body 字段进行传输选择。
- 若读取 `request.data` 或 raw wrapper 作为字段补偿，则存在绕过 Hub 标准字段的风险。

处理决策：
- 保留 provider runtime 对当前 provider wire body 的读取。
- 审计并移除从 wrapper/raw `data.*` 补 prompt/tools 的行为；provider runtime 不应有第二输入源。

### 11.3 Provider runtime TS semantic conversion

判定：
- provider runtime 若承担 request protocol semantic conversion / tool governance，属于越界。
- 按项目护栏，Hub Pipeline / Chat Process / req_outbound 语义必须 Rust-only；provider runtime 只能做 transport/auth/provider 内部协议兼容，不能重建工具治理。

处理决策：
- 这类 provider runtime semantic conversion 必须下沉到 Rust outbound/profile 语义块，或随对应 provider 实现物理删除。
- TS provider runtime 收缩为 transport shell；不得从 Responses input 转 Chat messages。

### 11.4 OpenAI Responses SDK transport raw body 传递

文件：`src/providers/core/runtime/openai-responses-sdk-transport.ts`

现状：
- `executePreparedRequest(...)` 将 `requestInfo.body` 作为 `rawBody` 传入 OpenAI SDK。

判定：
- 如果 `requestInfo.body` 已是 `ProviderReqOutbound06WirePayload`，这是合法 transport。
- 需要红测证明 SDK transport 不读取 metadata/raw/context 补字段。

处理决策：
- 保留 transport passthrough。
- 增加 ProviderReqOutbound guard 与 transport-level no-internal-carrier test。

### 11.5 Vercel AI SDK OpenAI transport 保留 raw 字段合并

文件：`src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`

现状：
- `mergePreservedOpenAiRequestFields(rawBody, builtBody)` 将 `rawBody` 中未被 SDK builder 覆盖的字段合并回 request，除 `__*` 与 `metadata` 外基本保留。
- `executePreparedRequest(...)` 对 `requestInfo.body` 调用 `normalizeResponsesToChatBody(rawBody)`。

判定：
- `mergePreservedOpenAiRequestFields` 是典型“raw request 字段回填”模式；即使 rawBody 是 provider wire，也会绕过显式字段矩阵与 outbound builder。
- `normalizeResponsesToChatBody` 在 provider transport 中做协议转换，属于 TS 语义路径。

处理决策：
- 列为 Rust 下沉/删除候选。
- SDK transport 只能消费 Rust outbound 生成的 SDK call options，不再 merge rawBody 未知字段。

### 11.6 servertool followup request context capture 仍保存 toolsRaw

文件：`src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`

现状：
- `captureNestedResponsesRequestContext(...)` 将 `body.tools` 保存为 `toolsRaw` / `toolsNormalized`。

判定：
- 若该 context 仅供 response projection 名称/参数还原，可保留为 response-only side-channel。
- 当前命名与位置容易被后续请求恢复路径消费，且已有历史污染证明。

处理决策：
- 改名/隔离为 response projection only carrier，例如 `responseProjectionToolsRaw`，并禁止 ReqOutbound 读取。
- 或在 followup 请求 context 中完全不保存 tools，改由 chat process ledger 保存响应投影所需最小 tool alias map。

## 12. 追加审计：TS Legacy Conversion 路径

### 12.1 Responses OpenAI bridge

文件：
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts`

现状：
- 使用 `responsesContext`、`toolsRaw`、`restoredTools`、`buildResponsesPayloadFromChat(...)`。
- `response-payload.ts` 调用 native `buildResponsesPayloadFromChatWithNative(...)`，但仍由 TS 收集/传入 `toolsRaw` 与 retention metadata。

判定：
- response projection 可读取工具上下文，但必须是 response-only carrier。
- 若 `responsesContext` 被保存后用于后续 request payload build，则违规。
- TS bridge 仍承担过多协议语义拼接。

处理决策：
- 将 Responses payload build 的 owning builder 固定在 Rust `RespOutbound` / `ReqOutbound` 对应节点。
- TS 只调用 Rust，不再合并/选择 raw context 字段。
- 删除 `restoredTools` request 恢复含义；保留时必须改成 response projection alias map。

### 12.2 DeepSeek compat action raw tools restore

文件：`sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-request.ts`

现状：
- 注释明确：`Restore tools from __hub_capture if payload.tools was summarized`。
- 当 `payload.tools` 不是数组时，从 `captureContext.toolsRaw` 恢复 tools。

判定：
- 直接违反禁止 raw/context 回填 live request 字段。

处理决策：
- 删除该路径。
- 若 DeepSeek 需要工具文本协议，由 Rust ReqOutbound DeepSeek profile 从 chat process tool semantics 生成。

## 13. 追加审计：servertool followup delta DSL

文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs`

现状：
- `extract_captured_chat_seed(...)` 从 captured request 提取 `model/messages/parameters`。
- `apply_followup_delta_plan(...)` 构造 payload：`messages`、`model`、`tools`、`parameters`。
- delta ops 可直接操作 `replace_tools`、`force_tool_choice`、`drop_tool_by_name`、`trim_openai_messages`。

判定：
- 这是 followup 专用请求构造 DSL，不等价于普通请求链。
- 即使在 Rust 中，也不是 `ReqInbound -> ReqChatProcess -> ReqOutbound` 的唯一字段转换路径。

处理决策：
- 不再扩展该 DSL。
- 后续重构应把 servertool followup 改为构造一条“等价客户端请求输入”并重新进入 ReqInbound；工具/参数/模型由正常链路处理。
- 现有 delta ops 按能力分类：
  - 允许迁移：append user/system text（作为客户端等价输入）。
  - 禁止/删除：replace_tools、force_tool_choice、drop_tool_by_name、从 seed 恢复 tools。
  - 待迁移：messages trim/compact 应移入 chatprocess history governance。

## 14. 完整违规路径清单（当前版）

| 编号 | 文件 | 函数/位置 | 违规类型 | 决策 |
|---|---|---|---|---|
| V1 | `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` | `restoreFollowupRootToolsIfNeeded` | semantics/clientToolsRaw -> `body.tools` | 删除 |
| V2 | `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` | `captureNestedResponsesRequestContext` | 保存 `body.tools` 为 `toolsRaw/toolsNormalized` | 改 response-only carrier 或删除 |
| V3 | `shared_responses_conversation_utils.rs` | `prepare_responses_conversation_entry` | context/payload tools 持久化 | 删除 |
| V4 | `shared_responses_conversation_utils.rs` | resume/restore/materialize continuation | entry tools -> payload tools | 删除 |
| V5 | `stop-message-loop-payload-block.ts` | `buildStopMessageLoopPayload` | seed tools -> payload tools | 删除 |
| V6 | `servertool_followup_delta.rs` | `apply_followup_delta_plan` | followup 专用 payload DSL | 收敛为等价客户端输入；字段 ops 删除/迁移 |
| V7 | `servertool_followup_delta.rs` | `replace_tools` / `force_tool_choice` ops | 直接改 tools/tool_choice | 删除或移入 chatprocess policy |
| V8 | `responses-openai-bridge*.ts` | `responsesContext/toolsRaw/restoredTools` | TS legacy context 参与 payload build | Rust 下沉；response-only 隔离 |
| V9 | `deepseek-web-request.ts` | `__hub_capture.context.toolsRaw` restore | raw context -> provider tools | 删除；Rust profile 生成 |
| V10 | provider runtime preprocess | request preprocess | provider runtime 做 input/tools/tool_choice/model semantic conversion | Rust 下沉或物理删除；TS transport shell |
| V11 | `openai-sdk-transport.ts` | `mergePreservedOpenAiRequestFields` | rawBody 未知字段回填 | 删除；SDK options 由 Rust outbound 显式生成 |
| V12 | `deepseek-http-provider-helpers.ts` | `data.tools/data.messages` fallback | wrapper/raw data 字段补偿 | 删除 wrapper 补偿；只读 provider body |
| V13 | `direct-passthrough-payload.ts` | `metadata.__raw_request_body` | direct raw passthrough | direct-only 保留；禁止 relay/followup 使用 |
| V14 | `standardized_request.rs` | `clientToolsRaw` / `raw_payload.tools` | raw tools 语义边界不清 | 明确 ReqChatProcess-only input 或 response-only alias；禁止 outbound 读取 |

## 15. 建议改动顺序（审计后执行）

1. 先加红测，不改行为：覆盖 V1、V3、V5、V9、V11 的 raw/context 回填。
2. 完成已知错误路径物理删除：V1、V3、V4、V5、V9、V11。
3. 给 `ProviderReqOutbound06WirePayload` 加运行时 guard：禁止 internal carrier、`metadata`、`type:"namespace"`、`toolsRaw/clientToolsRaw`。
4. 收敛 `servertool_followup_delta`：删除 tools/tool_choice ops；仅保留等价用户输入注入；history compact/trim 移入 chatprocess。
5. 重命名/隔离 response projection tool alias carrier，禁止 ReqOutbound 读取。
6. Rust 下沉 provider runtime semantic conversion：Vercel SDK OpenAI、DeepSeek web tools profile，以及任何仍存活 provider runtime 中的协议语义转换。
7. 更新 docs/skills/MEMORY，并通过 build/install/live sample 验证。

## 16. 追加审计：关键词反查后的风险分级

本轮反查关键词：`restore/backfill/fallback/preserve/mergePreserved/rawBody/__hub_capture/toolsRaw/clientToolsRaw/responsesContext/contextSnapshot/requestMetadata`。

### 16.1 与本目标直接相关

- `src/providers/profile/families/qwen-profile.ts`
  - 风险：provider profile 读取 runtime metadata 中的 `reasoning_effort`，可能把 side-channel 控制语义投影成 provider body 字段。
  - 决策：纳入 Rust outbound/provider profile 参数映射审计；TS profile 不应拥有 live request semantic source。

  - 风险：provider runtime 将 `input -> messages`、拆分 `tools`、隐藏 `tool_choice`，并把 reasoning effort 合并进 model。
  - 决策：列为 provider-specific outbound projection Rust 下沉；TS runtime 收缩为 transport。

- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`
  - 风险：`normalizeResponsesToChatBody(rawBody)` 与 `mergePreservedOpenAiRequestFields(rawBody, builtBody)` 在 SDK transport 层继续做协议转换与 raw 字段合并。
  - 决策：删除 raw merge；SDK call options 由 Rust `ProviderReqOutbound06WirePayload`/provider SDK semantic block 显式生成。

- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
  - 风险：读取 wrapper `data.tools/data.messages/data.prompt` 作为补偿输入源。
  - 决策：provider runtime 只读 provider wire body，不读 wrapper/raw data 补请求字段。

- `src/server/runtime/http-server/direct-passthrough-payload.ts`
  - 风险：direct 使用 `metadata.__raw_request_body` 构造 provider body。
  - 决策：仅允许 direct-only passthrough；relay/followup 禁止。需红测证明 `serverToolFollowup` 不会走此路径。

### 16.2 只允许 response-only / observability

- `src/providers/core/utils/snapshot-writer.ts` 中 `requestMetadata`：只允许 snapshot/观测；不得作为 live request source。
- `provider-response-converter.ts` / `responses-openai-bridge*` 中 `toolsRaw/clientToolsRaw`：只允许 response projection name/argument normalization；需改名或类型隔离，禁止 ReqOutbound 消费。
- `hub_resp_outbound_client_semantics_tests.rs` 中 `toolsRaw`：响应投影测试可保留，但应改成 response-only alias map 语义，避免名称误导。

### 16.3 与本目标无关或低相关

- auth/token/oauth fallback、mock sample fallback、error message fallback、test helper fallback：不纳入本次请求字段治理。
- `fallback` 字样若仅用于默认值、错误消息、测试数据，不作为本次违规路径。

## 17. 审计结论状态

当前审计已覆盖：
- servertool followup dispatch
- stop-message loop payload
- Rust responses conversation restore/materialize
- Rust servertool followup delta DSL
- TS Responses bridge / legacy codec
- DeepSeek compat action
- provider runtime / SDK transport 层
- direct passthrough raw body 边界

仍需在实施前补证据：
- 每条违规路径对应红测文件名和断言点。
- `ProviderReqOutbound06WirePayload` guard 当前覆盖哪些 forbidden fields，缺哪些。
- 普通请求与 followup 请求的字段等价样本对比：同一 tools/input/model/tool_choice 输入，在普通请求与 followup 进入 ReqChatProcess 后语义是否一致。

## 18. ProviderReqOutbound06WirePayload guard 缺口

文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/provider_req_outbound_06_wire_payload.rs`

当前 guard：
- `assert_no_inline_metadata(...)`：禁止 normal payload inline `metadata`。
- `assert_payload_has_no_meta_or_error_carrier(...)`：禁止 Meta/Error carrier 混入 payload。
- `assert_no_provider_options_metadata(...)`：禁止 provider SDK options 内携带 `metadata`。

缺口：
- 未禁止 `toolsRaw` / `clientToolsRaw` / `responsesContext` / `contextSnapshot` / `requestMetadata` 进入 provider wire。
- 未禁止 `tools[*].type == "namespace"` 进入 provider wire。
- 未禁止 nested tool definition 中出现 Codex namespace aggregate shape：`{ type:"namespace", name, tools:[...] }` 或 `{ name, tools:[...] }`。

处理决策：
- 在 `ProviderReqOutbound06WirePayload` builder 增加 request-wire forbidden scan。
- forbidden scan 不做 silent strip，只 fail-fast，错误进入 ErrorErr 链。
- 红测：构造 `HubReqOutbound05ProviderSemantic` 带 namespace tools / `toolsRaw` / `clientToolsRaw`，`build_provider_req_outbound_06_from_hub_req_outbound_05` 必须失败。

## 19. 红测文件建议矩阵

| 风险编号 | 建议测试文件 | 断言 |
|---|---|---|
| V1/V2 | `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` | followup semantics 含 `clientToolsRaw` 时 nested body 不从 semantics 恢复 `tools` |
| V3/V4 | Rust `shared_responses_conversation_utils.rs` tests | entry/context/payload 含 `tools` 时 resume/materialize payload 不含 entry tools |
| V5 | `tests/servertool/stop-message-loop-payload-block.spec.ts` 或现有 servertool suite | captured seed 含 tools 时 loop payload 不含 tools |
| V6/V7 | Rust `servertool_followup_delta.rs` tests | `replace_tools` / `force_tool_choice` 不再生成 live request fields；或该 DSL 删除后无导出 |
| V8 | Responses bridge tests | `toolsRaw/restoredTools` 只能影响 client response projection，不能参与 request payload build |
| V9 | `deepseek-web-request` compat tests | `__hub_capture.context.toolsRaw` 不会 restore 到 payload.tools |
| V10 | provider runtime semantic-conversion tests | provider runtime 不做 `input -> messages` / tools governance；新 Rust outbound profile 做等价投影 |
| V11 | Vercel SDK transport tests | rawBody 未知字段不被 merge 回 SDK request |
| V12 | DeepSeek helper tests | wrapper `data.tools/data.messages` 不作为 provider request 补偿输入 |
| V13 | direct passthrough tests | direct-only 可用 raw body；relay/followup 不可使用 `__raw_request_body` 构造 provider body |
| V14 | Rust pipeline contract tests | `ProviderReqOutbound06WirePayload` 禁止 namespace/internal request carriers |

## 20. 审计输出摘要（2026-06-04）

本节是给后续 `/goal` 执行使用的审计输出。它不是修复结论，而是当前已收敛的风险清单、单一路径约束和实施顺序。

### 20.1 当前问题定性

问题性质：请求字段等价转换链路存在架构性混线。普通请求、servertool followup、provider runtime、TS legacy bridge 中仍有多处从 raw request / context / metadata / snapshot carrier 回填 live provider request 字段的路径，导致 Codex namespace 聚合工具、内部 metadata、旧工具列表或 wrapper 字段越过 `ReqChatProcess`，直接进入 provider wire body。

直接线上证据：
- 样本 `~/.rcc/codex-samples/openai-responses/port-5555/openai-responses-mimo.key2-mimo-v2.5-20260604T172524309-256981-624_stop_followup/provider-request.json` 的 `body.tools[11].type = "namespace"`。
- 同一样本 `meta.requestMetadata.__raw_request_body.tools[11..13]` 保存原始 Codex namespace tools，`contextSnapshot.toolsRaw` / `responsesContext.toolsRaw` 曾传播 raw tools。
- MiniMax 返回 `invalid tool type: namespace (2013)`，说明 provider wire body 已被 raw tools 污染。

架构结论：
- 这不是 MiniMax 单 provider bug，也不是过滤一个 `namespace` 就能解决的问题。
- 唯一正确方向是恢复请求字段单向链：`ServerReqInbound01ClientRaw -> HubReqInbound02Standardized -> HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload -> ProviderReqOutbound07TransportRequest`。
- `ReqChatProcess` 必须拥有完整请求语义；`ReqOutbound` / provider runtime 只能消费标准语义，不得读取 raw/context/metadata 补字段。
- servertool followup 不是特殊协议；它只是绕过客户端执行本地工具后代客户端发起下一次正常请求。followup 的请求字段转换必须与普通请求完全相同。

### 20.2 必须禁止的 live request 字段来源

以下来源只能用于观测、snapshot、响应投影辅助或 direct-only passthrough；不得进入 relay/followup provider wire body：

| 来源 | 禁止用途 | 允许用途 |
|---|---|---|
| `rawBody` / `__raw_request_body` | 恢复 `tools/messages/input/model/tool_choice/reasoning` | snapshot；direct-only passthrough |
| `metadata` / `requestMetadata` | provider body / SDK options / followup body 字段来源 | 当前闭环内部控制 carrier |
| `contextSnapshot` / `responsesContext` | 恢复历史 tools 或 request params | response-only alias / observability，且需类型隔离 |
| `toolsRaw` / `clientToolsRaw` | 直接写回 `body.tools` | response projection 辅助映射，不能被 ReqOutbound 读取 |
| `semanticsTools` / `baselineTools` / `canonicalTools` | followup root tools restore | 若存在，必须是 ReqChatProcess 内部标准语义，不得反向生成 raw body |
| provider wrapper `data.*` | 补 `tools/messages/prompt` | provider runtime 已生成的 wire body 调试信息 |

### 20.3 字段等价审计矩阵

| 字段族 | 唯一入口 | 唯一真源节点 | 唯一出站节点 | 当前风险 |
|---|---|---|---|---|
| `tools` / `tool_choice` / `parallel_tool_calls` | ReqInbound | ReqChatProcess | ReqOutbound / ProviderReqOutbound | raw tools、namespace aggregate、followup restore、provider runtime 二次治理 |
| `input` / `messages` / `instructions` | ReqInbound | ReqChatProcess | ReqOutbound | TS bridge/provider runtime 仍可能做协议互转 |
| tool result history | ReqInbound | ReqChatProcess | ReqOutbound | 旧 conversation restore 可能从 payload/context 补历史 |
| `model` / params | ReqInbound | ReqChatProcess | ReqOutbound | followup delta DSL 可直接替换字段 |
| `reasoning` / thinking | ReqInbound | ReqChatProcess | ReqOutbound | provider runtime/legacy bridge 可能按 raw 协议重建 |
| continuation | ReqInbound | ReqChatProcess | ReqOutbound | responses conversation materialize 必须只产标准语义，不产 raw payload |
| metadata / snapshot | Meta carrier | side-channel | 不进入 normal payload | client response/provider body 泄露已多次出现 |
| direct passthrough | direct adapter | direct-only | provider transport | 必须证明 relay/followup 不可进入 direct raw path |

### 20.4 必须物理删除或 Rust 下沉的路径

1. `servertool-followup-dispatch.ts`：删除所有从 `clientToolsRaw` / `semanticsTools` / `baselineTools` / `canonicalTools` 恢复 `body.tools` 的代码与测试期望。
2. `shared_responses_conversation_utils.rs`：删除 entry/base payload/context 中 tools 的持久化与恢复；conversation continuation 只能 materialize 为 chatprocess 标准语义。
3. `stop-message-loop-payload-block.ts`：删除 captured seed tools 回填；stopless followup 只注入下一轮用户意图和 stop schema 指令。
4. `servertool_followup_delta.rs`：删除或重构 followup 专用 `replace_tools` / `force_tool_choice` / request-field DSL；followup 只能构造等价客户端输入，不拥有 provider request patch 能力。
5. `deepseek-web-request.ts` / DeepSeek helpers：删除 `__hub_capture.context.toolsRaw -> payload.tools` 和 wrapper `data.tools/messages/prompt` 作为请求补偿来源。
6. Vercel/OpenAI SDK transport：删除 `mergePreservedOpenAiRequestFields(rawBody, builtBody)` 这类 raw merge；SDK options 必须由标准语义显式生成。
7. Provider runtime TS semantic conversion：`input -> messages`、tool governance、tool_choice/model/reasoning 转换应下沉到 Rust outbound profile；provider runtime 不再拥有 Hub 语义转换职责。
8. response projection 中的 `toolsRaw/clientToolsRaw` 如仍需存在，必须改名/改型为 response-only alias carrier，且 red test 证明 ReqOutbound 无法读取。

### 20.5 红测优先级

P0 必须先补红测，再继续删路径：
- ProviderReqOutbound guard：`type:"namespace"`、`toolsRaw`、`clientToolsRaw`、`responsesContext`、`contextSnapshot`、`requestMetadata`、`rawBody` 进入 provider wire 必须 fail-fast。
- servertool followup：origin/body/semantics 含 raw tools 时，nested followup body 不得恢复 `tools`。
- stop-message loop：captured seed 含 tools 时，loop payload 不含 tools。
- responses conversation：entry/context/payload 含 tools 时，resume/materialize 后不含 raw tools。
- DeepSeek/Vercel SDK：raw/context/wrapper 字段不得 merge 回 provider request。
- direct boundary：direct-only 可 passthrough raw body；relay/followup 不可进入 direct raw path。

P1 实施后验证：
- 普通请求与 followup 请求用同一组 `input/tools/tool_choice/model/reasoning`，进入 `ReqChatProcess` 后标准语义一致。
- 在线 provider-request snapshot 不含 `type:"namespace"`，不含内部 metadata/requestMetadata/contextSnapshot/toolsRaw/clientToolsRaw/rawBody。
- metadata 只存在 side-channel，provider body、SDK options、client response body 均无内部 carrier。

### 20.6 实施顺序

1. 补红测锁住所有 raw/context/metadata 回填路径；先让旧实现红。
2. 删除已确认错误路径，不做 provider-specific filter，不做 silent strip。
3. 把 TS 中承担请求语义转换的逻辑下沉 Rust；TS 只保留薄壳和相邻节点调用。
4. 收敛 followup：一次 followup 就是一次正常请求复入，不嵌套专用 request patch，不走 direct。
5. 加强 ProviderReqOutbound06WirePayload guard：任何内部 carrier 或 Codex namespace aggregate 到 wire 都 fail-fast。
6. 更新 `docs/design/pipeline-type-topology-and-module-boundaries.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、`note.md`、`MEMORY.md`。
7. 运行定向 Rust/Jest、`npm run build:min`、全局安装、服务重启、`/health`、线上样本验证。
8. 提交，保持工作区干净。

### 20.7 完成定义

- provider wire body 不再出现 `type:"namespace"` 聚合工具和内部 carrier。
- 普通请求与 followup 请求字段转换同链路、同语义、同 red tests。
- raw/context/metadata 不能作为 live request 字段来源；红测覆盖并持续锁定。
- direct passthrough 与 relay/followup 边界清晰；direct 不进 Hub response/chatprocess/servertool。
- 文档、skills、note、MEMORY 同步更新。
- build/install/restart/live 验证通过并提交。

## 21. `/goal` 提示词

```text
/goal
目标：修复 RouteCodex 请求字段等价链路，确保普通请求和 servertool followup 都只走 ReqInbound -> ReqChatProcess -> ReqOutbound，彻底删除 raw/context/metadata 回填 provider payload 的错误路径。

实现文档：
docs/goals/request-field-chatprocess-equivalence-audit-plan.md

执行规范：
- ChatProcess 是请求语义唯一真源；provider outbound 只能消费标准语义，不得从 rawBody、__raw_request_body、metadata、requestMetadata、contextSnapshot、responsesContext、toolsRaw/clientToolsRaw 补字段。
- followup 是代客户端发起的正常请求，必须与普通请求同入口、同转换、同响应链；不得拥有专用 tools/tool_choice/request-field patch DSL，不得走 direct。
- 禁止 provider-specific filter、silent strip、fallback、双路径补偿；确认错误路径后物理删除，并用红测锁住。
- Hub Pipeline / chat process / req_outbound / servertool orchestration 的语义改动必须 Rust-only；TS 只允许薄壳或删除旧逻辑。

验证：
- 先补红测：ProviderReqOutbound namespace/internal carrier guard、followup raw tools 不回填、stop-message seed tools 不回填、conversation tools 不恢复、DeepSeek/Vercel raw merge 禁止、direct 边界。
- 跑定向 Rust/Jest，再跑 npm run build:min、全局安装、重启 5555、/health。
- 在线样本验证 provider-request 不含 type:"namespace"，不含 metadata/requestMetadata/contextSnapshot/responsesContext/toolsRaw/clientToolsRaw/rawBody 等内部 carrier。

完成标准：
- 普通请求与 followup 请求字段转换等价，provider wire 只来自标准语义。
- MiniMax 2013 namespace 工具污染不可复现；metadata/client response 泄露不可复现。
- 文档、skills、note、MEMORY 更新；提交完成且工作区干净。
```

## 22. 实施收敛记录（2026-06-04）

本节记录本轮已落地的处理决策与验证证据，作为后续提交前的 completion audit 输入。

### 22.1 已物理删除/收敛的违规路径

- `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
  - 删除 nested Responses context 中从 `body.tools` 写入 `toolsRaw/toolsNormalized` 的路径。
  - 删除 nested followup metadata/body 中注入 `requestSemantics` 的路径；`requestSemantics` 只可作为当前调度内控制判断输入，不进入 nested live request body/metadata。
  - 红测：`tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` 断言 followup 不从 `requestSemantics.tools.clientToolsRaw` 恢复 tools，不从 metadata/requestSemantics 回填 `tool_choice` / responses context。

- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`
  - 删除 `mergePreservedOpenAiRequestFields(rawBody, builtBody)`，SDK provider body 只使用 SDK argsResult 的标准输出，不从 raw request merge `input/contextSnapshot/__raw_request_body/metadata`。
  - 红测：`tests/providers/core/runtime/vercel-ai-sdk-openai-transport.spec.ts` 断言 raw-only `input/contextSnapshot/__raw_request_body/parameters` 不进入 outbound body。

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs`
  - 删除 followup delta 中 `preserve_tools/ensure_standard_tools/replace_tools/force_tool_choice/drop_tool_by_name/append_tool_if_missing` 等工具字段 DSL 支持。
  - 删除从 seed 恢复 `tools` 与 `parameters.tool_choice` 的路径；followup delta 只构造等价消息/工具结果上下文，不拥有工具字段 patch 能力。
  - 红测：`servertool_followup_delta` Rust targeted tests 断言 seed tools/tool_choice 不保留，工具输出消息仍可构造。

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - 删除 continue_execution followup 生成的 `preserve_tools/ensure_standard_tools` ops。

- `sharedmodule/llmswitch-core/src/servertool/handlers/{apply-patch,vision,web-search}.ts`
  - 删除 followup injection 中的 `drop_tool_by_name` 旧 op；TS 壳不再表达工具裁剪/替换语义。

- `sharedmodule/llmswitch-core/src/servertool/types.ts` 与 `.d.ts`
  - 删除 followup injection 类型中的工具字段补偿 ops，避免死语义被重新使用。

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/provider_req_outbound_06_wire_payload.rs`
  - 增加 ProviderReqOutbound wire guard：禁止 `toolsRaw/clientToolsRaw/responsesContext/contextSnapshot/requestMetadata/__raw_request_body/rawBody` 和 `type:"namespace"` 聚合工具进入 provider wire。
  - 红测：`provider_req_outbound_06_wire_payload` Rust targeted tests 覆盖 request context field 与 namespace aggregate fail-fast。

### 22.2 当前允许但需边界说明的残留

- `append_tool_if_missing` 仍存在于 request-side tool governance / web_search 注入路径，属于 `ReqChatProcess` 工具治理，不属于 servertool followup request-field patch DSL。
- `toolsRaw/clientToolsRaw` 在 response projection 测试和响应 alias 场景仍可出现；该用途必须保持 response-only，不得被 ReqOutbound/ProviderReqOutbound 读取。ProviderReqOutbound guard 已作为 wire 端红线。
- `__raw_request_body` 仍用于 handler metadata/snapshot/direct-only passthrough；relay/followup 不得从中恢复 live request 字段，相关回填热点扫描当前未命中。

### 22.3 已执行验证

- `npm run build:min`：通过，版本 bump 到 `0.90.2821`。
- TS targeted：`tests/servertool/followup-origin-delta.spec.ts`、`tests/servertool/apply-patch-flow.spec.ts`、`tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`、`tests/providers/core/runtime/vercel-ai-sdk-openai-transport.spec.ts` 全部通过（48 tests）。
- Rust targeted：`servertool_followup_delta` 通过（7 tests）；`provider_req_outbound_06_wire_payload` 通过（4 tests）。
- 残留扫描：runtime 中 `preserve_tools/ensure_standard_tools/replace_tools/force_tool_choice/drop_tool_by_name` 无命中；明确回填热点 `restoreFollowupRootToolsIfNeeded/mergePreservedOpenAiRequestFields/toolsRaw from body.tools/metadata.requestSemantics` 无命中。

### 22.4 Snapshot meta sanitizer closeout

- `src/providers/core/utils/snapshot-writer.ts` 对落盘 `meta.requestMetadata` 增加 snapshot-only sanitizer，删除 `__raw_request_body/rawBody/requestMetadata/responsesRequestContext/responsesContext/contextSnapshot/toolsRaw/clientToolsRaw/toolsNormalized`。
- 该 sanitizer 只作用于 debug/snapshot payload，不改变 live metadata side-channel，不改变 provider body。
- 红测：`tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts` 断言 provider-request snapshot 的 requestMetadata 保留 `matchedPort/portContext`，但不再包含 raw request/context tools carriers 与 `type:"namespace"`。

## 23. 审计输出 v2：请求字段等价与 no raw backfill（2026-06-04）

本节是当前可执行审计输出，供后续 `/goal` 直接引用。若与前文早期排查表述冲突，以本节为准。

### 23.1 核心结论

当前问题不是单个 provider 的 `namespace` 兼容问题，而是请求字段主链与内部 carrier 混线：普通请求、servertool followup、legacy TS bridge、provider SDK transport、snapshot/debug metadata 中曾存在从 raw request / context / metadata / requestSemantics / toolsRaw 回填 live provider request 的行为。该行为绕过 `HubReqChatProcess03Governed`，使 Codex namespace 聚合工具或内部 metadata 有机会进入 `ProviderReqOutbound06WirePayload`，最终触发 MiniMax `invalid tool type: namespace (2013)`、client response metadata 泄漏、followup 与普通请求字段语义不一致等问题。

唯一修复方向：所有请求字段必须单向流动：

```text
ServerReqInbound01ClientRaw
  -> HubReqInbound02Standardized
  -> HubReqChatProcess03Governed
  -> VrRoute04SelectedTarget
  -> HubReqOutbound05ProviderSemantic
  -> ProviderReqOutbound06WirePayload
  -> ProviderReqOutbound07TransportRequest
```

`metadata`、`requestMetadata`、`__rt`、snapshot/debug 信息只能走 side-channel carrier；它们可以被当前闭环内的控制逻辑读取，但不得生成、补偿、恢复或覆盖 live provider request body/options 中的 `tools/input/messages/tool_choice/model/reasoning` 等字段。

### 23.2 必须删除/禁止的路径

1. **followup request-field patch DSL**：servertool followup 不允许通过 `preserve_tools`、`ensure_standard_tools`、`replace_tools`、`force_tool_choice`、`drop_tool_by_name`、`append_tool_if_missing` 等 op 修改 live request 字段。followup 只代客户端执行本地工具后发起一次等价请求；请求字段仍由标准 request pipeline 重新生成。
2. **raw request merge**：provider SDK transport 不允许把 `rawBody` / `__raw_request_body` / unknown raw fields merge 回 provider body。
3. **context/tools restore**：不允许从 `contextSnapshot`、`responsesContext`、`toolsRaw`、`clientToolsRaw`、`requestSemantics` 恢复 `body.tools`、`tool_choice`、`input/messages`。
4. **metadata request payload**：不允许 `body.metadata -> provider options`、`payload.metadata.context -> provider body`、`requestMetadata -> provider wire`。
5. **namespace aggregate passthrough**：Codex `type:"namespace"` 聚合工具必须在 `ReqChatProcess` 唯一工具治理点标准化；任何 `ProviderReqOutbound06WirePayload` 中出现 namespace aggregate 都必须 fail-fast。
6. **direct 误入 Hub response pipeline**：direct provider passthrough 不走 HubPipeline response conversion / servertool orchestration；followup/stopless 对 direct 不生效。

### 23.3 允许存在但必须隔离的字段

- `metadata`：只允许作为同一 request/response 闭环内控制 carrier；不得出现在 provider wire body、SDK options、client normal response body。
- `requestMetadata`：只允许用于 runtime/snapshot/debug 观测；snapshot 落盘前必须清理 raw request/context carriers。
- `toolsRaw/clientToolsRaw`：只允许 response projection 的只读辅助信息；不得被 request outbound/provider outbound 读取。
- `__raw_request_body/rawBody`：只允许 entry/direct-only passthrough 或审计快照用途；relay/followup/provider SDK 不得读取它们重建请求字段。
- `append_tool_if_missing`：只允许出现在 `ReqChatProcess` 请求侧工具治理内，不允许作为 followup delta/request patch DSL。

### 23.4 已确认的修复点

- `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`：已删除 nested followup 写入 `toolsRaw/toolsNormalized` 与 `requestSemantics` live metadata/body 的路径。
- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`：已删除 `mergePreservedOpenAiRequestFields(rawBody, builtBody)` raw merge。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs`：已删除 followup 工具字段 patch DSL 与 seed tools/tool_choice preserve。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`：已删除 continue_execution 生成工具补偿 ops。
- `sharedmodule/llmswitch-core/src/servertool/handlers/{apply-patch,vision,web-search}.ts` 与 `sharedmodule/llmswitch-core/src/servertool/types.ts`：已删除旧 followup tool op 类型与生成逻辑。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/provider_req_outbound_06_wire_payload.rs`：已增加 provider wire guard，禁止 internal request carriers 与 namespace aggregate 进入 provider wire。
- `src/providers/core/utils/snapshot-writer.ts`：已增加 snapshot-only sanitizer，清理落盘 `meta.requestMetadata` 中的 raw/context/tool carriers；该处理不得被当作 live path 修复。

### 23.5 仍需执行的审计/验证闭环

1. **样本验证**：全局安装并重启 5555 后，用包含 Codex `type:"namespace"` 聚合工具的 `/v1/responses` 请求生成新样本；检查最新 `provider-request.json`：
   - `body.tools` 不存在 namespace aggregate；
   - `body` 不含 `toolsRaw/clientToolsRaw/responsesContext/contextSnapshot/requestMetadata/__raw_request_body/rawBody`；
   - `meta.requestMetadata` 不含 raw request/context/tool carriers。
2. **普通请求 vs followup 等价**：同类输入在普通请求和 followup 中都必须从 `ReqInbound -> ReqChatProcess -> ReqOutbound` 生成 provider body；followup 不得拥有字段补偿路径。
3. **direct 边界**：direct 请求不进入 Hub response conversion/servertool followup；relay/followup 不使用 direct raw body。
4. **红测闭环**：TS targeted、Rust targeted、snapshot sanitizer、response metadata guard、topology residue red tests 必须通过。
5. **构建部署闭环**：`npm run build:min`、`npm run install:global`、5555 scoped restart、`/health`、live sample 均需有证据后才能提交。
6. **提交闭环**：review diff，提交相关改动，最终 `git status --short` clean。

### 23.6 后续改动边界

- 禁止继续在 TS live path 添加“过滤 namespace / 清洗 tools / 补 metadata / 修 followup body”的局部补丁。
- 如果发现字段转换仍在 TS 中承担语义真源，优先列入 Rust 下沉或物理删除计划；TS 只能保留薄壳和 adapter。
- 如果发现 live path 需要 sanitizer 才能不泄漏，说明真源位置仍错误；应回到 `ReqInbound/ReqChatProcess/ReqOutbound` 修复。
- 所有错误必须显式暴露并进入 ErrorErr 链，禁止 fallback 成成功响应。

## 24. 可复制 /goal 提示词

```text
/goal
目标：完成 RouteCodex 请求字段等价审计与 no raw backfill 修复闭环，确保普通请求和 servertool followup 都只从 ReqInbound -> ReqChatProcess -> ReqOutbound -> ProviderReqOutbound 生成 provider request，不再从 raw/context/metadata/toolsRaw 回填 live 请求字段。

实现文档：
docs/goals/request-field-chatprocess-equivalence-audit-plan.md（以 §23 审计输出 v2 为执行真源）

执行规范：
- Hub Pipeline / Chat Process / servertool followup 语义必须 Rust-only；TS 只能保留薄壳，禁止新增 live request 字段补丁。
- 禁止 fallback、silent strip、raw request merge、metadata/context/toolsRaw 回填 provider payload；发现必须 fail-fast 并修唯一真源。
- followup 是标准请求复入，只代客户端执行本地工具；不得拥有工具列表/tool_choice/input/messages 专用补偿 DSL。
- metadata/requestMetadata/snapshot/debug carrier 必须与 normal request/response payload 隔离；闭环结束不得污染 provider body、SDK options、client response。
- direct passthrough 不走 HubPipeline response conversion/servertool orchestration；relay/followup 不得使用 direct raw body。

验证：
- 定向 TS/Rust 红测：followup dispatch、servertool delta、provider wire guard、snapshot sanitizer、response metadata guard、topology residue。
- `npm run build:min`、`npm run install:global`、scoped restart 5555、`/health`。
- live namespace 样本：`provider-request.json` 的 body 和 `meta.requestMetadata` 均不得出现 namespace aggregate 或 raw/context/internal request carriers。
- 普通请求与 followup 请求样本对比：字段转换路径一致，followup 不出现 request-field patch DSL。

完成标准：
- provider wire 不再出现 `type:"namespace"`、`toolsRaw/clientToolsRaw/responsesContext/contextSnapshot/requestMetadata/__raw_request_body/rawBody`。
- client response/SSE 不再泄漏 internal `metadata` carrier。
- 相关文档、skills、note/MEMORY 同步更新；review diff 后提交，最终工作区干净。
```

## 25. 等价语义红测缺口与重复语义入口审计（2026-06-04）

本节回答当前关键问题：**移除 raw/context/metadata 回填后，现有红测是否已经证明所有请求语义都正确跨协议进入 `HubReqChatProcess03Governed` 再转出？**

结论：**没有完全证明**。当前已通过的红测主要证明“不泄漏/不回填/ProviderReqOutbound wire fail-fast”，但还不能证明 `Responses / Chat / Anthropic` 等入口字段在跨协议转换时全部等价进入 ChatProcess，再由 ReqOutbound 等价投影。继续完成目标前必须补齐本节红测与重复语义清理计划；否则只能证明 namespace/internal carrier 没泄漏，不能证明语义没有丢失。

### 25.1 当前已覆盖的红测能力

- `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`：锁住 followup 不从 `requestSemantics.tools.clientToolsRaw`、metadata/requestSemantics 恢复 `tools/tool_choice`。
- `tests/providers/core/runtime/vercel-ai-sdk-openai-transport.spec.ts`：锁住 Vercel SDK transport 不从 raw-only fields merge provider body。
- `tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts`：锁住 snapshot 落盘 `meta.requestMetadata` 不保留 raw/context/tool carriers。
- `provider_req_outbound_06_wire_payload` Rust tests：锁住 provider wire 不接受 `toolsRaw/clientToolsRaw/responsesContext/contextSnapshot/requestMetadata/__raw_request_body/rawBody` 与 `type:"namespace"` 聚合工具。
- `tests/red-tests/server_response_projection_metadata_guard.test.ts` / `tests/red-tests/server_sse_metadata_guard_e2e.test.ts`：锁住 client response/SSE 不泄漏 internal `metadata` carrier。

这些测试证明的是**边界污染被拦截**，不是完整字段等价映射。

### 25.2 当前缺失的等价语义红测

必须新增一组 matrix red tests，输入同一语义字段，分别从 `/v1/responses`、`/v1/chat/completions`、Anthropic-compatible payload 进入，断言：

1. `HubReqInbound02Standardized -> HubReqChatProcess03Governed` 后的标准语义等价。
2. `HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic` 后 provider semantic envelope 等价。
3. `ProviderReqOutbound06WirePayload` 只消费 `HubReqOutbound05ProviderSemantic`，不读取 raw/context/metadata。
4. servertool followup 复入与普通请求使用同一转换断言，不允许 followup 专用字段补偿。

字段矩阵至少覆盖：

| 字段 | 必须断言 |
|---|---|
| `model` | 入口协议差异不改变目标 provider model 语义；route override 只能在 route/provider semantic 节点体现 |
| `instructions/system/developer` | Responses input 与 Chat messages 映射到同一 system/developer 语义块 |
| `input/messages/content` | text/image/tool-result 多 content part 顺序与角色语义等价 |
| `tools` | Codex namespace 聚合工具在 ReqChatProcess 唯一治理点展开/标准化，ProviderReqOutbound 不见 namespace |
| `tool_choice` | string/object/required/auto/none 跨协议等价，不从 metadata/context 补 |
| `parallel_tool_calls` | 跨协议保留等价，不从 metadata/context 补 |
| `reasoning/thinking` | 进入标准 reasoning block，再由 outbound provider profile 编码 |
| `response_format/text.format` | 进入标准 response format 语义，不从 metadata/context 补 |
| `max_output_tokens/max_tokens/temperature/top_p/stream/store/include/truncation/service_tier` | 参数进入统一 parameters block，由 ReqOutbound 负责协议投影 |
| tool-call history / tool result | Responses function_call_output、Chat tool role、Anthropic tool_result 等价进入同一 history/tool-result 语义 |

### 25.3 发现的重复语义入口/旧路径

以下路径需要进一步下沉、删除或隔离；不能把它们当作已验证真源：

- V2 conversion pipeline codecs have been physically deleted.
  - Deleted surface: `sharedmodule/llmswitch-core/src/conversion/pipeline/**` and `sharedmodule/llmswitch-core/dist/conversion/pipeline/**`.
  - Former files such as `responses-openai-pipeline.ts`, `anthropic-openai-pipeline.ts`, `openai-openai-pipeline.ts`, and `openai-chat-helpers.ts` are not pending migration; they are forbidden duplicate request-semantics entrances.
  - Any future need for Responses/Chat/Anthropic field equivalence must be implemented in the Rust owning nodes, not by reviving V2 pipeline codecs or wrapper tests.
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
  - 仍存在 `metadata_tool_choice/context_tool_choice`、`metadata_parallel_tool_calls/context_parallel_tool_calls` 等优先级读取。
  - 风险：若这些字段被用于 live request 生成，就是 metadata/context 回填；若仅用于 legacy bridge，应迁移到 ChatProcess 标准语义或删除。
- `src/server/runtime/http-server/executor/provider-response-utils.ts`
  - `describeRequestSemanticsResolution(...)` 仍读取 `processed.metadata.requestSemantics`、`standardized.metadata.requestSemantics`、`requestMetadata.requestSemantics` 并统计 `clientToolsRaw`。
  - 风险：当前定位为 response/debug 观测；必须加红测保证它不进入 ReqOutbound/ProviderReqOutbound live path，并考虑改名为 response-only diagnostics。
- `src/server/handlers/responses-handler.ts`
  - 仍把 inbound `payload.tools` 写入 `responsesRequestContext.context.toolsRaw` 与 capture context。
  - 风险：允许作为 response-only/session context 前必须有类型隔离；禁止 ReqOutbound/provider runtime 读取。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/nodes.rs`
  - `build_req_outbound_node_result` 仍透出 `semantics/tool_choice` 等字段。
  - 风险：需要确认这是 canonical node materialization，不是重复 DTO；必须纳入拓扑红测扫描。

### 25.4 必须补的测试/审计文件

- 新增 Rust matrix tests（建议路径）：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_field_equivalence_tests.rs`。
  - 用同一语义构造 Responses/Chat/Anthropic inbound fixture。
  - 断言 ChatProcess 标准语义、ReqOutbound provider semantic、ProviderReqOutbound wire payload 三层等价。
  - 断言 raw/context/metadata 中携带冲突字段时不影响 live provider payload，且必要时 fail-fast。
- 新增 TS red test（建议路径）：`tests/red-tests/request_field_semantics_must_not_use_raw_context_metadata.test.ts`。
  - 静态扫描禁止 `ReqOutbound/ProviderReqOutbound/provider transport/followup dispatch` 读取 `__raw_request_body/rawBody/requestMetadata/contextSnapshot/responsesContext/toolsRaw/clientToolsRaw` 来生成 request fields。
  - 允许列表必须只包含 direct-only passthrough、response-only diagnostics、snapshot-only sanitizer。
- 更新 topology red test：锁定 `sharedmodule/llmswitch-core/src/conversion/pipeline/**` 与 matching dist outputs 不得复活，防止新增第二套 converter。

### 25.5 当前执行判断

在 §25 的等价语义红测补齐前，不能宣称“所有语义都正确跨协议转到 ChatProcess 再转出”。当前可宣称的证据仅限于：已知 raw/context/metadata 回填与 provider wire namespace 泄漏路径正在被删除/guard，且已有 leak/boundary targeted tests 通过。

## 26. 手动 ChatProcess 字段映射审计与收敛结果（2026-06-04）

本节记录自动验证后的人审结论：不能只看红测通过，必须手动确认 Anthropic / Responses / Chat 的同一请求语义没有多套字段入口。

### 26.1 人审范围

- Anthropic/Chat V2 pipeline codec scope has been closed by physical deletion, not migration.
  - Deleted source root: `sharedmodule/llmswitch-core/src/conversion/pipeline/**`.
  - Deleted dist root: `sharedmodule/llmswitch-core/dist/conversion/pipeline/**`.
  - Former Anthropic/Chat V2 codec findings are historical; do not use them as current implementation truth.
- Responses 双向桥：`sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts` 与 `.js`
  - 发现并修复多套字段入口：`ctx.parameters`、`ctx.metadata.parameters`、`ctx.metadata`、`ctx.toolsRaw`、`ctx.toolChoice/parallelToolCalls/responseFormat/serviceTier/truncation/include/store` 曾可影响 Responses request projection。
  - 修复后，Responses request projection 只从 Chat 源请求字段与 `chat.parameters` 生成；context/metadata 不再回填 live request 字段。
- Native envelope：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/{types.rs,history.rs}`
  - 物理删除 `context_*` / `metadata_*` request-field 输入；`PrepareResponsesRequestEnvelopeInput` 只保留 `request`、`extraSystemInstruction`、`combinedSystemInstruction`、`reasoningInstructionSegments`、`chatParameters`、`chatStream`、`chatParametersStream`、`stripHostFields`。
  - 删除 `merge_parameter_sources`、`strip_tool_control_fields`、direct override helper 等死语义；改为 `merge_chat_parameter_source` 单一来源。

### 26.2 红测锁定

新增并通过：
- `tests/red-tests/request_field_cross_protocol_equivalence_matrix.test.ts`
  - 锁 Responses -> Chat -> Responses 的 model/messages/tool history/tools/tool_choice/parallel_tool_calls/max_output_tokens/response_format/service_tier/truncation 等关键字段等价。
  - 注入 `ctx.metadata.parameters`、`ctx.metadata.tools`、`ctx.toolsRaw` 中的 namespace/raw 字段，断言不能影响 live request projection。
- `tests/red-tests/request_field_semantics_must_not_use_raw_context_metadata.test.ts`
  - 静态锁 followup request-field patch DSL 不复活。
  - 静态锁 Vercel SDK transport 不出现 raw/context/requestMetadata/toolsRaw/clientToolsRaw merge。
  - 静态锁 ProviderReqOutbound06 保持 provider-wire fail-fast boundary。

### 26.3 验证证据

- TS targeted：`npm run jest:run -- --runTestsByPath ... --runInBand`，10 suites / 82 tests passed。
- Rust targeted：
  - `prepare_responses_request_envelope --lib`：5 tests passed。
  - `servertool_followup_delta --lib`：passed。
  - `provider_req_outbound_06_wire_payload --lib`：4 tests passed。
- Build：`npm run build:min` passed，版本 bump 到 `0.90.2826`。
- Install/restart：`ROUTECODEX_INSTALL_INPLACE_BUILD=1 npm run install:global` + `routecodex restart --port 5555 --host 127.0.0.1`，`/health` 返回 `version=0.90.2826`、`ready=true`、`pipelineReady=true`。
- Live sample：最新 provider request `~/.rcc/codex-samples/openai-responses/port-5555/openai-responses-minimax.key1-MiniMax-M3-20260604T191046651-256991-634_stop_followup/provider-request.json` 中：
  - `hits=[]`；
  - `bodyKeys=["max_tokens","messages","model","parameters","stream"]`；
  - `body` 与 `meta.requestMetadata` 均未出现 `type:"namespace"`、`toolsRaw/clientToolsRaw/responsesContext/responsesRequestContext/contextSnapshot/requestMetadata/__raw_request_body/rawBody`。

### 26.4 剩余边界说明

- `responses-openai-bridge/response-payload.ts` 仍读取 `toolsRaw` 与部分 context fields；该文件属于 response outbound / client projection，不属于 request projection。本次 provider wire guard 与静态红测确保这些字段不会进入 ReqOutbound / ProviderReqOutbound live request path。
- `shared_responses_conversation_utils.rs` 仍读取 Responses stored context input，用于 conversation resume materialization；当前 provider wire guard 是最终红线。后续若做全链 Rust 下沉，应继续把该 stored context 与 request projection 类型隔离。
