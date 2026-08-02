# V3 protocol conversion field parity test design

## Goal

Bring V3 protocol conversion up to the V2 conversion contract for the supported Relay paths, without moving data-plane fields into MetadataCenter and without adding handler/SSE fallback logic.

## Scope

Supported V3 runtime paths in this slice:

1. Responses entry -> OpenAI Chat provider wire -> Responses client projection.
2. Anthropic Messages entry -> Responses provider wire -> Anthropic Messages client projection.
3. OpenAI Chat entry -> OpenAI Chat provider wire -> OpenAI Chat client projection.
4. Responses entry -> Anthropic Messages provider wire -> Responses client projection.

Relay protocol-mode regression coverage must also prove that a published server
without the optional `execution` block retains Relay execution. Such a manifest
must not fail merely because the post-Chat target is being evaluated for a typed
Direct handoff; explicit `allowed_modes` still controls whether a handoff is legal.

V2 reference files are read-only comparison sources:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_openai_codec.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/openai_openai_codec.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`

Protocol field inventory sources are recorded in
`docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml#source_inventory`.
The normative request-field projection rules are defined in
`docs/design/v3-protocol-request-field-projection.md` and the executable lifecycle
shape is `docs/architecture/manifests/v3.protocol_request_field_projection.yml`.
Responses reasoning.summary, reasoning.context, and reasoning.mode are three
separate source-roundtrip payload semantics; no non-Responses target may turn
them into prompt text.
This inventory is downloaded from OpenAI OpenAPI / OpenAI SDK types / Anthropic SDK
types / Gemini discovery schema and is broader than the current supported Relay
runtime. Fields such as Responses `background` / `prompt_cache_options`, OpenAI
Chat `audio` / `modalities` / `reasoning_effort`, Anthropic `container` /
`output_config`, and Gemini `toolConfig` / `generationConfig` / candidate metadata
must be mapped to either canonical Chat Process semantics, protocol-specific Chat
Process extension blocks, edge-only transport state, or explicit unsupported/lossy
audit rows before any runtime conversion is expanded.

The human-readable truth text for the current audit is
`docs/architecture/reviews/v3-protocol-semantic-matrix-review.md#canonical-textual-truth-for-the-field-matrix-audit`.
The follow-up implementation plan for closing non-covered rows is
`docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md`.

The primary review contract is now `chat_semantic_translation_groups`, not direct
source-field equivalence. Each group must first define what the OpenAI Chat native
field or protocol-neutral Chat extension means, then group Responses / Anthropic /
Gemini fields by identical semantic meaning with explicit value/shape transforms.
This is intentionally not one-to-one: tool call id/name/arguments, tool result
call_id/output/name/error, image URL, file id/data/url, inline bytes, MIME type,
and response terminal/usage fields are separate semantics even when a source
protocol nests them under one object.

## Owner boundaries

| Edge | V3 owner | Allowed action |
| --- | --- | --- |
| Responses request -> OpenAI Chat provider semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs` + `v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs` | Adjacent Req02/Req07 Chat canonical -> provider standard mapping only |
| OpenAI Chat provider response -> Responses semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` | Provider RespInbound codec / semantic projection only |
| Anthropic request -> Responses provider semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs` | Anthropic entry codec mapping only |
| Responses request -> Anthropic provider semantic | `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs`; `provider_req_compat_06_provider_compat.rs` dispatches only | Anthropic outbound codec consumes governed Chat fields and emits Anthropic wire; no Responses object survives to this edge |
| Responses provider response -> Anthropic client projection | `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs` | Client protocol projection only |
| Chat request/response pass-through | `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs` and `openai_chat_relay_runtime.rs` | Preserve same-protocol payload; no cross-protocol repair |

Forbidden owners: server handler, SSE transport, provider transport, continuation store, MetadataCenter, TS runtime, V2 sharedmodule code.

## Data-plane / control-plane rule

- `metadata` and `client_metadata` in client protocol bodies are distinct data-plane fields. `client_metadata` first becomes the registered Chat payload extension `request.client_metadata`; it is not a raw wire shortcut and must retain its source identity through Req02.
- Public OpenAI `metadata` requires at most 16 string pairs, key length at most 64, and value length at most 512. Codex `client_metadata` remains distinct through Responses inbound, Chat canonicalization, and Responses outbound, so it never inherits public `metadata` limits. OpenAI Chat and Anthropic may project an exact non-empty `user_id`; every other key fails as `UnmappedOutboundFields` because those targets have no reversible field.
- RouteCodex-created control fields (`metadata_center`, `routeHint`, `stoplessCenter`, `requestCapabilities`, etc.) must fail before provider/client normal payload.
- Unsupported target-protocol fields must not be silently dropped or prompt-encoded. This slice either maps an exact target semantic or fails with the canonical Chat semantic path.

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
| `metadata` | `request.metadata` Chat extension, then public OpenAI metadata limits or explicit unmapped error | metadata limits negative matrix |
| `client_metadata` | `request.client_metadata` Chat extension, then Responses target `client_metadata`; public `metadata` remains separately validated | inbound and outbound long-value preservation positive + public metadata value-max negative + malformed inbound shape negative |
| `stop` | preserved | request matrix |
| RouteCodex control fields | rejected before wire | negative gate already existing; keep covered |

Manual split that gates must preserve:

| Source protocol field | Extended OpenAI Chat semantic | Rule |
| --- | --- | --- |
| Responses `function_call.call_id`, Anthropic `tool_use.id`, Gemini `functionCall.id` | `request.messages[].tool_calls[].id` | id only |
| Responses `function_call.name`, Anthropic `tool_use.name`, Gemini `functionCall.name` | `request.messages[].tool_calls[].function.name` | callable name only |
| Responses `function_call.arguments`, Anthropic `tool_use.input`, Gemini `functionCall.args` | `request.messages[].tool_calls[].function.arguments` | argument payload only |
| Responses `function_call_output.call_id`, Anthropic `tool_result.tool_use_id`, Gemini `functionResponse.id` | `request.messages[].tool_call_id` | result pairing id only |
| Responses `function_call_output.output`, Anthropic `tool_result.content`, Gemini `functionResponse.response` | `request.messages[].tool_result.output` | tool result payload only |
| Gemini `functionResponse.name` | `request.messages[].tool_result.name` | result name extension, not pairing id |
| Anthropic `tool_result.is_error` | `request.messages[].tool_result.is_error` | error-status extension, not content/id |
| Gemini `inlineData.mimeType` / `fileData.mimeType` | `request.messages[].content[].media.mime_type` | MIME annotation, never image URL |

Shape-branch contract that gates must preserve before runtime closeout:

| Shape branch group | Positive branch examples | Negative / forbidden collapse |
| --- | --- | --- |
| `content.image_url` | Responses `input_image.image_url` and Anthropic `image.source.type=url` map to `request.messages[].content[].image_url.url`. | Anthropic `image.source.type=base64`, Gemini `inlineData.*`, and Gemini `fileData.fileUri` must not map to image URL. |
| `content.inline_media_data` | Anthropic base64 image/document data and Gemini `inlineData.data` map to `request.messages[].content[].media.inline_data`. | URL sources and MIME-only fields must not map to inline data. |
| `content.media_mime_type` | Anthropic source `media_type` and Gemini `inlineData.mimeType` / `fileData.mimeType` map to `request.messages[].content[].media.mime_type`. | Payload bytes and file URI must not map to MIME. |
| `content.file_id` | Responses `input_file.file_id` maps to `request.messages[].content[].file.file_id`. | Responses file data/url/name and Gemini file URI must not collapse into provider file id. |
| `content.file_data` | Responses `input_file.file_data` and Anthropic document base64 data map to `request.messages[].content[].file.file_data`. | File id, URL, filename, and generic Gemini inline media without file-kind evidence must not collapse into file data. |
| `content.file_uri` | Responses `input_file.file_url` and Gemini `fileData.fileUri` map to `request.messages[].content[].file.file_url`. | Image URL and inline bytes must not collapse into file URI. |

Every `shape_branch_gap` row in the YAML must include
`shape_branch_cases.positive[]` and `shape_branch_cases.negative[]` with
`source_condition` / `forbidden_source`, target semantic, adjacent Rust codec
owner file, and required Rust test symbol. These case names are the source-test
TODO list for the next runtime slice; labels cannot move to `covered` until those
tests exist and pass.

### Chat canonical -> Responses provider wire

| Chat canonical field | Responses provider wire | Required test |
| --- | --- | --- |
| assistant `tool_calls[].id` | `function_call.call_id` keeps the stable `call_*` pairing key; `function_call.id` is the corresponding `fc_*` item id | `responses_openai_chat_field_parity_responses_wire_projects_fc_item_ids` |
| tool result `tool_call_id` | `function_call_output.call_id` keeps the same `call_*` pairing key; `function_call_output.id` equals the paired `function_call.id` | `responses_openai_chat_field_parity_responses_wire_projects_fc_item_ids` |
| long / lossy tool call id normalization | distinct Chat tool-call IDs must produce distinct `fc_*` item ids, even when truncated or sanitized | `responses_openai_chat_field_parity_responses_wire_generates_collision_resistant_fc_ids`; `responses_openai_chat_field_parity_responses_wire_hashes_sanitized_collisions` |
| `include` | preserved only on Responses provider wire | `responses_openai_chat_field_parity_responses_wire_preserves_include_projection` |

### Direct passthrough guard

| Direct surface | Required behavior | Required test |
| --- | --- | --- |
| `V3HubExecutionMode::Direct` | production Direct kernel must keep same-protocol Responses provider wire as the client Responses surface with selected provider model binding; it must preserve `input`/`include`/tool history and must not synthesize Chat `messages` | `responses_openai_chat_field_parity_direct_kernel_preserves_responses_input_include_and_tool_history` |
| Direct continuation | Req04 extracts `previous_response_id` before normal payload projection; Direct policy carries the typed locator and Provider12 receives it without reading or reconstructing control state from the business payload | `json_two_turn_remote_continuation_commits_loads_and_uses_exact_pin_without_router_reentry`; `sse_two_turn_remote_continuation_commits_and_finishes_on_the_same_exact_pin` |
| Control-field rejection | RouteCodex-created control fields found in client payload fail at the ReqInbound02 owning boundary before Chat Process or provider transport; recognized protocol data such as `include` remains untouched and control state is carried separately | `direct_runtime_rejects_routecodex_control_payload_before_provider_send`; `req04_preserves_responses_data_and_extracts_typed_continuation_locator` |

### Responses request -> OpenAI Chat provider wire

| Responses field | OpenAI Chat provider wire | Required test |
| --- | --- | --- |
| `reasoning.effort` | top-level `reasoning_effort`; Responses `reasoning` object must not leak to provider wire | `responses_openai_chat_field_parity_request_matrix` |
| `reasoning.summary` | valid registered policy fails as unmapped at the adjacent OpenAI Chat codec; invalid values fail as malformed before provider send | `openai_chat_wire_rejects_unmapped_reasoning_summary_policy` / `openai_chat_wire_rejects_invalid_reasoning_summary_policy` |
| `include` | rejected from OpenAI Chat provider wire; preserved on Responses wire only | `responses_openai_chat_field_parity_include_is_elided_from_chat_wire` |
| Historical malformed `function_call.arguments`, with or without matching `function_call_output` parse-failure truth | adjacent OpenAI Chat argument projector preserves the exact string value, keeps parse-failure tool output paired, sends the selected OpenAI Chat target exactly once, and records no provider failure or Error05 reselect; forbid deletion, empty-object repair, JSON-string rewrapping, provider switch, MetadataCenter reconstruction, or continuation mutation | `responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect` / `responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect` |

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
| function `parameters` schema-position `[REDACTED]` placeholder | adjacent OpenAI Chat/Responses codec fails fast before provider wire; debug redaction placeholders must not be widened into provider JSON Schema | `openai_chat_function_tool_redacted_schema_placeholders_fail_fast` / `openai_responses_function_tool_redacted_schema_placeholders_fail_fast` |
| Responses function history `id` with a non-`fc_` provider prefix | adjacent Responses outbound codec deterministically projects the item id to `fc_*` and applies the same id to the paired `function_call_output`; `call_id` remains unchanged | `responses_wire_projects_non_fc_function_item_ids_to_matching_fc_ids` |
| Responses custom-tool history `id` | adjacent Responses outbound codec preserves the opaque provider-owned custom item id for both `custom_tool_call` and its paired output; function-only `fc_*` normalization must not run | `responses_wire_preserves_custom_tool_item_ids` |

### Responses request -> Anthropic provider wire

| Responses field | Anthropic provider wire | Required test |
| --- | --- | --- |
| `reasoning.effort=low/medium/high/xhigh/max` | `output_config.effort` with identical value | positive effort intersection matrix |
| `reasoning.effort=none/minimal` | `UnmappedOutboundFields` at Anthropic outbound codec | negative effort value-domain matrix |
| `reasoning.summary` | registered Chat extension, then rejected as unmapped at Anthropic outbound; never system text or provider wire | source-roundtrip and Anthropic fail-fast tests |
| `reasoning.context/mode` | registered Chat extensions, then `UnmappedOutboundFields`; never system text | paired source-roundtrip and Anthropic rejection tests |
| `reasoning.budget_tokens` / `reasoning.thinking` | not declared by the audited OpenAI Responses `Reasoning` schema; Responses inbound rejects them rather than treating Anthropic fields as OpenAI extensions | malformed source-schema negative tests |
| exactly one non-empty `client_metadata.user_id` | registered `request.client_metadata`, then exact projection to Anthropic `metadata.user_id` | positive exact projection test |
| registered Codex `client_metadata` keys without `user_id` | `UnmappedOutboundFields` before Anthropic wire with canonical Chat paths | negative target-equivalence tests |
| `prompt_cache_key` | valid non-empty value fails as unmapped; malformed value fails validation; it never creates Anthropic cache control | paired cache validation tests |
| `store=false` / `store=true` | `false` is explicitly consumed before wire; `true` fails | paired storage semantic tests |
| `text.verbosity` | `UnmappedOutboundFields`; never maps to Anthropic reasoning effort | paired verbosity rejection tests |
| `text.format` | text default is consumed; compatible strict JSON schema maps to `output_config.format`; incompatible schema policy fails | paired output config tests |
| governed Chat semantic after Req04 | preserved through `ProviderReqCompat06ProviderCompat`; original Responses raw body is unavailable | Req02/Req04/Req07/Compat06 node snapshot assertions |
| Anthropic provider `thinking` JSON response | Responses `output[].type=reasoning` with `summary` / `encrypted_content` before Stopless | `responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning` |
| Anthropic request history `thinking/signature` and `redacted_thinking/data` | ordered Responses `reasoning.summary/encrypted_content`; malformed blocks fail before Hub semantic | `anthropic_assistant_thinking_history_normalizes_to_ordered_responses_reasoning`, `anthropic_malformed_thinking_history_fails_instead_of_disappearing` |
| Responses reasoning history `summary/content/encrypted_content` | Anthropic `thinking/signature` or `redacted_thinking/data`; no silent skip | `responses_replay_reasoning_restores_anthropic_thinking_and_redacted_blocks` |
| Responses SSE reasoning | materialized canonical response -> Resp03/Resp04 -> Anthropic events; no pre-Resp04 client projection | `structured_sse_contract_preserves_reasoning_tool_and_terminal_order`, `responses_sse_projects_anthropic_thinking_from_resp04_finalized_truth` |

OpenAI metadata projection requires at most 16 string pairs, keys no longer than 64 characters, and values no longer than 512 characters before provider wire emission.

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
| `thinking.type` | `request.reasoning_thinking_mode`; Responses outbound rejects because execution mode is not equivalent | source decomposition and negative Responses target matrix |
| `output_config.effort` | `request.reasoning_effort`, then Responses `reasoning.effort` for target-supported values | bidirectional effort matrix |
| `thinking.budget_tokens` | `request.reasoning_budget_tokens`; Responses outbound rejects because it has no numeric budget field | negative Responses target matrix |
| `thinking.display` | `request.reasoning_display_policy`; non-Anthropic outbound rejects | source-roundtrip and negative cross-protocol matrix |
| `metadata.user_id` | `request.client_metadata.user_id`, then target-schema-validated projection | request matrix |
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
| malformed JSON function arguments | exact string preservation at the adjacent codec, not JSON-string rewrapping, empty-object fallback, MetadataCenter reconstruction, or provider switch | negative/positive paired tests |

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

## Required red-first pairs for request-field projection

| Positive lock | Negative lock |
| --- | --- |
| OpenAI `medium` -> Chat effort -> Anthropic `output_config.effort=medium` | OpenAI `minimal` -> Anthropic fails; no invented `thinking` budget |
| Anthropic `output_config.effort=xhigh` -> Chat effort -> Responses `reasoning.effort=xhigh` | Unsupported target-model effort fails before transport |
| Anthropic numeric budget -> Chat budget -> valid Gemini `thinkingBudget` | Numeric budget never becomes OpenAI qualitative effort |
| Exact `client_metadata.user_id` -> Anthropic `metadata.user_id`; registered Codex ids are consumed without provider-wire projection | Unknown or malformed client metadata fails without MetadataCenter copy |
| Exact structured format -> Anthropic `output_config.format` | `store=false` is consumed as semantically equivalent; valid or malformed `prompt_cache_key`, `store=true`, and unsupported verbosity fail at the adjacent codec |
| Codex `client_metadata["x-codex-turn-metadata"]` longer than 512 survives Responses inbound, Chat canonicalization, and Responses outbound unchanged | Public `metadata` still enforces its 512-character value limit; malformed non-object `client_metadata` fails at inbound |
| Responses summary/context/mode round-trip back to Responses | Anthropic projection fails and no system marker is emitted |
| Gemini includeThoughts round-trips to Gemini | It never becomes Anthropic display or OpenAI summary |
