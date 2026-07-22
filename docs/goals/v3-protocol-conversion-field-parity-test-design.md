# V3 protocol conversion field parity test design

## Goal

Bring V3 protocol conversion up to the V2 conversion contract for the supported Relay paths, without moving data-plane fields into MetadataCenter and without adding handler/SSE fallback logic.

## Scope

Supported V3 runtime paths in this slice:

1. Responses entry -> OpenAI Chat provider wire -> Responses client projection.
2. Anthropic Messages entry -> Responses provider wire -> Anthropic Messages client projection.
3. OpenAI Chat entry -> OpenAI Chat provider wire -> OpenAI Chat client projection.

V2 reference files are read-only comparison sources:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_openai_codec.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/openai_openai_codec.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`

## Owner boundaries

| Edge | V3 owner | Allowed action |
| --- | --- | --- |
| Responses request -> OpenAI Chat provider semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs` + `v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs` | Adjacent Req02/Req07 Chat canonical -> provider standard mapping only |
| OpenAI Chat provider response -> Responses semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` | Provider RespInbound codec / semantic projection only |
| Anthropic request -> Responses provider semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs` | Anthropic entry codec mapping only |
| Responses provider response -> Anthropic client projection | `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs` | Client protocol projection only |
| Chat request/response pass-through | `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs` and `openai_chat_relay_runtime.rs` | Preserve same-protocol payload; no cross-protocol repair |

Forbidden owners: server handler, SSE transport, provider transport, continuation store, MetadataCenter, TS runtime, V2 sharedmodule code.

## Data-plane / control-plane rule

- `metadata` and `client_metadata` in client protocol bodies are data-plane fields. They must remain normal payload fields when the target protocol can represent them.
- RouteCodex-created control fields (`metadata_center`, `routeHint`, `stoplessCenter`, `requestCapabilities`, etc.) must fail before provider/client normal payload.
- Unsupported target-protocol fields must not be silently dropped. This slice either maps them, preserves them under the target protocol when legal, or fail-fast tests them when malformed.

## Field matrix

### Responses -> OpenAI Chat request

| Responses field | OpenAI Chat provider wire | Required test |
| --- | --- | --- |
| `model` | preserved until Provider08/12 overwrites to selected wire model | request matrix |
| `instructions` | system/developer message; no top-level `instructions` in Chat wire | request matrix |
| `input[].message` text/image | `messages[]` role/content | request matrix |
| `input[].function_call/tool_call/custom_tool_call` | assistant `tool_calls[]` with stable id/name/arguments | request matrix + custom malformed negative |
| `input[].*_output/tool_result` | tool role message with `tool_call_id` and content | request matrix |
| `tools` and `additional_tools` | top-level Chat `tools`; custom tools become function-wrapper with raw `input` schema | request matrix |
| `tool_choice` | preserved | request matrix |
| `parallel_tool_calls` | preserved | request matrix |
| `user` | preserved | request matrix |
| `temperature`, `top_p` | preserved | request matrix |
| `logit_bias`, `seed` | preserved | request matrix |
| `stream` | preserved | request matrix |
| `response_format` | preserved | request matrix |
| `max_output_tokens` / `max_tokens` | preserve target-compatible token limit; do not drop the explicit client field | request matrix |
| `metadata`, `client_metadata` | preserved as data-plane fields | request matrix |
| `stop` | preserved | request matrix |
| RouteCodex control fields | rejected before wire | negative gate already existing; keep covered |

### OpenAI Chat provider response -> Responses projection

| Chat field | Responses projection | Required test |
| --- | --- | --- |
| `id` | `id` | response matrix |
| `model` | `model` | response matrix |
| `created` | `created_at` and/or `created` | response matrix |
| `choices[].message.content` string | `output_text` item + `output_text` aggregate | response matrix |
| `choices[].message.reasoning_content` / `reasoning` | `reasoning` output item with `summary` / `encrypted_content` | response matrix |
| `choices[].message.tool_calls[]` | `function_call` or `custom_tool_call` output item | response matrix |
| `finish_reason` | `finish_reason` and status terminality | response matrix |
| `usage.prompt_tokens/completion_tokens/total_tokens` | `usage.input_tokens/output_tokens/total_tokens` | response matrix |
| malformed custom-tool wrapper | explicit error, not `{}` or text fallback | negative test |

### Anthropic request -> Responses provider semantic

| Anthropic field | Responses provider semantic | Required test |
| --- | --- | --- |
| `model` | preserved until Provider12 overwrites to selected wire model | request matrix |
| `system` | `instructions` preserving string/block text | request matrix |
| `messages[].content[].text` | Responses `input` message text | request matrix |
| `messages[].content[].image` | Responses `input_image` content part | request matrix |
| `tool_use` | Responses `function_call` | request matrix |
| `tool_result` | Responses `function_call_output` | request matrix |
| `tools[].name/description/input_schema` | Responses function tool `name/description/parameters` | request matrix |
| `tool_choice` | target-compatible `tool_choice` | request matrix |
| `thinking` | `reasoning` with original `thinking` carried for lossless local projection | request matrix |
| `metadata` | preserved as data-plane `metadata` | request matrix |
| `temperature`, `top_p`, `max_tokens`, `max_output_tokens`, `stream` | preserved/mapped | request matrix |
| `stop_sequences` | `stop` | request matrix |
| `top_k` | preserved as `top_k` compatibility field until provider-specific layer rejects/handles | request matrix |
| RouteCodex control fields | rejected before wire | negative gate already existing; keep covered |

### Responses provider response -> Anthropic client projection

| Responses field | Anthropic client payload | Required test |
| --- | --- | --- |
| `id` | `msg_*` id | response matrix |
| `output[].reasoning.summary[]` | ordered `thinking` blocks | response matrix |
| `output[].output_text` and `output[].message.content[].output_text` | ordered `text` blocks | response matrix |
| `output[].function_call` | `tool_use` block with parsed JSON input | response matrix |
| `output[].custom_tool_call` | `tool_use` block preserving raw input | response matrix |
| `usage.input_tokens/output_tokens` | Anthropic `usage.input_tokens/output_tokens` | response matrix |
| `finish_reason` / `status` | `stop_reason` (`tool_use`, `end_turn`, `max_tokens`, `stop_sequence`) | response matrix |
| malformed JSON function arguments | explicit error, not empty-object fallback | negative test |

### OpenAI Chat -> OpenAI Chat same-protocol

| Field family | Required test |
| --- | --- |
| request top-level model/messages/tools/tool_choice/parallel_tool_calls/stop/penalties/logit_bias/seed/response_format/metadata | same-protocol runtime matrix preserves provider request |
| response choices/message/tool_calls/usage/logprobs/refusal/model/created | same-protocol runtime matrix preserves client response |

## Verification stack

Focused source gates:

```sh
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime \
  --test responses_relay_local_continuation_integration responses_openai_chat_field_parity -- --nocapture
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime \
  --test anthropic_relay_runtime_integration anthropic_responses_field_parity -- --nocapture
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime \
  --test openai_chat_relay_runtime_integration openai_chat_same_protocol_field_parity -- --nocapture
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime \
  openai_chat_provider_reasoning_content_projects_before_tool_call openai_chat_provider_structured_reasoning_keeps_summary_and_encrypted_without_content_leak -- --nocapture
```

Required closeout after source green: V3 fmt, protocol characterization gates, relay request/response gates, architecture review gates, global install, managed restart, and same-entry live replay.
