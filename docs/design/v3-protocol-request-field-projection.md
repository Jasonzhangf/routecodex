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
| `exact` | Source and target fields have the same meaning and the concrete value belongs to both target value domains. Project and consume the Chat field. |
| `conditional_exact` | Meaning matches, but model/version/value constraints apply. Project only after target capability and value validation. |
| `source_roundtrip_only` | Preserve in a registered Chat extension so the source protocol can be reconstructed; other targets fail explicitly. |
| `unmapped` | No target field has the same meaning. Return `UnmappedOutboundFields` with the Chat semantic path. |

There is no `approximate` generic projection, prompt-marker, silent-strip,
fallback, or MetadataCenter reconstruction class. Every projection must be
field-specific and owned by the adjacent codec.

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

## Field decision matrix

`same` means the source and target use the same concrete wire field. `rename`
means exact semantic projection with a different wire name. `conditional` means
the target value/model domain must be checked. `roundtrip` means only the source
protocol can reconstruct it. `unmapped` always returns the canonical Chat path.

| Chat semantic | Responses | OpenAI Chat | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| `metadata` | same, OpenAI limits | same, OpenAI limits | conditional only for exactly one non-empty `user_id` | unmapped |
| `client_metadata` | same source extension; never public `metadata` | optional non-empty `user_id` projection; every other key fails | optional non-empty `user_id` projection; every other key fails | unmapped |
| `prompt_cache_key` | same | same | unmapped | unmapped |
| `store` | same | same | `false` consumed before wire; `true` fails | unmapped |
| `text.output_config` | rename to `text` | field-wise conditional projection to `verbosity` / `response_format` | conditional projection only where the semantic matrix declares an exact target field | conditional projection only where the semantic matrix declares an exact target field |
| `reasoning_effort` | rename to `reasoning.effort` | same | conditional rename to `output_config.effort` | conditional enum-case projection to `thinkingLevel` |
| `reasoning_budget_tokens` | unmapped | unmapped | conditional rename to `thinking.budget_tokens` | conditional rename to `thinkingBudget` |
| `reasoning_summary_policy` | rename to `reasoning.summary` | unmapped | unmapped | unmapped |
| `reasoning_context_policy` | rename to `reasoning.context` | unmapped | unmapped | unmapped |
| `reasoning_mode` | rename to `reasoning.mode` | unmapped | unmapped | unmapped |
| `reasoning_include_thoughts` | unmapped | unmapped | unmapped | rename to `includeThoughts` |
| `reasoning_display_policy` | unmapped | unmapped | rename to `thinking.display` | unmapped |
| `reasoning_thinking_mode` | unmapped | unmapped | rename to `thinking.type` | unmapped |

No row authorizes one field to be reconstructed from another row. In particular,
`store` cannot create continuation state, metadata keys cannot create session
scope, and qualitative effort cannot create a numeric budget.

## Exact protocol projections

### Qualitative effort

| Protocol | Wire field | Values verified on 2026-08-01 |
| --- | --- | --- |
| OpenAI Responses | `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model support varies. |
| OpenAI Chat | `reasoning_effort` | Same OpenAI semantic; model support varies. |
| Anthropic Messages | `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max`; model support varies. |
| Gemini GenerateContent | `generationConfig.thinkingConfig.thinkingLevel` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`; supported levels vary by model. |

Projection is exact only for the concrete intersection:

- OpenAI to Anthropic: `low`, `medium`, `high`, `xhigh`, `max`.
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
  equal; conflicting values fail at inbound. Outbound emits only
  `reasoning.summary`.
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
  turn, and installation identifiers remain distinct payload semantics and may
  not be relabeled as `user_id`; mixed or unknown keys remain unmapped.
- Gemini: no general request metadata field with equivalent client payload
  semantics is declared in the audited GenerateContent schema.

Metadata keys must never create or alter RouteCodex session, conversation,
continuation, routing, provider-selection, or health state.

## Prompt cache, storage, and text output configuration

- OpenAI Responses and OpenAI Chat both declare `prompt_cache_key`; it is an
  exact data-plane value after adjacent field projection. Anthropic
  `cache_control` does not carry the same key semantic, so a non-empty
  Responses cache key is validated and consumed before Anthropic wire. It must
  not rebuild `cache_control`, and malformed values fail.
- OpenAI Responses and OpenAI Chat both declare `store`; it remains an upstream
  storage preference. RouteCodex continuation save/restore is separately owned by
  the continuation control resource and cannot be inferred from `store`.
  Anthropic has no equivalent request field; `false` is validated and consumed
  before Anthropic wire, while `true` fails because remote storage semantics
  cannot be preserved.
- Responses `text.format` and `text.verbosity` are decoded into the registered
  text output configuration. OpenAI Chat projection is allowed only through its
  declared `response_format` and `verbosity` fields with shape validation. No
  codec may turn output configuration into prompt text.

## Responses request extensions to Anthropic

These fields enter Chat Process only under
`routecodex_chat_extension.responses_request`; the raw Responses top-level fields
must not cross ReqInbound02.

| Responses extension | Anthropic projection |
| --- | --- |
| `client_metadata` | Optional non-empty `user_id` projects to `metadata.user_id`; every other key fails because Anthropic has no reversible target field. |
| `prompt_cache_key` | Valid non-empty and malformed values both fail explicitly because Anthropic has no reversible equivalent; it must not rebuild `cache_control` or silently consume the field. |
| `store` | `false` is validated and consumed before wire; `true` fails because Anthropic cannot preserve remote storage semantics; neither value changes RouteCodex continuation state. |
| `text.verbosity` | Fails as unmapped because Anthropic has no reversible verbosity field; it never becomes Anthropic reasoning effort. |
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
4. Summary/context/mode cannot become Anthropic system markers.
5. Responses request extensions survive ReqInbound02 and Chat Process without raw
   top-level field carry; Anthropic projects only exact `metadata.user_id` and
   compatible structured format. Cache key, storage, verbosity, identifier
   relabeling, mixed metadata, and incompatible format fail with canonical Chat
   paths.
6. OpenAI metadata limits are validated before wire emission.
7. Node snapshots prove source wire -> Chat semantic -> governed Chat semantic ->
   provider semantic, with no raw shortcut and no MetadataCenter copy.

Positive and negative tests are both required. Runtime completion additionally
requires global install, managed aggregate restart, all configured port health,
and live same-entry replay for Responses and Anthropic target paths.

## Protocol sources and audit date

- OpenAI API OpenAPI `POST https://api.openai.com/v1/responses`, retrieved
  2026-08-01 through the official OpenAI OpenAPI source.
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
