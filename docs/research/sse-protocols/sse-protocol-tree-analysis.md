# 多协议 SSE 树状解析分析

Research date: 2026-08-20

## 结论

Jason 的方向正确，但不能把所有协议压成一棵“业务树”。应采用三棵相邻树：

```text
Transport tree
  raw bytes -> UTF-8 text -> SSE field -> complete frame

Protocol tree
  frame -> protocol event envelope -> container -> item -> content/part -> delta

Projection tree
  typed protocol node -> Hub response semantic -> client protocol projection
```

Transport tree 只处理 SSE 标准 framing 和生命周期。Protocol tree 解释 `event`、`data` 和 JSON schema。Projection tree 做 direct passthrough、JSON materialization、跨协议流式投影。三层之间只能通过 typed adjacent builders 连接。

## 1. 通用 SSE 传输层

SSE frame 基本字段：`event`, `data`, `id`, `retry`，以及 comment/keepalive。多行 `data` 属于同一 frame；空行提交 frame。传输层必须保留字段顺序语义、原始 data 文本、UTF-8 合法性和 frame boundary。

传输层不得判断：

- `event` 是否 terminal；
- `[DONE]` 是否代表成功；
- JSON `type` 是否为 error/tool/response.completed；
- 是否需要重试、切 provider、保存 continuation；
- provider/client payload 的业务字段。

当前仓库已有对应 owner：`v3/crates/routecodex-v3-sse/src/lib.rs`，feature `v3.sse_transport_core_independent`。它已提供 raw chunk、decoded frame、validated frame stream、encoded chunk、UTF-8/limit/lifecycle 错误。现有架构定义也明确禁止该 crate 解析协议事件。

## 2. OpenAI Responses SSE

Responses 是最适合树状解析的协议。事件本身不是平面 chunk，而是“response 容器 -> output item -> content part -> delta/done”的事件投影。

```text
ResponsesStream
├── response.created / response.in_progress
│   └── ResponseContainerSnapshot
├── response.output_item.added / .done
│   └── OutputItem
│       ├── message
│       │   └── output_text | refusal | reasoning_text | summary_text
│       ├── reasoning
│       ├── function_call
│       │   └── function_call_arguments.delta / .done
│       ├── custom_tool_call
│       │   └── custom_tool_call_input.delta / .done
│       ├── web_search_call
│       ├── file_search_call
│       ├── code_interpreter_call
│       └── computer / mcp / tool_search / apply_patch...
├── response.content_part.added / .done
│   └── ContentPart
│       ├── output_text
│       ├── refusal
│       └── reasoning_text
├── response.output_text.delta / .done
├── response.reasoning_*.delta / .done
├── response.*_call.*
└── response.completed | response.incomplete | response.failed | response.cancelled
    └── ResponseTerminal
```

关键索引不是只靠事件顺序，而是 typed key：`response_id + output_index + item_id + content_index (+ summary_index)`。`sequence_number` 负责事件顺序校验；`output_index`、`content_index` 负责树位置；`item_id` 负责跨事件关联。

当前实现证据：`responses_provider_event_codec.rs` 已按 event type 分支，并维护 `response_scaffold`、`output_items`、`output_text`。问题是这些状态仍是 `serde_json::Value` + 多个 helper 的扁平累积器，未显式表达 container/item/content/delta 层级。该文件应成为未来 Responses protocol tree 的迁移入口，但不应继续堆更多 `Value` 分支。

## 3. OpenAI Chat Completions SSE

Chat Completions 是“completion container -> choices[] -> choice delta”模型，不是 Responses 的 item tree。

```text
ChatCompletionStream
└── ChatCompletionChunk
    ├── id / created / model / system_fingerprint
    ├── choices[]
    │   └── ChoiceDelta
    │       ├── role
    │       ├── content delta
    │       ├── refusal delta
    │       ├── tool_calls[]
    │       │   └── function name / arguments delta
    │       └── finish_reason
    └── usage
        └── final usage chunk may have choices=[]
```

`data: [DONE]` 是 transport/protocol framing sentinel，不等于 `finish_reason`，不能单独作为成功语义。真正 terminal 语义来自 choice 的 `finish_reason`；usage 可能在 `[DONE]` 前的独立 chunk 出现，也可能因中断缺失。

当前 owner 分散在 `openai_chat_relay_runtime_sse.rs`、`openai_chat_codec.rs`、`provider_sse_json_codec.rs`。后续应把 `choices[index]`、tool call index、delta kind 变成 typed nodes；不能复用 Responses 的 `output_index/content_index` 命名。

## 4. Anthropic Messages SSE

Anthropic 明确提供事件名，且事件序列本身就是生命周期树：message -> content block -> delta。

```text
MessageStream
├── message_start
│   └── MessageContainer
├── content_block_start
│   └── ContentBlock(index)
│       ├── text
│       ├── thinking
│       ├── tool_use
│       ├── server_tool_use
│       └── provider-specific tool result blocks
├── ping
├── content_block_delta
│   ├── text_delta
│   ├── thinking_delta
│   ├── signature_delta
│   └── input_json_delta
├── content_block_stop
├── message_delta
│   └── stop_reason + usage
└── message_stop
```

`content_block_delta.index` 是树定位主键。`input_json_delta.partial_json` 是增量 JSON 文本，必须按 block index 累积，不能每帧强行反序列化为完整 object。`message_delta.stop_reason` 才是结束语义；`message_stop` 是协议生命周期终点。

当前实现已有 `anthropic_codec` 的 content block 类型和 Responses projection，但 SSE event sequencing 仍嵌在 relay/runtime 路径。需要单独的 Anthropic stream codec，最后才进入通用 Hub semantic。

## 5. Gemini GenerateContent SSE

Legacy GenerateContent 的 SSE 形态最接近“每帧一个完整 `GenerateContentResponse` chunk”，不是 Responses 那种显式事件树。

```text
GenerateContentStream
└── GenerateContentResponse chunk
    ├── candidates[]
    │   ├── index
    │   ├── content
    │   │   ├── role
    │   │   └── parts[]
    │   │       ├── text
    │   │       ├── functionCall
    │   │       ├── functionResponse
    │   │       ├── executableCode
    │   │       └── codeExecutionResult
    │   ├── finishReason
    │   └── safetyRatings / groundingMetadata...
    ├── usageMetadata
    └── promptFeedback
```

官方 REST 入口是 `models.streamGenerateContent`，示例通过 `?alt=sse` 返回连续 `data: {...}`。每个 data JSON 是 `GenerateContentResponse`，结束通常由 chunk 内 `finishReason` 和流 EOF 共同确定；不能套用 OpenAI `[DONE]`。Gemini 的 SSE codec 必须保留 `candidate index` 与 `parts index`。

注意：Gemini Interactions API 是另一套事件协议，使用 `stream: true` 和 `event_type`/step delta。不能把 Interactions event tree 与 Legacy GenerateContent chunk tree 混成同一 protocol enum。

## 6. 统一对象层次

建议的最小 typed boundary：

```text
SseTransportFrame
  └── ProtocolEnvelope<P>
      ├── OpenAiResponsesEnvelope
      │   └── ResponsesEvent
      │       └── ResponsesContainer / OutputItem / ContentPart / Delta
      ├── OpenAiChatEnvelope
      │   └── ChatChunk / Choice / ChoiceDelta / ToolCallDelta
      ├── AnthropicEnvelope
      │   └── MessageEvent / ContentBlock / ContentDelta
      └── GeminiEnvelope
          └── GenerateContentChunk / Candidate / Part / PartDelta
```

共享的只有 envelope/frame metadata，不共享业务节点。共享 trait 只应表达：节点路径、事件序号、原始 JSON 访问、生命周期状态；不能把四种协议字段伪装成同一 DTO。

## 7. Hook 精确挂点

| Hook 意图 | 唯一挂点 |
|---|---|
| 原始帧审计、限流、backpressure | Transport frame |
| provider SSE JSON schema 校验 | Protocol envelope / protocol codec |
| Responses item/tool/reasoning 处理 | Responses OutputItem 或 ContentPart |
| Anthropic tool input 增量拼接 | Anthropic ContentBlock(index) |
| Chat tool call arguments 增量拼接 | Chat ChoiceDelta.tool_calls[index] |
| Gemini candidate/part 合并 | Gemini Candidate(index)/Part(index) |
| terminal / continuation / reroute | Hub response semantic 或 Error chain；禁止 transport hook |
| JSON materialization | protocol tree root reducer 完成后 |
| direct same-protocol SSE | protocol tree 保真投影；不经过无关协议树 |
| cross-protocol stream conversion | source protocol tree -> adjacent Hub semantic -> target protocol tree |

## 8. 重构顺序

1. 建立 `ProtocolSseEnvelope` 与四类 protocol codec 的 map/manifest；先锁 owner 和相邻边。
2. 保持 `routecodex-v3-sse` 只做 framing；增加 frame metadata 访问，不增加协议语义。
3. 先实现 Responses typed tree：container、item、content part、delta、terminal。
4. 再实现 Chat、Anthropic、Gemini 各自 typed tree；每个协议单独 index/key/state machine。
5. 将现有 `Value` accumulator 迁移到 tree reducer；旧 helper 逐个删除，不保留双路径。
6. 以同一协议 JSON/SSE 等价性、跨协议流式投影、乱序/缺失/重复事件负测锁边界。
7. 最后接 hook registry 和 direct/relay projection；不得从 server/SSE transport 补语义。

## 9. 当前架构判断

已有基础：transport core 已独立；协议 codec 已在 Rust runtime；Responses event codec 已识别大量 event type；Anthropic 已有 content block 语义；Gemini 已有 candidates/parts schema。

缺口：

- Responses 缺显式 typed container/item/content/delta 树；当前 `Value` 累积器难以精确挂 hook。
- Chat/Anthropic/Gemini 缺统一的“protocol envelope -> typed stream state”边界。
- SSE frame 与 protocol JSON 仍通过 runtime helper 直接连接，协议树没有独立 feature owner。
- `v3.sse_protocol_codec_projection_boundary` 当前仍是 `status: design`；不能把它当作已锁定的 active 真源。
- 需要新增 resource/function/mainline/verification map 条目后，才能进入代码重构。

## Sources

- OpenAI Responses streaming: https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create
- OpenAI Chat streaming: https://developers.openai.com/api/reference/resources/chat
- Anthropic Messages streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Gemini GenerateContent API: https://ai.google.dev/api/generate-content?hl=en
- WHATWG Server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html
