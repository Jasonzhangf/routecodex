# V3 Responses / Chat SSE 树结构设计

状态：design only

范围：OpenAI Responses SSE、OpenAI Chat Completions SSE。

明确不在本设计范围：Gemini、Anthropic、WebSocket、SSE transport lifecycle 重构、retry/reroute/continuation policy。

## 1. 设计目标

1. SSE 字节 framing 与协议语义分层。
2. Responses 与 Chat 保持各自真实协议树，不共享伪 DTO。
3. 每个字段、delta、terminal、tool hook 有唯一位置。
4. JSON、SSE、direct、relay 使用同一协议树 reducer，避免多份语义实现。
5. 控制面仍只走 typed side-channel / Error chain；协议 payload 数据不进入 MetadataCenter。
6. transport EOF、`[DONE]`、连接断开不能单独重建业务 terminal truth。

## 2. 总体边界

```text
Provider bytes
  -> SseTransportIn01RawChunk
  -> SseTransportIn02DecodedFrame
  -> SseTransportIn03ValidatedFrameStream
  -> ProtocolSseEnvelope
  -> ProtocolEvent
  -> ProtocolTreeReducer
  -> HubRespInbound02Normalized
  -> HubRespChatProcess03Governed
  -> HubRespOutbound05ClientSemantic
  -> client JSON/SSE projection
```

### Owner

| 层 | 唯一 owner | 允许职责 | 禁止职责 |
|---|---|---|---|
| Transport | `v3/crates/routecodex-v3-sse` | bytes、UTF-8、field、frame、backpressure、EOF/error lifecycle | 解析 JSON、事件名、tool、terminal、retry |
| Responses codec/tree | `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree`（目标目录） | Responses envelope/event/tree/reducer | Chat shape、路由、continuation policy |
| Chat codec/tree | `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree`（目标目录） | Chat chunk/choice/delta/reducer | Responses item、路由、continuation policy |
| Hub projection | 现有 `resp_inbound` / `resp_chat_process` / `resp_outbound` owner | typed protocol tree 到 Hub semantic、客户端投影 | 回到 raw payload 猜状态 |
| Error | 现有 Error01-06 chain | transport/codec/schema failure 分类与投影 | SSE codec 自行 reroute/retry |

目标目录只是设计命名。落代码前必须更新 resource/function/mainline/verification map，并通过 module registry owner 审查。

## 3. Transport contract

保留现有 `routecodex-v3-sse` contract：

```text
V3SseTransportIn01RawChunk
  -> V3SseTransportIn02DecodedFrame
  -> V3SseTransportIn03ValidatedFrameStream
```

Transport frame 输出最小字段：

```text
TransportFrame {
  fields: [Comment | Named(name, value)],
  raw_utf8_valid,
  frame_sequence,
}
```

要求：

- 多行 `data` 在 transport 层合并为同一 frame 的 data 语义。
- 保留 event field；无 event field 时由协议 codec 使用默认事件规则。
- `[DONE]` 只能作为 Chat/特定 provider codec 输入，不由 transport 判 terminal。
- EOF 只能生成 transport lifecycle observation；不能生成成功 response。
- 非法 UTF-8、frame limit、buffer limit、未闭合 frame 显式失败。
- transport 不得访问 MetadataCenter、Hub response semantic、tool/continuation state。

## 4. Responses 树

### 4.1 节点层次

```text
ResponsesStreamRoot
├── ResponsesEnvelope
│   ├── event_name
│   ├── data_json
│   ├── sequence_number
│   └── protocol_event_kind
├── ResponsesContainer
│   ├── response_id
│   ├── status
│   ├── model
│   ├── instructions
│   ├── usage
│   ├── error
│   ├── incomplete_details
│   └── output[]
│       └── ResponsesOutputItem
│           ├── ResponsesMessageItem
│           │   └── ResponsesMessageContentPart
│           │       ├── ResponsesOutputTextPart
│           │       ├── ResponsesRefusalPart
│           │       └── ResponsesAnnotationSet
│           ├── ResponsesReasoningItem
│           │   ├── ResponsesReasoningSummaryPart
│           │   └── ResponsesReasoningTextPart
│           ├── ResponsesFunctionCallItem
│           │   └── ResponsesFunctionCallArguments
│           ├── ResponsesCustomToolCallItem
│           │   └── ResponsesCustomToolInput
│           ├── ResponsesFunctionCallOutputItem
│           ├── ResponsesWebSearchCallItem
│           ├── ResponsesFileSearchCallItem
│           ├── ResponsesCodeInterpreterCallItem
│           │   └── ResponsesCodeInterpreterCode
│           ├── ResponsesComputerCallItem
│           ├── ResponsesMcpCallItem
│           ├── ResponsesMcpListToolsItem
│           ├── ResponsesMcpApprovalRequestItem
│           ├── ResponsesToolSearchCallItem
│           └── ResponsesApplyPatchCallItem
└── ResponsesTerminal
    ├── completed
    ├── incomplete
    ├── failed
    └── cancelled
```

### 4.2 Item 类型必须独立建模

`ResponsesOutputItem` 只能作为 tagged root，不能承载所有 item 的共同业务字段。每个 item type 必须有独立 typed node、独立合法事件集合、独立 reducer state、独立 hook 输入。

共同 identity：

```text
ResponsesItemIdentity {
  response_id,
  output_index,
  item_id,
  item_type,
  status,
}
```

类型专属语义：

| Item | 语义子树 | 不能混入 |
|---|---|---|
| `message` | content part → output_text/refusal/annotations | tool arguments |
| `reasoning` | summary part/text part/signature | ordinary output text |
| `function_call` | call_id/name/arguments delta/done | message content |
| `custom_tool_call` | call_id/name/input delta/done | function arguments |
| `function_call_output` | call_id/output/status | model-generated call delta |
| `web_search_call` | search lifecycle/status/action data | message text |
| `file_search_call` | search lifecycle/results/status | message text |
| `code_interpreter_call` | execution lifecycle/code/log/output | function arguments |
| `computer_call` | action/approval/screenshot/status | ordinary tool call |
| `mcp_call` | server/name/arguments/result/status | custom tool input |
| `mcp_list_tools` | server/tool list/error | mcp call arguments |
| `mcp_approval_request` | approval id/server/arguments/status | tool execution result |
| `tool_search_call` | search arguments/result/status | web search call |
| `apply_patch_call` | operation/path/patch/status | generic function call |

若官方新增 item type，先新增独立 node/registry/test，再进入 reducer。禁止塞入 `OtherItem(Value)`、`provider_item_fields` 或通用 map 作为长期实现。

### 4.3 Event family

```text
Container events
  response.created
  response.in_progress
  response.completed
  response.incomplete
  response.failed
  response.cancelled

Item events
  response.output_item.added
  response.output_item.done

Content events
  response.content_part.added
  response.content_part.done

Text/reasoning/refusal events
  response.output_text.delta / done
  response.reasoning_text.delta / done
  response.reasoning_summary_text.delta / done
  response.reasoning_summary_part.added / done
  response.refusal.delta / done

Tool argument events
  response.function_call_arguments.delta / done
  response.custom_tool_call_input.delta / done
```

未登记 event：codec fail-fast。不得静默归类为普通 text 或 keepalive。

### 4.4 Responses state key

```text
ResponsesContainerKey = response_id
ResponsesItemKey      = response_id + output_index + item_id
ResponsesContentKey   = ResponsesItemKey + content_index
ResponsesDeltaOrder   = sequence_number
```

`item_id` 与 `output_index` 必须交叉校验。只有 `output_index` 不得作为 item identity。`content_index` 只在所属 item 内有效。

### 4.5 Responses reducer invariants

- `output_item.added` 必须先于该 item 的 content/delta 事件。
- `content_part.added` 必须先于该 content part 的 delta/done。
- delta 只能写入其 key 对应的 active node。
- `*.done` 只能 finalize 对应 node，不得创建缺失 node。
- `response.completed` 只能在所有已声明 active item/content node 合法收口后成立。
- `response.incomplete` 必须校验 `incomplete_details.reason`。
- `response.failed` 必须进入 provider semantic error / Error chain，不得产出成功 Hub response。
- `sequence_number` 非单调、重复、跨 response 污染必须显式 codec error。
- reducer 不修改历史或 continuation immutable interval。

## 5. Chat Completions 树

### 5.1 节点层次

```text
ChatStreamRoot
├── ChatChunkEnvelope
│   ├── id
│   ├── created
│   ├── model
│   ├── system_fingerprint
│   ├── object = chat.completion.chunk
│   ├── choices[]
│   └── usage
├── ChatChoice(index)
│   ├── role
│   ├── content_buffer
│   ├── refusal_buffer
│   ├── tool_calls[]
│   │   └── ChatToolCall(index)
│   │       ├── id
│   │       ├── type
│   │       ├── function.name
│   │       └── function.arguments_buffer
│   ├── logprobs
│   └── finish_reason
└── ChatTerminal
    ├── finish_reason per choice
    ├── final usage
    └── done_sentinel_observed
```

### 5.2 Chat state key

```text
ChatStreamKey  = completion_id
ChatChoiceKey  = completion_id + choice.index
ChatToolKey    = ChatChoiceKey + tool_calls.index
DeltaOrderKey  = frame_sequence
```

Chat `choices=[]` 允许出现在 final usage chunk；不得当作 malformed choice。`data: [DONE]` 只记录 `done_sentinel_observed`，真正 terminal 仍由每个 choice 的 `finish_reason` 和 reducer 合同判定。

### 5.3 Chat reducer invariants

- 同一 stream 所有 chunk 的 `id`、`model`、`created` 必须保持一致，除明确允许的 nullable fields 外不得漂移。
- choice index 可稀疏，但同一 index 的 delta 必须进入同一 `ChatChoice`。
- tool call index 可稀疏；arguments 只能追加，不能覆盖历史片段。
- `finish_reason` 出现后，该 choice 不得继续接收普通 delta。
- usage-only chunk 只能更新 usage，不得创建 choice。
- `[DONE]` 后不得再接收 data frame。
- EOF 无 `[DONE]` 不自动视为成功；由 runtime observation 和协议 terminal 合同决定结果。

## 6. Hook 合同

Hook 只做两件事：

```text
1. 类型通知：把已确认的 typed node/type 通知外部观察者。
2. 内容改写：在唯一协议 node owner 内改写允许改写的业务内容。
```

Hook 不是第二个 parser，不拥有 reducer，不拥有 routing/retry/continuation/error policy。

Hook 输入同时携带三类对象：

```text
SseHookInput {
  transport: TransportObject,
  protocol: ProtocolMetadata,
  semantic: SemanticObject,
}
```

三类对象严格分开：

| 对象 | 内容 | 来源 | 是否进入业务 payload |
|---|---|---|---|
| `TransportObject` | raw chunk/frame、event field、data text、frame sequence、UTF-8、EOF/error | SSE transport | 否 |
| `ProtocolMetadata` | protocol、event kind、response/item/content/index、sequence、stream phase、source/target protocol | protocol codec side-channel | 否；不等于协议 body 的 `metadata` 字段 |
| `SemanticObject` | typed message/reasoning/tool/choice/delta/terminal | protocol tree reducer | 仅在相邻 Hub/projection builder 明确生成时进入正常协议语义 |

这里的 `ProtocolMetadata` 不是 MetadataCenter 控制资源，也不是客户端请求/响应里的 `metadata` 字段。routing、retry、continuation、provider selection、health 等控制状态不得放入该对象；它们继续走既有 typed control carrier / Error chain。

Hook 不接收裸 `serde_json::Value`。hook 接收 `SseHookInput<TSemantic>`，并按树节点获得精确的 transport object、protocol metadata、semantic object。

### 6.1 两种 hook 形态

```text
TypeNotificationHook<T> {
  input: SseHookInput<T>,
  mode: ReadOnly,
  output: NotificationResult,
}

ContentRewriteHook<T> {
  input: SseHookInput<T>,
  mode: Rewrite,
  output: Result<T, HookError>,
}
```

类型通知 hook：外部只读通知，输出当前协议类型、节点 identity、transport object、protocol metadata。通知不得修改 node，不得重建 control state。

内容改写 hook：内部 typed owner hook，只改业务内容。允许改写 text、refusal、reasoning summary/text、function/custom tool arguments、Chat content/refusal/tool arguments。

禁止改写 `response_id`、`item_id`、`output_index`、`content_index`、`sequence_number`、Chat choice/tool index、event kind、item/part type、status、usage、error、finish_reason、routing、provider selection、retry、continuation、health、scope、debug metadata、frame boundary。

改写结果必须仍属于原 node type。禁止 `ResponsesMessageItem -> ResponsesFunctionCallItem`，禁止 `ChatChoice -> ResponsesOutputItem`。跨协议转换必须经过 Hub semantic projection。

改写失败显式进入 codec/error owner；禁止静默保留、静默删除、请求侧 cleanup 或 server/outbound 补偿。

### 6.2 Transport hooks

| Hook | 输入 | 允许动作 | 禁止动作 |
|---|---|---|---|
| `on_raw_chunk` | raw bytes | 诊断、限额、transport accounting | 解析协议 |
| `on_decoded_frame` | fields/frame | frame tracing、UTF-8/size observation | 判断 terminal/tool |
| `on_transport_pause/resume` | lifecycle | backpressure | 修改 payload |
| `on_transport_close` | EOF/error/abort | lifecycle release、Error01 source | 成功投影、retry/reroute |

### 6.3 Responses hooks

| Hook | 精确位置 |
|---|---|
| 类型通知 | `notify_responses_transport` | frame 完成，通知 `TransportObject + ProtocolMetadata` |
| 类型通知 | `notify_responses_container` | container 类型/生命周期确认后 |
| 类型通知 | `notify_responses_item` | 每个独立 typed item 类型确认后 |
| 类型通知 | `notify_responses_part` | message/reasoning content part 类型确认后 |
| 类型通知 | `notify_responses_delta` | delta 已定位到 item/part 后 |
| 类型通知 | `notify_responses_terminal` | terminal schema 校验完成后 |
| 内容改写 | `rewrite_responses_message_content` | 只改 message text/refusal/annotation 内容 |
| 内容改写 | `rewrite_responses_reasoning_content` | 只改 reasoning text/summary/signature 内容 |
| 内容改写 | `rewrite_responses_function_arguments` | 只改 function arguments buffer 内容 |
| 内容改写 | `rewrite_responses_custom_tool_input` | 只改 custom tool input buffer 内容 |
| 内容改写 | `rewrite_responses_typed_item_content` | 已登记 item-specific owner，不接 generic Value |
| 类型通知 | `notify_responses_tree_reduced` | reducer snapshot 完成后，供外部观察/投影编排 |

Hook 不得从 raw `Value` 自行寻找 `type`、`output_index`、`item_id`。hook 参数必须是对应 typed node/delta。

### 6.4 Chat hooks

| Hook | 精确位置 |
|---|---|
| 类型通知 | `notify_chat_transport` | frame 完成，通知 `TransportObject + ProtocolMetadata` |
| 类型通知 | `notify_chat_chunk` | chunk envelope schema 校验后 |
| 类型通知 | `notify_chat_choice` | choice index 定位后 |
| 类型通知 | `notify_chat_delta` | content/refusal/tool delta 定位后 |
| 类型通知 | `notify_chat_choice_finished` | finish_reason 校验后 |
| 类型通知 | `notify_chat_usage` | usage chunk/usage field 校验后 |
| 类型通知 | `notify_chat_done_sentinel` | `[DONE]` 已确认；只通知，不生成 semantic terminal |
| 内容改写 | `rewrite_chat_content` | 只改 content delta/完成内容 |
| 内容改写 | `rewrite_chat_refusal` | 只改 refusal 内容 |
| 内容改写 | `rewrite_chat_tool_arguments` | 只改 function arguments buffer |
| 类型通知 | `notify_chat_tree_reduced` | reducer snapshot 完成后，供外部观察/投影编排 |

## 7. Direct、JSON、跨协议转换

### Same-protocol direct

```text
provider frame
  -> protocol envelope/tree validation
  -> same protocol projection
```

允许做 schema validation、typed hook、字节级等价投影。不得把 Responses 事件改成 Chat chunk，也不得把 Chat `[DONE]` 推断为 Responses `response.completed`。

### JSON materialization

```text
complete protocol tree
  -> protocol final JSON
```

JSON materialization 只能读取 reducer tree。禁止从 `output_text`、`content_buffer` 等旁路 accumulator 重建完整响应。

### Cross-protocol conversion

```text
Responses tree
  -> Hub response semantic
  -> Chat tree
  -> Chat SSE frames
```

或反向：

```text
Chat tree
  -> Hub response semantic
  -> Responses tree
  -> Responses SSE frames
```

禁止：

- Responses event 直接改名为 Chat event；
- Chat delta 直接拼 Responses `Value`；
- server/SSE transport 做协议转换；
- direct 路径重入无关协议 runtime；
- 使用 MetadataCenter 保存协议 payload tree。

## 8. 先做的设计 gate

代码前必须完成：

1. 将本设计拆成 resource map resource IDs。
2. 为每个 tree node 定义唯一 owner、allowed/forbidden paths。
3. 将 frame → envelope → event → reducer → Hub 的相邻边写入 mainline call map。
4. 为 Responses/Chat 建立正反测试设计。
5. 注册 hook registry，禁止 runtime 任意字符串 hook。
6. 加入静态 gate：
   - transport crate 不出现协议 event/type 语义；
   - Responses tree 不引用 Chat node；
   - Chat tree 不引用 Responses node；
   - hook 不接收裸 `serde_json::Value` 作为语义输入；
   - terminal 不由 EOF/`[DONE]` 单独生成；
   - control carrier 不进入 protocol payload。

## 9. 必须覆盖的测试

### Responses positive

- response created → item added → content part added → text delta → text done → part done → item done → completed。
- reasoning item、多 content part、function call arguments、custom tool input。
- `response.incomplete` 合法 reason。
- JSON materialization 与 SSE reducer 结果一致。

### Responses negative

- delta 指向不存在 item/content。
- index/id 交叉冲突。
- duplicate/non-monotonic sequence number。
- item/content done 前缺 added。
- completed 前 active node 未收口。
- incomplete 缺 reason 或 reason 未登记。
- terminal 后继续 delta。

### Chat positive

- 多 choice interleave。
- tool call arguments 跨 chunk 追加。
- usage-only final chunk。
- finish_reason 后 `[DONE]`。

### Chat negative

- choice index 状态污染。
- tool call index 复用到另一 choice。
- finish_reason 后继续 delta。
- `[DONE]` 后仍有 data。
- EOF 无 `[DONE]` 不被判为成功。

## 10. 当前决策

第一实现目标不是“重写 SSE”，而是建立两个协议 reducer：

```text
ResponsesProtocolTreeReducer
ChatProtocolTreeReducer
```

transport 保持稳定。现有 runtime 逻辑逐个迁移到 reducer/hook owner。设计、map、测试合同完成并通过 architecture gate 后，才允许实现第一批 Responses typed nodes。
