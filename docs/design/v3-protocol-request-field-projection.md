# V3 request field projection contract

Status: runtime active; live verified on V3 `0.90.4017` at 5520
Owner feature: `v3.protocol_conversion_field_parity`
Machine manifest: `docs/architecture/manifests/v3.protocol_request_field_projection.yml`
Feature module boundaries:
`docs/architecture/manifests/v3.protocol_request_field_projection.modules.yml`

## Purpose

Every supported inbound protocol is decoded by its adjacent codec into Chat
canonical semantics plus registered Chat payload extensions. Chat Process may
govern those typed payload semantics, but it may not recover them from raw input
or MetadataCenter. The adjacent outbound codec consumes Chat semantics and either
projects an exact target-protocol field or returns `UnmappedOutboundFields`.

```text
source wire
  -> adjacent inbound codec
  -> Chat canonical + registered payload extensions
  -> Chat Process
  -> adjacent outbound codec
  -> target wire or explicit UnmappedOutboundFields
```

MetadataCenter is not a payload extension registry. It carries only RouteCodex
control semantics such as routing, switching, retry, continuation ownership,
health, stopless/servertool scope, and error state. Neither side may mirror or
reconstruct the other.

This document defines the field-projection contract for the request fields named
below. The complete protocol inventory remains
`docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`; this document
does not claim that every row in that inventory is already implemented. A field
is runtime-active only after its positive and negative gates, global install,
managed restart, and live replay have passed.

## Canonical storage contract

`request.*` in this document is a semantic path, not a wire object to serialize.
Its physical Chat representation is fixed as follows:

| Semantic path | Governed Chat storage | Storage class |
| --- | --- | --- |
| `request.metadata` | `routecodex_chat_extension.responses_request.metadata` | registered payload extension |
| `request.client_metadata` | `routecodex_chat_extension.responses_request.client_metadata` | registered payload extension |
| `request.prompt_cache_key` | `routecodex_chat_extension.responses_request.prompt_cache_key` | registered payload extension |
| `request.store` | `routecodex_chat_extension.responses_request.store` | registered payload extension |
| `request.text.output_config` | `routecodex_chat_extension.responses_request.text` | registered payload extension |
| `request.anthropic_system_blocks` | `routecodex_chat_extension.anthropic_request.system` | registered payload extension |
| `request.reasoning_effort` | `reasoning_effort` | Chat request field |
| `request.reasoning_budget_tokens` | `reasoning_budget_tokens` | registered Chat request field |
| `request.reasoning_summary_policy` | `reasoning_summary_policy` | registered Chat request field |
| `request.reasoning_context_policy` | `reasoning_context_policy` | registered Chat request field |
| `request.reasoning_mode` | `reasoning_mode` | registered Chat request field |
| `request.reasoning_include_thoughts` | `reasoning_include_thoughts` | registered Chat request field |
| `request.reasoning_display_policy` | `reasoning_display_policy` | registered Chat request field |
| `request.reasoning_thinking_mode` | `reasoning_thinking_mode` | registered Chat request field |

The extension object may contain only registered fields, never a source request
body, `rawBody`, provider options, headers, RouteCodex metadata, or an open-ended
protocol snapshot. Inbound decoding consumes the source field. Outbound encoding
consumes the Chat field. A codec must reject conflicting duplicate
representations instead of selecting one.

## Projection classes

| Class | Rule |
| --- | --- |
| `mapped_exact` | Source and target fields have the same meaning and the concrete value belongs to both target value domains. Field rename and model/value-domain validation remain exact mappings. |
| `mapped_compatible_registered` | The target lacks a 1:1 field but can carry the source behavior through a named, bounded, reversible compatibility shape. The wrapper, known semantic delta, reverse projection, and positive/negative tests must all be registered. |
| `source_roundtrip_only` | Preserve in a registered Chat extension so the source protocol can be reconstructed; other targets continue to seek a registered compatibility projection before being classified unsupported. |
| `unsupported` | Neither an exact mapping nor a registered compatible mapping can preserve the required behavior. Return `UnmappedOutboundFields` with the Chat semantic path. |

There is no `approximate` generic projection. An unregistered approximation,
prompt-marker,
silent-strip, fallback, or MetadataCenter reconstruction class. A
`mapped_compatible_registered` mapping is allowed only when its wrapper,
semantic delta, value subset, and reverse projection are recorded in the field
matrix and locked by positive and negative tests. Anything outside that
registered subset is `unsupported` and fails at the adjacent outbound codec.

## Canonical request semantics

| Chat semantic path | Type and domain | Meaning |
| --- | --- | --- |
| `request.metadata` | object constrained by the public target metadata schema | Public API metadata; distinct from Codex client metadata and never RouteCodex control state. |
| `request.client_metadata` | object preserving source entries | Codex client-owned request metadata; long `x-codex-turn-metadata` values remain data-plane payload and do not inherit public metadata's 512-character value limit. |
| `request.prompt_cache_key` | string | Client-owned prompt-cache key; not RouteCodex cache or routing state. |
| `request.store` | boolean | Upstream request storage preference; not continuation ownership or local persistence policy. |
| `request.text.output_config` | typed object | Output format and verbosity request semantics; not response content. |
| `request.anthropic_system_blocks` | typed Anthropic system block array/object | Source-protocol system block structure, including block-local cache control; plain string system text uses canonical Chat instructions instead. |
| `request.reasoning_effort` | enum/string validated at target | Qualitative reasoning effort. It is not a token budget. |
| `request.reasoning_budget_tokens` | integer | Numeric reasoning-token budget. It is not output-token capacity or qualitative effort. |
| `request.reasoning_summary_policy` | `auto \| concise \| detailed` for Responses source | Requested reasoning-summary policy. It is not returned reasoning content or display visibility. |
| `request.reasoning_context_policy` | `auto \| current_turn \| all_turns` for Responses source | Which reasoning items are rendered back to the model on later turns. |
| `request.reasoning_mode` | `standard \| pro \| source-defined string` | Reasoning execution mode. It is separate from context policy. |
| `request.reasoning_include_thoughts` | boolean | Whether a protocol should include thought material when available. |
| `request.reasoning_display_policy` | `summarized \| omitted` for Anthropic source | How Anthropic thinking content is exposed while retaining its continuity contract. |
| `request.reasoning_thinking_mode` | `enabled \| adaptive \| disabled` for Anthropic source | Anthropic thinking activation strategy; not qualitative effort or OpenAI execution mode. |

All listed fields are normal request payload semantics. They must be represented
as Chat native fields or registered Chat extensions and must survive Chat Process
unchanged unless a named Chat Process policy owns an explicit transformation.

### Ordered continuation suffix projection

Responses history is immutable. Req inbound performs only the static, adjacent
protocol projection required for the current request and never scans or rewrites
previous turns. At Resp04, the canonical request prefix is recorded unchanged;
the newly appended finalized response output is projected as a separate suffix.
Only that suffix may coalesce contiguous assistant text/reasoning with its
following tool call. Tool results remain paired and immediately follow the call.
No historical message, tool declaration, call id, or result may be sorted,
reconstructed, or modified by a later round.

## Field decision matrix

`same` means the source and target use the same concrete wire field. `rename`
means exact semantic projection with a different wire name. `conditional` means
the target value/model domain must be checked. `roundtrip` means only the source
protocol can reconstruct it. `unmapped` always returns the canonical Chat path.

| Chat semantic | Responses | OpenAI Chat | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| `metadata` | same, OpenAI limits | same, OpenAI limits | conditional only for exactly one non-empty `user_id` | unmapped |
| `client_metadata` | same source extension; never public `metadata` | optional non-empty `user_id` projection; registered Codex local keys are consumed before wire; unknown keys fail | optional non-empty `user_id` projection; registered Codex local keys are consumed before wire; unknown keys fail | unmapped |
| `prompt_cache_key` | same | same | valid non-empty key is consumed as local cache hint; malformed fails; never becomes `cache_control` | unmapped |
| `store` | same | same | `false` consumed before wire; `true` fails | unmapped |
| `text.output_config` | rename to `text` | field-wise conditional projection to `verbosity` / `response_format` | conditional projection only where the semantic matrix declares an exact target field | conditional projection only where the semantic matrix declares an exact target field |
| `reasoning_effort` | rename to `reasoning.effort` | same | conditional rename to `output_config.effort` | conditional enum-case projection to `thinkingLevel` |
| `reasoning_budget_tokens` | unmapped | unmapped | conditional rename to `thinking.budget_tokens` | conditional rename to `thinkingBudget` |
| `reasoning_summary_policy` | rename to `reasoning.summary` | unmapped | registered static compatibility: `auto`/`concise`/`detailed` all preserve Anthropic native thinking and project its complete text to Responses reasoning summary; no truncation or silent loss | unmapped |
| `reasoning_context_policy` | rename to `reasoning.context` | unmapped | unmapped | unmapped |
| `reasoning_mode` | rename to `reasoning.mode` | unmapped | unmapped | unmapped |
| `reasoning_include_thoughts` | unmapped | unmapped | unmapped | rename to `includeThoughts` |
| `reasoning_display_policy` | unmapped | unmapped | rename to `thinking.display` | unmapped |
| `reasoning_thinking_mode` | unmapped | unmapped | rename to `thinking.type` | unmapped |

No row authorizes one field to be reconstructed from another row. In particular,
`store` cannot create continuation state, metadata keys cannot create session
scope, and qualitative effort cannot create a numeric budget.

## Responses inbound -> Chat Process field audit

This is the field-by-field contract for the Responses entry. `Inbound` means
only source-protocol decoding and non-destructive normalization. `Chat Process`
means semantic validation, duplicate/conflict checks, tool/history governance,
and continuation-owner checks. It must not decide a provider wire shape. The
three outbound columns are independent target codecs; an entry in one column
does not authorize reuse of the source object or of another target's mapping.

| Responses source field | Chat canonical / extension | Chat Process audit | Responses target | OpenAI Chat target | Anthropic target |
| --- | --- | --- | --- | --- | --- |
| `model` | `request.model` | non-empty client model alias; bind selected wire model later | exact model binding | exact selected `model` | exact selected `model` |
| `instructions` | Chat developer/system instruction semantic | preserve string exactly; reject conflicting duplicate instruction source | exact `instructions` | project to ordered developer/system message | project to ordered `system` text only |
| `input` message text | Chat message role/content text | preserve item order, role, content-part order, ids/status/phase as registered extensions | exact `input` message items | project to `messages[]` text parts | project to `messages[]` text blocks |
| `input[].input_text` | Chat text content part | require string `text`; preserve annotations/position | exact input text part | Chat text content part | Anthropic text block |
| `input[].input_image.image_url` | Chat image URL content part | URL branch only; do not collapse file id/inline bytes into URL | exact image URL | image URL part with detail | Anthropic image URL source |
| `input[].input_image.file_id` | Chat file/image id extension | retain id identity; target must advertise file-id support | exact file-id input | target capability or explicit unmapped | unmapped unless an exact Anthropic source exists |
| `input[].input_file.file_id` | Chat file id extension | retain id distinct from URL/data | exact file id | target file-id capability or unmapped | unmapped |
| `input[].input_file.file_url` | Chat file URL extension | URL branch only; preserve filename separately | exact file URL | target file URL capability or unmapped | document URL only if target schema is exact, otherwise unmapped |
| `input[].input_file.file_data` | Chat inline file bytes extension | preserve bytes and MIME separately; never infer URL/id | exact file data | target inline-file capability or unmapped | document base64 source when MIME/branch is exact |
| `input[].input_file.filename` | Chat filename annotation | preserve independently from bytes/id/url | exact filename | file part filename if supported | document title/name only if exact; otherwise unmapped |
| `input[].input_audio` | Chat audio content extension | preserve data/format; no text fallback | exact audio input | Chat audio input if target capability | unmapped |
| `input[].message.id/status/phase` | registered message lifecycle extension | validate enum/identity; never use for routing or terminal control | exact Responses item fields | source-roundtrip extension or explicit unmapped; never silently drop | source-roundtrip extension or explicit unmapped |
| `input[].function_call` | Chat function tool-call semantic (`id`, name, exact argument string) | pair by call id; preserve malformed argument bytes; no `{}` repair | exact function call item | native function tool call | `tool_use` with JSON input only when parseable; malformed exact raw preservation path required |
| `input[].function_call_output` | Chat tool-result semantic (`tool_call_id`, output, status) | require matching call or explicit unpaired policy; preserve output string and status | exact function output item | tool-role result with `tool_call_id` | `tool_result` with `tool_use_id`; status only if target has exact error slot |
| `input[].custom_tool_call` | Chat native custom tool call (`id`, name, raw input) | preserve raw input as string and bind it to the governed custom-tool declaration | exact custom call item | native `type=custom` call | `mapped_compatible_registered`: declared custom call becomes `tool_use`; raw input becomes the exact wrapper `{"input": raw}` |
| `input[].item_reference` | typed Responses item-reference extension | validate same Responses scope; never dereference by session alone | exact reference | unmapped | unmapped |
| `input[].reasoning.summary/content/encrypted_content` | Chat reasoning semantic plus encrypted side-channel carrier | preserve order and identity; encrypted content never enters normal message payload | exact reasoning item | target capability/field-specific reasoning projection or unmapped | thinking blocks only for exact Anthropic shape; no summary-policy reconstruction |
| `background` | Responses execution extension | validate boolean; no provider selection meaning | exact Responses only | unmapped | unmapped |
| `conversation` | typed Responses conversation scope | validate entry/owner/port/group scope; never use session-only lookup | exact Responses only | unmapped | unmapped |
| `previous_response_id` | typed direct continuation locator plus source extension | restore only at ReqChatProcess continuation owner; reject ordinary Chat/Anthropic entry reuse | exact Responses continuation | unmapped in relay; Direct only | unmapped |
| `include` | Responses include extension | validate each enum; no output reconstruction in outbound immutable interval | exact Responses only | unmapped | unmapped |
| `metadata` | public metadata payload extension | validate 16 pairs, key <=64, value <=512; distinct from `client_metadata` | exact metadata | exact `metadata` | only exact `user_id` may project to Anthropic metadata; other keys remain response context or fail per matrix |
| `client_metadata` | registered client metadata payload extension | preserve every key/value; no MetadataCenter/session reconstruction | exact `client_metadata` | exact `user_id` mapping; registered Codex local keys are consumed before wire; unknown keys fail | exact `user_id` mapping; registered Codex local keys are consumed before wire; unknown keys fail |
| `max_output_tokens` | Chat output token-limit semantic | preserve numeric value; validate positive/domain conflicts | exact | `max_completion_tokens` conditional rename | `max_tokens` conditional rename |
| `prompt` | Responses reusable-prompt extension | validate object/variables; never inline into instructions silently | exact Responses only | unmapped | unmapped |
| `prompt_cache_key` | client cache-key payload extension | preserve exact string; not routing/control state | exact | exact | valid local cache hint is consumed before wire; malformed fails; never rebuild `cache_control` |
| `prompt_cache_options.*` / `prompt_cache_retention` | cache-options extension | preserve independently from `prompt_cache_key`; no provider-health/cache mutation | exact Responses only | target-specific exact field or unmapped | unmapped |
| `reasoning.effort` | `request.reasoning_effort` | validate non-empty string; preserve until concrete target selection; keep separate from budget/summary/mode | registered OpenAI-domain compatibility (`max -> xhigh`, unknown -> `medium`) | registered provider-domain compatibility; DeepSeek lower/unknown -> `high`, `xhigh/max -> max` | registered Anthropic-domain compatibility (`none/minimal -> low`, unknown -> `medium`); MiniMax Anthropic uses `thinking.type=adaptive` and no `output_config.effort` |
| `reasoning.summary` / `generate_summary` | `request.reasoning_summary_policy` | aliases must agree; policy is not response reasoning text | exact Responses | registered static compatibility: `auto/concise/detailed -> medium/low/high`, merged with explicit effort by the higher level | registered many-to-one static compatibility preserves complete Anthropic native thinking as Responses reasoning summary for all valid policy values |
| `reasoning.context` | `request.reasoning_context_policy` | validate scope/value; no history reconstruction outside Chat Process | exact Responses | unmapped | unmapped |
| `reasoning.mode` | `request.reasoning_mode` | preserve mode independently from effort/context | exact Responses | unmapped | unmapped |
| `safety_identifier` | safety identifier payload extension | validate string; never map to `user` or metadata | exact | exact `safety_identifier` if target schema supports | unmapped |
| `service_tier` | service-tier request semantic | validate enum; no routing fallback | exact | conditional exact same enum | target-specific exact field only; otherwise unmapped |
| `store` | storage preference payload extension | validate boolean; never create local continuation truth | exact | exact | `false` compatible no-storage consume; `true` unmapped |
| `stream` | transport intent | bind response transport before provider wire; no semantic change | exact | exact | exact |
| `stream_options.include_obfuscation` | stream transport extension | validate only with stream; never expose as business content | exact Responses only | unmapped unless target has exact option | unmapped |
| `temperature` / `top_p` | sampling semantics | preserve values and conflict rules | exact | exact | exact where target domain supports |
| `text.format` | typed output-format semantic | validate schema/type/strictness; no prompt conversion | exact | `response_format` fieldwise exact/conditional | `output_config.format` exact subset only |
| `text.verbosity` | output verbosity semantic | validate low/medium/high; never merge with reasoning effort | exact | exact `verbosity` | valid local style hint is consumed before wire; invalid fails |
| `tool_choice` | tool-choice policy semantic | preserve required/allowed/name/type distinctions | exact | exact native shape where supported | exact function/tool subset; named custom choice uses the registered custom-tool declaration and projects as Anthropic `{"type":"tool","name":exact_source_name}` |
| `tools` / `additional_tools` | governed tool declaration set | preserve declaration order, type, format, schema, execution, and capability requirements | exact | native function/custom/web-search/tool-search mapping per tool row | native Anthropic tools use exact mapping; custom free-form/grammar uses registered string-input wrapper; remaining families continue compatibility review before unsupported classification |
| `top_logprobs` | log-probability request semantic | preserve numeric value; not reasoning or usage | exact | exact `top_logprobs` | unmapped |
| `truncation` | Responses context policy extension | preserve `auto`/`disabled`; no silent history deletion in Chat Process | exact Responses only | unmapped | unmapped |
| `user` | upstream user identifier payload | preserve separately from `client_metadata.user_id` and `safety_identifier` | exact | exact `user` | unmapped; never relabel as metadata user_id |

The matrix is closed-world: a source field absent from this table is not
implicitly pass-through. It must be added with the same six-column treatment,
including a named owner and positive/negative tests, before implementation.

## Provider response -> Chat -> client audit

Responses is also a target protocol, so response projection is reviewed in both
directions. The provider response is first parsed into Chat response semantics;
only then does the selected client codec emit Responses, OpenAI Chat, or
Anthropic. No provider response object is reused as a client response object.

| Provider response field family | Chat response semantic | Responses client | OpenAI Chat client | Anthropic client |
| --- | --- | --- | --- | --- |
| identity: `id`, `model`, `created`/`created_at` | response identity/time/model | exact fieldwise mapping; created units validated | exact `id/model/created` | exact `id/model` with generated message id only where Anthropic requires it |
| terminal: `status`, `finish_reason`, `stop_reason`, `stop_sequence` | terminal reason + terminality | `status` plus `incomplete_details`/finish projection | `choices[].finish_reason` | `stop_reason`/`stop_sequence` |
| text message content and annotations | ordered output text parts + annotations | ordered `message.content[].output_text` and aggregate `output_text` | `choices[].message.content` and annotations | ordered `content[].text` blocks |
| refusal/error content | refusal semantic or Error chain | `refusal`/`error` only at client projection owner | `message.refusal` or protocol error | provider error schema or text refusal per declared field |
| function call: id/call_id/name/arguments/status | function call semantic with exact argument bytes | `output[].function_call` | native function `tool_calls[].function` | `tool_use` only when arguments are valid JSON; malformed bytes follow explicit reversible error path |
| custom call: id/name/raw input | native custom-call semantic plus governed custom declaration identity | `output[].custom_tool_call` exact raw input | native custom `tool_calls[].custom` exact raw input | registered `tool_use` compatibility wrapper; reverse only when the governed declaration marks the tool custom and `input` is exactly an object containing the expected string field |
| tool result: call id/output/status | paired tool-result semantic | `function_call_output` exact pairing | `tool` role message with exact `tool_call_id` | `tool_result` with exact `tool_use_id` and `is_error` only when declared |
| reasoning visible summary/content | ordered reasoning summary semantic | `output[].reasoning.summary[]` | target reasoning field only if native response schema supports it; otherwise explicit unmapped | `thinking` blocks with display/signature validation |
| reasoning encrypted content/signature | encrypted reasoning side-channel resource | `reasoning.encrypted_content` only under include/continuation contract | never copied into normal Chat text | never copied into normal Anthropic text |
| usage: input/output/total/reasoning/cache/service tier | usage semantic with units and subfields | exact fieldwise usage mapping | exact fieldwise usage mapping | exact declared usage subset; unsupported subfields fail or remain provider-only |
| provider tool annotations/citations/search results | typed tool/citation semantic | target-specific output item/annotation mapping | target-native annotation/tool result only | target-native citation/tool result only |
| unknown provider field | no Chat semantic | reject or provider-only debug resource; never client payload | reject or provider-only debug resource | reject or provider-only debug resource |

Every row requires a positive and reverse negative test. In particular,
`function_call.arguments` and custom raw input are byte-preserving payload; a
JSON parse failure is not permission to fabricate `{}`, stringify twice, drop a
paired result, or switch protocols. `reasoning.summary` response content is not
reused to reconstruct a request `reasoning.summary` policy.

## Exact protocol projections

### Qualitative effort

| Protocol | Wire field | Values verified on 2026-08-01 |
| --- | --- | --- |
| OpenAI Responses | `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model support varies. |
| OpenAI Chat | `reasoning_effort` | Same OpenAI semantic; model support varies. |
| Anthropic Messages | `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max`; model support varies. |
| Gemini GenerateContent | `generationConfig.thinkingConfig.thinkingLevel` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`; supported levels vary by model. |

OpenAI effort values are forward-compatible protocol data. Req02 validates that
`reasoning.effort` is a non-empty string but does not close the domain to the values
known on the verification date. The source value remains unchanged through Chat
canonical storage until concrete target selection. ProviderReqCompat06 is the unique
owner of the registered target-domain compatibility projection: standard OpenAI maps
`max -> xhigh` and unknown values to `medium`; DeepSeek maps active lower/unknown
values to `high` and `xhigh/max` to `max`; standard Anthropic maps `none/minimal` to
`low` and unknown values to `medium`; MiniMax Anthropic removes unsupported
`output_config.effort` and requests `thinking.type=adaptive`. This projection never
creates a numeric thinking budget and never writes a projection decision to control
metadata or client payload.

Exact intersections remain unchanged:

- OpenAI to Anthropic: `low`, `medium`, `high`, `xhigh`, `max`; other non-empty
  values use the registered nearest qualitative projection above.
- OpenAI to Gemini: `minimal`, `low`, `medium`, `high`, after model-level
  capability validation.
- Anthropic to OpenAI: all declared Anthropic effort values, after target-model
  validation.
- Gemini to OpenAI: all declared Gemini levels, normalized only for enum case.

`none` has no declared Anthropic or Gemini equivalent. `minimal` has no declared
Anthropic equivalent. `xhigh` and `max` have no declared Gemini equivalent.
Unsupported values fail at the target outbound codec. Effort must never be
converted into an invented token budget or `thinking.type`.

### Numeric reasoning budget

```text
Anthropic thinking.budget_tokens
  <-> request.reasoning_budget_tokens
  <-> Gemini generationConfig.thinkingConfig.thinkingBudget
```

This is `conditional_exact`: Anthropic requires an enabled thinking object and a
budget of at least 1024 and below `max_tokens`; Gemini limits and special values
are model-dependent. OpenAI Responses and OpenAI Chat expose no numeric reasoning
budget field, so projection to either OpenAI protocol is unmapped.

### Summary, context, mode, include, and display

These are separate semantics and are not mutually reconstructible:

- `reasoning.summary` and deprecated inbound alias `reasoning.generate_summary`
  decode to `request.reasoning_summary_policy`. If both are present they must be
  equal; conflicting values fail at inbound. Responses outbound emits
  `reasoning.summary`; OpenAI Chat uses the registered static projection
  `auto/concise/detailed -> reasoning_effort medium/low/high` and retains the
  higher level when an explicit effort is also present.
- `reasoning.context` round-trips through
  `request.reasoning_context_policy` only to Responses.
- `reasoning.mode` round-trips through `request.reasoning_mode` only to
  Responses.
- Gemini `includeThoughts` round-trips through
  `request.reasoning_include_thoughts` only to Gemini.
- Anthropic `thinking.display` round-trips through
  `request.reasoning_display_policy` only to Anthropic.
- Anthropic `thinking.type` round-trips through
  `request.reasoning_thinking_mode` only to Anthropic.

OpenAI `summary=auto|concise|detailed`, Anthropic
`display=summarized|omitted`, and Gemini `includeThoughts:boolean` do not share
the same value domain or continuation behavior. Cross-protocol conversion between
them is therefore unmapped. In particular, no codec may encode summary, context,
or mode as a system message or hidden prompt marker.

## Client metadata

`client_metadata` is an inbound client data-plane extension, not an internal
control carrier. Its Chat owner is `request.client_metadata`.

Target rules:

- OpenAI Responses/OpenAI Chat `metadata`: maximum 16 string pairs; key length
  at most 64 characters; value length at most 512 characters. Projection is
  allowed only after validating this schema.
- Anthropic `metadata`: only `user_id` is declared. The adjacent codec may
  project an object containing exactly one non-empty `user_id`. Session, thread,
  turn, and installation identifiers remain distinct local request-context
  semantics and may not be relabeled as `user_id`; registered Codex local keys
  are consumed before provider wire, while unknown keys remain unmapped.
- Gemini: no general request metadata field with equivalent client payload
  semantics is declared in the audited GenerateContent schema.

Metadata keys must never create or alter RouteCodex session, conversation,
continuation, routing, provider-selection, or health state.

## Prompt cache, storage, and text output configuration

- OpenAI Responses and OpenAI Chat both declare `prompt_cache_key`; it is an
  exact data-plane value after adjacent field projection. Anthropic
  `cache_control` does not carry the same key semantic, so a valid Responses
  cache key is validated and consumed as a local cache hint before Anthropic
  wire; malformed values fail. It must not rebuild `cache_control`.
- OpenAI Responses and OpenAI Chat both declare `store`; it remains an upstream
  storage preference. RouteCodex continuation save/restore is separately owned by
  the continuation control resource and cannot be inferred from `store`.
  Anthropic has no equivalent request field; `false` is validated and consumed
  before Anthropic wire, while `true` fails because remote storage semantics
  cannot be preserved.
- Responses `text.format` and `text.verbosity` are decoded into the registered
  text output configuration. OpenAI Chat projection is allowed only through its
  declared `response_format` and `verbosity` fields with shape validation.
  Anthropic validates `verbosity` as a local style hint and consumes it before
  wire; it never becomes Anthropic `output_config.effort`. No codec may turn
  output configuration into prompt text.

## Tool declaration and tool-call projection

Tool declarations are business payload, not routing hints. Each source tool
family must be reviewed against the selected target's actual schema before the
provider request is built:

| Source semantic | OpenAI Chat target | Rule |
| --- | --- | --- |
| `type=function` | `type=function` | Exact field/schema projection; preserve the complete JSON Schema and tool choice. |
| `type=custom`, `format.type=text` | `type=custom`, `custom.format.type=text` | Exact free-form custom-tool projection; do not wrap the input in a JSON object or rename it to `function`. |
| `type=custom`, `format.type=grammar` | `type=custom`, `custom.format.type=grammar` with `custom.format.grammar.{syntax,definition}` | Exact grammar projection when the selected Chat model advertises custom grammar support; otherwise fail at the adjacent codec. Never downgrade grammar to an unconstrained function/string schema. |
| `type=web_search|web_search_preview` | Chat `web_search_options` | Project only options present in the Chat schema. `search_content_types=["text"]` is the target default and may be consumed only after validation; a request that includes `image` is unmapped and must fail. |
| `type=tool_search`, `execution=client` | named `function` compatibility tool | This is a named, audited compatibility transform. The response codec must restore `tool_search_call` with exact call identity and arguments; no other custom tool may use this shape. |

The OpenAI Chat SDK/API schema explicitly supports `type=custom` tools,
free-form text input, grammar input, and custom-tool response calls. Therefore
converting a Responses custom tool to a function tool is not the canonical
projection and is forbidden unless a target capability contract proves the
selected model lacks native custom tools and a separately reviewed
`mapped_compatible_registered` mapping exists.

### Anthropic registered custom-tool compatibility

Anthropic Messages has no native raw-string custom call, but its `tool_use`
object can carry an explicit reversible compatibility shape. This mapping is
registered as `mapped_compatible_registered`, not native grammar support:

```text
Chat custom declaration
  name + description + format(text | grammar{syntax,definition})
    -> Anthropic tool declaration
       name: unchanged
       description: source description plus a deterministic compatibility note
       input_schema:
         type: object
         properties.input:
           type: string
           description: source free-form or grammar constraint
         required: [input]
         additionalProperties: false

Chat custom call raw input
    -> Anthropic tool_use.input = {"input": <exact raw string>}

Chat named custom tool_choice
    -> Anthropic tool_choice = {"type":"tool","name":<exact source name>}
    -> valid only with the governed custom declaration for that exact name

Anthropic tool_use response
    -> for a fresh provider response, select the custom branch only when the
       active governed declaration marks the exact tool name as custom
    -> bind the provider-generated tool_use.id as the current call identity
    -> require the registered wrapper shape and string input
    -> restore the exact Chat custom raw input

Historical replay or tool_result pairing
    -> require the previously bound call identity to match exactly
```

For a grammar custom tool, the compatibility note carries the exact grammar
syntax and definition into the Anthropic-visible declaration. This preserves
the requested constraint information but does not claim that Anthropic enforces
the grammar natively. The semantic delta, "constraint described but not
provider-enforced", is part of the registered mapping and must be visible in the
matrix and tests.

The reverse projector must not infer custom semantics from an arbitrary
`tool_use.input={"input":...}` object. It may unwrap only when the same governed
request declared that exact tool name as custom and the wrapper contains exactly
the registered keys/types. A fresh provider-generated `tool_use.id` is bound
after that branch is selected; it is not a prerequisite for selecting the
branch. Historical replay and `tool_result` pairing must then match that bound
call identity exactly. Unknown wrappers, extra fields, missing string input,
silent relabeling, wrapper leakage to Responses/OpenAI clients, `{}` repair,
double stringify, result deletion, and provider switching are forbidden.

Malformed function-call arguments use a different registered compatibility
mapping: `v3.function_call.anthropic_raw_argument_wrapper.v1`. When a governed
function call contains an argument string that is not valid JSON, the adjacent
Anthropic codec may project the exact raw string as
`tool_use.input={"input": <exact raw string>}`. This wrapper preserves the
malformed source truth; it does not relabel the call as custom. Reverse
projection requires the governed function-call branch and exact bound call
identity, and restores the exact raw argument string. Valid function arguments
continue to use the native Anthropic object input path. Missing or non-string
source arguments, extra wrapper keys, `{}` repair, double stringify, paired
result deletion, provider failure classification, and provider switching are
forbidden.

### Response-field confirmation contract

Provider response conversion is closed-world. Before a response field is
accepted, the matrix must record its source path, target path, cardinality/order,
value-domain validation, and whether the projection is `mapped_exact`,
`mapped_compatible_registered`, source-roundtrip-only, or unsupported. Every provider
response field in an active fixture is manually classified; an unclassified
field is a gate failure. A response converter may not pass through an unknown
object, copy the source protocol envelope, or synthesize a client field from
MetadataCenter/control state.

## Responses request extensions to Anthropic

These fields enter Chat Process only under
`routecodex_chat_extension.responses_request`; the raw Responses top-level fields
must not cross ReqInbound02.

| Responses extension | Anthropic projection |
| --- | --- |
| `client_metadata` | Optional non-empty `user_id` projects to `metadata.user_id`; registered Codex local keys are consumed before wire; unknown keys fail because Anthropic has no reversible target field. |
| `prompt_cache_key` | Valid non-empty key is consumed as a local cache hint before wire; malformed values fail; it must not rebuild `cache_control`. |
| `store` | `false` is validated and consumed before wire; `true` fails because Anthropic cannot preserve remote storage semantics; neither value changes RouteCodex continuation state. |
| `text.verbosity` | Valid low/medium/high value is consumed as a local style hint before wire; invalid values fail; it never becomes Anthropic reasoning effort. |
| `text.format.type=text` | Conditional exact default-text projection; emits no format object only after the outbound codec verifies no conflicting format field. |
| `text.format.type=json_schema` | Maps to `output_config.format` with `type` and `schema`; `strict=false` is not representable and fails. |

No field in this table may enter MetadataCenter, provider selection, retry,
continuation, SSE, or server-handler compensation.

Structured Anthropic system blocks use the separate
`request.anthropic_system_blocks` source-roundtrip extension. Anthropic outbound
reconstructs `system` only from that registered field. Responses, OpenAI Chat,
and Gemini outbound fail explicitly because block-local `cache_control` and block
boundaries have no exact target field; they must not flatten the extension into
plain instructions and silently discard those semantics.

## Error contract

### Failure evidence contract

When a relay request terminates with an error, the server-owned diagnostic side
channel must retain the original client request and every provider transport
attempt (request, response, or transport error) under the request-scoped
`~/.rcc/codex-samples/<entry-protocol>/ports/<port>/<request-id>/` directory.
The evidence is captured at the raw client and provider transport boundaries,
before normalization or response decoding. Intermediate Chat Process and
projection payloads are not required to be persisted. Evidence artifacts never
enter MetadataCenter, provider wire payloads, or client response bodies, and
must not be used to reconstruct live business state.

The outbound owner reports the canonical semantic paths, not discarded source
wire aliases:

```text
UnmappedOutboundFields target_protocol=anthropic
paths=$.request.reasoning_context_policy,$.request.client_metadata.unknown_key
```

Malformed source values fail at the inbound codec. Target-domain violations fail
at the outbound codec. A field may be consumed without a wire field only when the
matrix declares an exact target default with conflict validation. Arbitrary
cleanup, provider switch caused by a fabricated compatibility success, and prompt
compensation remain forbidden.

## Owners and forbidden paths

| Operation | Unique owner |
| --- | --- |
| Responses wire -> Chat semantics | `hub_v1/responses_openai_codec.rs` |
| Chat semantics -> OpenAI Chat/Responses wire | `hub_v1/request_outbound_format.rs` |
| Anthropic wire <-> Chat semantics | `hub_v1/anthropic_codec.rs` |
| Gemini wire <-> Chat semantics | `hub_v1/gemini_codec.rs` |
| Req07 -> provider protocol dispatch | `hub_v1/provider_req_compat_06_provider_compat.rs`; dispatch only, no semantic reconstruction |

Forbidden owners: MetadataCenter, Virtual Router, server handler, SSE layer,
provider transport, continuation store, debug/snapshot projection, TypeScript
runtime, and V2 sharedmodule.

The feature module manifest is a design-scope registry for this feature's runtime
files. It is not runtime-active until conformance verification finishes. The
project-wide one-owner-per-source module registry remains pending and this design
does not represent it as complete.

## Verification contract

Before implementation, red tests must prove:

1. `reasoning_effort=medium` reaches Anthropic
   `output_config.effort=medium` and is not silently retained or discarded.
2. OpenAI `none/minimal` to Anthropic and `xhigh/max` to Gemini fail with the
   canonical Chat path.
3. Numeric budget maps only between Anthropic and Gemini and never becomes
   OpenAI effort.
4. Summary/context/mode cannot become Anthropic system markers; valid summary
   policy uses the registered Anthropic static compatibility mapping: all valid values retain native thinking and project the complete returned thinking into Responses reasoning summary; the proxy must not reject, truncate, or silently discard reasoning.
5. Responses request extensions survive ReqInbound02 and Chat Process without raw
   top-level field carry; Anthropic projects only exact `metadata.user_id` and
   compatible structured format. Cache key, registered client metadata,
   `store=false`, and valid verbosity consume only through registered local
   compatibility; identifier relabeling, mixed metadata, unknown metadata,
   `store=true`, and incompatible format fail with canonical Chat paths.
6. OpenAI metadata limits are validated before wire emission.
7. Node snapshots prove source wire -> Chat semantic -> governed Chat semantic ->
   provider semantic, with no raw shortcut and no MetadataCenter copy.

Positive and negative tests are both required. Runtime completion additionally
requires global install, managed aggregate restart, all configured port health,
and live same-entry replay for Responses and Anthropic target paths.

## Protocol sources and audit date

- OpenAI API OpenAPI `POST https://api.openai.com/v1/responses`, retrieved
  2026-08-01 through the official OpenAI OpenAPI source.
- OpenAI API OpenAPI `POST https://api.openai.com/v1/chat/completions`, checked
  2026-08-03 through the official OpenAI OpenAPI source. The Chat request schema
  declares native custom tools and `web_search_options`.
- OpenAI JavaScript SDK `5.23.2`,
  `resources/chat/completions/completions.d.ts`: `ChatCompletionCustomTool`,
  `ChatCompletionMessageCustomToolCall`, and `WebSearchOptions`. The native Chat
  custom-tool shape nests declaration fields under `custom`, preserves raw
  custom-call `input`, and represents grammar as
  `custom.format.grammar.{syntax,definition}`; Chat web search exposes context
  size and location but no `search_content_types` image selector.
- OpenAI JavaScript SDK `7.3.0`, `resources/shared.d.ts`: `Reasoning`,
  `ReasoningEffort`, and `Metadata`. This source declares `reasoning.context`,
  `reasoning.mode`, the seven effort values, and the 16-pair/64/512 metadata
  limits.
- Anthropic JavaScript SDK `0.115.0`,
  `resources/messages/messages.d.ts`: `OutputConfig`, `ThinkingConfigParam`, and
  `Metadata`. This source declares effort under `output_config`, thinking
  type/budget/display as independent fields, and only `metadata.user_id`.
- Google Gen AI JavaScript SDK `2.15.0`, `dist/genai.d.ts`: `ThinkingConfig` and
  `ThinkingLevel`. This source declares `includeThoughts`, `thinkingBudget`, and
  `thinkingLevel` as independent fields; `thinkingBudget` uses `0` for disabled
  and `-1` for automatic, with remaining limits model-dependent.

SDK types corroborate the public wire schema; runtime support remains
model-dependent and must be checked through the target capability contract.
