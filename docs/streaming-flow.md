## `/v1/messages` Streaming/Tool Flow

### HTTP Entry → `req_inbound` Stages

| Stage | Payload focus | Key fields |
|-------|---------------|------------|
| HTTP handler (`src/server/handlers/messages-handler.ts`) | Raw JSON/SSE body | `jsonPayload.stream`, `rawRequestMetadata`, `metadata.stream/inboundStream/outboundStream`, `clientHeaders` |
| `req_inbound_stage1_format_parse` | Format envelope | Mirrors request body (Anthropic/Chat/Responses → canonical format) |
| `req_inbound_stage2_semantic_map` | `ChatEnvelope` + `StandardizedRequest` | `parameters.stream`, `messages`, `tools`, `metadata.context` |
| `req_inbound_stage3_context_capture` | Adapter context | Captures protocol-specific hints, `toolCallIdStyle`, alias maps |

**Flow**

1. Client body `stream` is taken as ground truth. Handler copies it into `jsonPayload.stream` and marks `metadata.stream/inboundStream/outboundStream`.
2. Format adapter normalises body into Chat envelope (Anthropic messages → canonical chat).
3. Semantic mapper builds `ChatEnvelope`, collecting `tools`, `tool_outputs`, `tool_choice`, `parameters.stream`.
4. `ChatEnvelope → StandardizedRequest` copies `parameters.stream`, `messages`, `tools`, metadata.

### Request Process (`req_process_stage1_tool_governance`)

* Input: `StandardizedRequest` with `parameters.stream` from client.
* Tool filters (`runChatRequestToolFilters`) govern tool list/tool choice without touching `stream`.
* `ProcessedRequest.processingMetadata.toolCalls` records governed tool call plan.

### Request Outbound (`req_outbound_stage*`)

| Stage | Effect |
|-------|--------|
| `req_outbound_stage1_semantic_map` | Reconstruct ChatEnvelope for provider protocol (`AdapterContext.providerProtocol`). |
| `req_outbound_stage2_format_build` | Produce provider payload, map `tools` & `tool_choice`. Apply provider `supportsStreaming` override. |

**Streaming rule**

```
if provider.profile.supportsStreaming === true  => payload.stream = true
if provider.profile.supportsStreaming === false => payload.stream = false
else                                           => payload.stream = StandardizedRequest.parameters.stream
```

### Provider Layer

* Request uses final `payload.stream`.
* Response can be SSE or JSON. Driver normalises it to JSON before handing to Hub.

### Response Inbound

| Stage | Effect |
|-------|--------|
| `resp_inbound_stage1_sse_decode` | Decode SSE if provider returned stream. |
| `resp_inbound_stage2_format_parse` | Map provider payload to format envelope. |
| `resp_inbound_stage3_semantic_map` | Build Chat response (tool_calls, tool outputs, finish reason). |

### Response Process

| Stage | Effect |
|-------|--------|
| `resp_process_stage1_tool_governance` | Validates provider tool calls (IDs, schema, arguments). |
| `resp_process_stage2_finalize` | Builds final Chat response JSON (`choices`, `usage`, `finish_reason`). |

### Response Outbound

| Stage | Effect |
|-------|--------|
| `resp_outbound_stage1_client_remap` | Convert final Chat response into client protocol (`Anthropic Messages`, `OpenAI Chat`, `Responses`). |
| `resp_outbound_stage2_sse_stream` | Emits SSE iff `metadata.stream === true` (entrance value). Otherwise returns JSON. |

**Important**: Outbound streaming decision ignores provider response type; it only checks client entrance metadata.

---

## Stage Reference (request → response)

| Pipeline section | Stages |
|------------------|--------|
| Request inbound  | `req_inbound_stage1_format_parse`, `req_inbound_stage2_semantic_map`, `req_inbound_stage3_context_capture` |
| Request process  | `req_process_stage1_tool_governance`, `req_process_stage2_route_select` |
| Request outbound | `req_outbound_stage1_semantic_map`, `req_outbound_stage2_format_build` |
| Response inbound | `resp_inbound_stage1_sse_decode`, `resp_inbound_stage2_format_parse`, `resp_inbound_stage3_semantic_map` |
| Response process | `resp_process_stage1_tool_governance`, `resp_process_stage2_finalize` |
| Response outbound| `resp_outbound_stage1_client_remap`, `resp_outbound_stage2_sse_stream` |

SSE/JSON selection happens at `resp_outbound_stage2_sse_stream` based solely on `metadata.stream`.

### HTTP Response

`sendPipelineResponse` uses `options.forceSSE = metadata.stream`. SSE events follow client protocol (Anthropic `message_start/content_block_delta`, OpenAI `chat.completion.chunk`, etc.). JSON includes canonical `choices/tool_calls/tool_outputs/finish_reason`.

---

## Field / Stage State Summary

| Field | HTTP handler | req_inbound | req_process | req_outbound | provider resp | resp_inbound | resp_process | resp_outbound |
|-------|--------------|-------------|-------------|--------------|---------------|--------------|--------------|---------------|
| `stream` | Set from client body | Copied to `parameters.stream` | Unchanged | Override only if provider config forces | n/a | Remains in metadata | Drives `wantsStream` | Controls SSE vs JSON |
| `tools` | Raw array | Normalised Chat tools | Tool governance (policy) | Mapped to provider schema | Provider call result | Normalised Chat tool calls | Validated/strictified | Mapped back to client schema |
| `tool_choice` | Raw | Stored in parameters | Governed | Provider schema | — | — | Included in final Chat response | Client schema |
| `tool outputs` | Raw (Responses) | Stored as `toolOutputs` | — | Provider payload (if needed) | Provider result frames | Normalised to Chat tool role msg | Packaged | Client schema (Messages, Responses) |
| `finish_reason` | — | — | — | Provider dependent | Provided by provider | Normalised to Chat finish reason | Finalised | Returned in client schema |

---

## Protocol-specific Conversion Details

### OpenAI Chat (`/v1/chat/completions`)

**Inbound**
1. `req_inbound_stage1_format_parse` accepts OpenAI Chat JSON.
2. `req_inbound_stage2_semantic_map` flattens `choices[].messages` into ChatEnvelope, collects `tool_calls`, `tool_choice`.
3. `req_inbound_stage3_context_capture` stores `toolCallIdStyle` hints.

**Outbound**
1. `req_outbound_stage1_semantic_map` reconstructs OpenAI Chat payload with governed `tools`.
2. `req_outbound_stage2_format_build` serialises `function` schema, `tool_choice`, `stream`.
3. `resp_outbound_stage1_client_remap` writes `choices[].delta`, `finish_reason`, `tool_calls`.
4. `resp_outbound_stage2_sse_stream` emits `chat.completion.chunk` events when `stream === true`.

### Anthropic Messages (`/v1/messages`)

**Inbound**
1. `req_inbound_stage1_format_parse` parses Anthropic `messages[]/content_block` structure.
2. `req_inbound_stage2_semantic_map` converts to ChatEnvelope, capturing `anthropicMirror`, alias map, metadata.
3. `req_inbound_stage3_context_capture` stores Anthropics-specific aliasing + tool ID style.

**Outbound**
1. `req_outbound_stage1_semantic_map` builds Anthropics message list (system blocks, tool_use, tool_result).
2. `req_outbound_stage2_format_build` sets `tools`, `tool_choice`, `stream` (respecting provider override).
3. Provider response SSE → `resp_inbound_stage1_sse_decode`.
4. `resp_outbound_stage1_client_remap` emits `message_start`, `content_block_start/delta`, tool_use/tool_result, `message_delta.stop_reason`.
5. `resp_outbound_stage2_sse_stream` uses entrance `stream` to send SSE; otherwise JSON matches Anthropic schema.

### OpenAI Responses (`/v1/responses`)

**Inbound**
1. Handler routes `/v1/responses` to `responses-format-adapter`.
2. `req_inbound_stage2_semantic_map` maps `input[]` into ChatEnvelope (`messages/tools`), `tool_outputs`.
3. `req_inbound_stage3_context_capture` records responses context for bridging (multi-modal).

**Outbound**
1. `req_outbound_stage1_semantic_map` converts ChatEnvelope to Responses `input[]`.
2. `req_outbound_stage2_format_build` writes `metadata`, `modalities`, `instructions`, `stream`.
3. Provider SSE or JSON feeds `resp_inbound_*`; tool outputs appear as `response.output[]`.
4. `resp_outbound_stage1_client_remap` rebuilds Responses `output[]` array (tool calls, tool results, reasoning, finish status).
5. `resp_outbound_stage2_sse_stream` emits Responses SSE events when entrance `stream === true`.

---

---

## Streaming / Tool Pipeline Flow

```
Client (/v1/messages)
  → HTTP handler
      stream := body.stream
      metadata.stream/inbound/outbound := stream
  → req_inbound_stage1 (format parse)
  → req_inbound_stage2 (semantic map)
      ChatEnvelope.parameters.stream := stream
  → StandardizedRequest.parameters.stream := stream
  → req_process_stage1_tool_governance
      tools/tool_choice governed (stream untouched)
  → req_outbound_stage1/2
      apply provider supportsStreaming override
      payload.stream := override or stream
  → Provider
      sends SSE/JSON accordingly
      returns SSE/JSON (tool_calls, finish_reason)
  → resp_inbound stages
      decode SSE, build Chat response
  → resp_process
      tool governance, final Chat response
  → resp_outbound_stage1
      map Chat response -> client protocol
  → resp_outbound_stage2
      if entrance stream === true -> emit client SSE
      else -> emit JSON
  → HTTP response
```

---

See `streaming-flow.html` for a Mermaid diagram illustrating the above.
