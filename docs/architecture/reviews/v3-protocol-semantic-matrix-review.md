# V3 protocol semantic normalization matrix review

## Scope

Read-only audit. Goal: map one semantic across request/response across V3 supported protocols, then compare matrix to current Rust implementation and tests.

## Protocols in scope

- Responses
- OpenAI Chat
- Anthropic Messages
- Gemini

## Source field inventory

Downloaded protocol surfaces are recorded in the machine-readable audit artifact
`docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml` under
`source_inventory`. Sources used:

- OpenAI OpenAPI: `https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.json`
  - Roots: `CreateResponse`, `Response`, `CreateChatCompletionRequest`, `CreateChatCompletionResponse`.
  - Download evidence: 3,224,154 bytes, SHA-256 `9f65dd3582af1404d00d22f56d32595524a88459a98310afbb3cc488eb3fa270`.
- OpenAI official SDK types: `https://unpkg.com/openai@6.49.0/resources/responses/responses.d.ts`
  and `https://unpkg.com/openai@6.49.0/resources/chat/completions/completions.d.ts`
  - Roots: Responses input/output item types, Chat message/content/tool/audio/stream types.
  - Download evidence: Responses SDK 260,936 bytes / SHA-256 `32002f8ff62b00864440b8903d08edf36da9ef08aa80778fbc8d459498282eed`; Chat SDK 86,766 bytes / SHA-256 `02a1db9721772b290ec266454403eea9b1a7dfaff10b314280087dca7949cfb6`.
- Anthropic official SDK types:
  `https://unpkg.com/@anthropic-ai/sdk@0.114.0/resources/messages/messages.d.ts`
  - Roots: `MessageCreateParamsBase`, `MessageParam`, `ContentBlockParam`, `Message`, `Usage`.
  - Download evidence: 104,611 bytes, SHA-256 `ea7531fdbcdd4443f3889eb330396a81391e11afed6a8750ca82d5e2ba535a9e`.
- Gemini discovery schema:
  `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`
  - Roots: `GenerateContentRequest`, `Content`, `Part`, `Tool`, `ToolConfig`,
    `GenerationConfig`, `GenerateContentResponse`, `Candidate`, `UsageMetadata`.
  - Download evidence: 360,585 bytes, SHA-256 `a8a87b426c1701b73d6100aff3efd8562289e6580157cab1db638a1af8f84edb`.

The inventory explicitly lists long-tail fields that are not represented by the old
coarse buckets, including Responses `background` / `context_management` /
`prompt_cache_options` / `text.format`, Chat `audio` / `modalities` /
`reasoning_effort` / `web_search_options`, Anthropic `container` /
`output_config` / `thinking.display` / content block `cache_control`, and Gemini
`toolConfig.functionCallingConfig`, `generationConfig.thinkingConfig`,
`contents[].parts[].thoughtSignature`, `modelVersion`, `responseId`, and
`usageMetadata.*`.

## Canonical owner slices

- Responses request canonicalization: `responses_openai_codec.rs`
- Responses request/provider wire shaping: `request_outbound_format.rs`
- OpenAI Chat provider response -> Responses projection: `responses_relay_runtime.rs`
- Anthropic request -> Responses semantic: `anthropic_codec.rs`
- Responses provider response -> Anthropic client projection: `anthropic_relay_runtime_codec.rs`
- OpenAI Chat request/response same-protocol: `openai_chat_codec.rs`, `openai_chat_relay_runtime.rs`
- Gemini request/response same-protocol: `gemini_codec.rs`, `gemini_relay_runtime.rs`

## Semantic matrix

### A. identity / routing / protocol markers

| Semantic | Responses | OpenAI Chat | Anthropic | Gemini | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| model | request model preserved until provider selection; response model projected back from provider response when present | request model preserved; response model preserved | request model preserved; response model preserved | request model preserved; response model preserved | Present in request outbound format, responses projection, Anthropic/Gemini codecs, same-protocol codecs | None in source audit; one red-fixture gap was verifier coverage, now fixed |
| id / request id / response id | response `id`, request truth ids in metadata/trace | response `id`, request truth ids in metadata/trace | response `id` / message id | response `id` / candidate ids | Present | Mostly owner-internal, not a matrix gap |
| created / created_at / timestamp | response `created_at` accepted from `created_at` or `created` | response `created` / `created_at` normalized | response `created` / `created_at` normalized where present | response timestamp fields normalized or omitted by provider shape | Present in Responses projection, same-protocol tests | Needs explicit matrix rows per protocol if future timestamp contracts matter |
| role / entry protocol / transport intent | request entry protocol + transport intent | request role/messages + stream flag | request role/messages + stream flag | request contents + stream flag | Present via request wrappers and codec traces | No owner gap |

### B. text / content / multimodal

| Semantic | Responses | OpenAI Chat | Anthropic | Gemini | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| user text | `input[].content` -> `input_text` | `messages[].content` string/parts | `messages[].content[].text` | `contents[].parts[].text` | Present | Need table row expansion in docs for Gemini content variants |
| assistant text | `output_text` / `choices[].message.content` -> Responses `output_text` | `choices[].message.content` string | `content[].text` / `thinking` blocks | `candidates[].content.parts[].text` | Present | No gap |
| image input/output | `input_image` / image url parts | `input_image` / image url parts | `image` parts | `parts[].inlineData` / URL image variants | Present in codec sources, esp Responses/OpenAI Chat; Gemini tests cover request shape but doc row missing | Doc matrix incomplete for Gemini image mapping detail |
| reasoning / thinking | Responses `reasoning` item | OpenAI Chat `reasoning_content` / reasoning | Anthropic `thinking` / `redacted_thinking` | Gemini response reasoning less explicit, provider shape dependent | Present for Responses/OpenAI Chat/Anthropic; Gemini codec has no dedicated reasoning projection row | Potential document gap for Gemini reasoning row |

### C. tool semantics

| Semantic | Responses | OpenAI Chat | Anthropic | Gemini | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| ordinary tool call | `function_call` | `tool_calls[].function` | `tool_use` | `functionCall` | Present | No gap |
| custom tool call | `custom_tool_call` | custom wrapper / function.arguments.input | not native | not native | Present in Responses/OpenAI Chat, validation in Anthropic projection | Need matrix row per direction for custom tool raw-input preservation |
| tool result | `function_call_output` | `tool` role / `tool_call_id` | `tool_result` | `functionResponse` | Present | No gap |
| tool identity pairing | Req04 / Resp Chat Process, not normalization | Req04 / Resp Chat Process, not normalization | Req04 / Resp Chat Process, not normalization | Req04 / Resp Chat Process, not normalization | Tests enforce this split | Matrix should emphasize “no normalization owner” for all four |
| additional tools / builtins | `additional_tools` and `tools` preserved into provider wire | `tools` preserved, builtins normalized | `tools` / `thinking` / `tool_choice` preserved | `tools` preserved if supported | Present | Doc coverage incomplete for Responses builtins and Gemini tool naming parity |

### D. control / metadata / payload hygiene

| Semantic | Responses | OpenAI Chat | Anthropic | Gemini | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| `metadata` | preserved as data-plane when target supports it | preserved as data-plane | preserved as data-plane | rejected if side-channel leak; not a native field focus | Present in Responses/OpenAI Chat docs/tests | No runtime gap, but docs should clearly distinguish data-plane vs control-plane per protocol |
| `client_metadata` | preserved in response-side source matrix but stripped from OpenAI Chat provider wire in current implementation | rejected / not forwarded to OpenAI Chat provider wire | not native | not native | Current code removes it before OpenAI Chat wire | Doc gap: current matrix says preserved for OpenAI Chat request row, but implementation and test assert strip |
| RouteCodex control fields | fail-closed before provider/client payload | fail-closed | fail-closed | fail-closed | Present | No gap |
| side-channel fields | rejected | rejected | rejected | rejected | Present | No gap |

### E. request normalization / provider wire

| Semantic | Responses -> Chat | Anthropic -> Responses | OpenAI Chat same-protocol | Gemini same-protocol | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| request canonicalization | `responses_openai_codec.rs` | `anthropic_codec.rs` | `openai_chat_codec.rs` | `gemini_codec.rs` | Present | No gap |
| provider wire shaping | `request_outbound_format.rs` | `anthropic_codec.rs` + relay runtime codec | same protocol passthrough / normalization | same protocol passthrough / normalization | Present | Needs explicit matrix row for `client_metadata` strip on OpenAI Chat wire |
| stream intent | preserved | preserved | preserved | preserved | Present | No gap |
| tool search / web search / builtins | preserved into OpenAI Chat wire and model/tool selection | mapped to Anthropic-valid tools where needed | same protocol | same protocol | Present | Need more explicit row for tool_search/web_search builtins across protocol boundaries |

### F. response projection / reverse mapping

| Semantic | OpenAI Chat -> Responses | Responses -> Anthropic | OpenAI Chat same-protocol | Gemini -> client projection | Current implementation | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| output text | `choices[].message.content` -> `output_text` | `output_text` -> Anthropic text blocks | preserved | projected or preserved according to provider response shape | Present | No gap |
| reasoning | `reasoning_content` -> `reasoning` | `reasoning` -> Anthropic thinking blocks | preserved | Gemini reasoning via provider shape, no dedicated row | Present for OpenAI Chat/Anthropic; unclear for Gemini | Doc gap |
| tool calls | `tool_calls[]` -> `function_call` / custom tool item | `function_call` / custom tool item -> `tool_use` | preserved | Gemini functionCall/functionResponse preserved by provider shape | Present | No gap |
| usage | `usage.*` -> `usage.*` | `usage.*` -> `usage.*` | preserved | `usageMetadata` -> client/projected usage | Present | No gap |
| finish / terminal | `finish_reason` -> status / finish_reason | `finish_reason` -> `stop_reason` | preserved | `finishReason` -> terminal state | Present | Need explicit Gemini terminal row in docs matrix |

## Verified implementation evidence

1. `responses_openai_codec.rs`
   - request canonicalization preserves `model`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `metadata`, `client_metadata`, `stop`.
   - requests with malformed tool adjacency fail closed.
2. `request_outbound_format.rs`
   - OpenAI Chat wire preserves messages/tools/stream and normalizes provider tool surface.
   - OpenAI Chat wire strips `client_metadata` before provider send.
   - provider-outbound control keys are removed, not repaired.
3. `responses_relay_runtime.rs`
   - OpenAI Chat response projection writes `response.insert("model", model.clone())` and `created_at` from `created_at` or `created`.
   - OpenAI Chat diagnostic/semantic errors are detected before Responses projection.
4. `anthropic_codec.rs`
   - Anthropic request encoding preserves `thinking`, `tool_choice`, `metadata`, tool schema, and preserves Responses semantic to Anthropic wire mapping.
   - malformed function arguments fail closed.
5. `anthropic_relay_runtime_codec.rs`
   - Responses -> Anthropic client projection preserves tool use, thinking, usage, stop_reason, and raw input for custom tools.
6. `openai_chat_codec.rs`
   - OpenAI Chat request and response characterization preserve messages, tool calls, usage, finish_reason, and SSE validity.
7. `gemini_codec.rs`
   - Gemini request/response characterization only validates shapes and candidate parts; no rich semantic remap beyond provider shape.
8. `gemini_relay_runtime.rs`
   - Gemini response projection is mostly pass-through with validation; terminal state derived from `finishReason` in candidates.

## Current implementation vs source inventory gap

- Responses -> OpenAI Chat request currently copies only a supported subset into Chat wire: `tool_choice`, `parallel_tool_calls`, `user`, `temperature`, `top_p`, `logit_bias`, `seed`, `stream`, `response_format`, `max_tokens`, `max_output_tokens`, `metadata`, `client_metadata`, and `stop`; source-inventory fields such as `background`, `context_management`, `conversation`, `prompt_cache_*`, `service_tier`, `text.*`, `top_logprobs`, and `truncation` are not yet fully represented as Chat Process canonical/extension contracts.
- OpenAI Chat same-protocol characterization preserves the main Chat payload, but the matrix now requires explicit extension ownership for `audio`, `modalities`, `reasoning_effort`, `web_search_options`, `prediction`, `store`, `prompt_cache_*`, and response `system_fingerprint/service_tier/moderation/logprobs` before those fields can be relied on in cross-protocol conversion.
- Anthropic -> Responses currently maps `system`, `messages`, `tools`, `tool_choice`, `thinking`, `metadata`, `temperature`, `top_p`, `top_k`, `parallel_tool_calls`, `max_tokens/max_output_tokens`, `stop_sequences`, and `stream`; source-inventory fields such as `container`, `output_config`, `service_tier`, `cache_control`, server-tool result blocks, and `user_profile_id` need protocol-specific Chat Process extension ownership.
- Gemini V3 codec now semantically extracts `toolConfig.functionCallingConfig.mode` and `allowedFunctionNames`, while remaining `generationConfig`, `safetySettings`, `thoughtSignature`, candidate grounding/citation, and `usageMetadata` subtrees are still not fully expanded. These are locked as extension/gap rows rather than being treated as generic raw payload metadata.

## Main gaps

- Documentation gap: the coarse semantic matrix is still not the full protocol inventory; the new `source_inventory` block is the authoritative download ledger, but some deep nested shapes still need protocol-specific semantic labeling.
- Documentation gap: Gemini still needs clearer semantic ownership for remaining `generationConfig`, `safetySettings`, `responseFormat`, and candidate/usage subtrees after the toolConfig function-calling subset closeout.
- Documentation gap: OpenAI Chat still needs explicit semantic ownership for `audio`, `modalities`, `reasoning_effort`, `web_search_options`, and other long-tail fields.
- Documentation gap: Responses still needs explicit semantic ownership for `background`, `context_management`, `conversation`, `prompt_cache_*`, `service_tier`, `top_logprobs`, and other long-tail fields.
- Verification gap fixed: verifier used a broad `payload.get("model")` substring and could miss the exact Responses projection site. That was corrected.

## Follow-up artifact created

Machine-readable field matrix: `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`.

It now tracks:
- protocol source fields for Responses, OpenAI Chat, Anthropic Messages, and Gemini;
- canonical Chat Process semantic families;
- protocol-specific Chat Process extension blocks;
- edge-only fields;
- unsupported/lossy/source-inventory-only/runtime-gap fields;
- current implementation coverage and open gaps.

`verify:v3-protocol-conversion-field-parity` parses this YAML and requires the key long-tail field rows. Red fixtures reject dropping `gemini.request_top_level_fields.toolConfig`.

## Extended OpenAI Chat semantic superset

The field-level matrix now includes `extended_openai_chat_semantic_superset`.

Contract:
- OpenAI Chat is the Chat Process protocol skeleton.
- `openai_chat_extended` is the semantic superset used for audit.
- Every source field from Responses, OpenAI Chat, Anthropic Messages, and Gemini is mapped exactly once to `fields[].equivalent_fields.<protocol>` or explicitly classified as `edge_only` / `unsupported_blocked`.
- `fields[].semantic_id` and `fields[].extended_openai_chat_field` are unique.
- Business payload semantics must not use MetadataCenter, raw payload dump, SSE transport, server handler, or provider transport as owner.

Review surface:
- `docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html`
- Primary table 1: `chat_semantic_translation_groups`. This is the manual audit surface:
  each row starts from an OpenAI Chat native field or protocol-neutral Chat extension,
  states the standard Chat semantic meaning, then groups Responses / Anthropic /
  Gemini fields by meaning with explicit value/shape transform rules. Many-to-one
  and one-to-many mappings are expected; direct field-name dumping is forbidden.
- Primary table 2: `extended_openai_chat_semantic_superset`. This keeps exact
  source-field coverage so every downloaded protocol field is still searchable and
  mapped exactly once after the manual semantic grouping.

Manual semantic corrections now locked:
- `request.input[].function_call.arguments` maps only to
  `request.messages[].tool_calls[].function.arguments`, not to tool-call id/name
  or tool declarations.
- `request.input[].function_call.name` maps only to
  `request.messages[].tool_calls[].function.name`.
- Tool result id, output payload, result name, and error status are separate
  Chat semantics: `request.messages[].tool_call_id`,
  `request.messages[].tool_result.output`,
  `request.messages[].tool_result.name`, and
  `request.messages[].tool_result.is_error`.
- Gemini `functionResponse.name` and `functionResponse.response` do not collapse
  into Chat `tool_call_id`.
- Gemini `inlineData.mimeType` / `fileData.mimeType` map to
  `request.messages[].content[].media.mime_type`, never to
  `image_url.url`.

Gate coverage:
- `verify:v3-protocol-conversion-field-parity` checks all source fields are mapped exactly once to the superset.
- It also requires the manual semantic translation groups, per-protocol transform
  text, and negative checks against collapsing id/name/arguments/output/MIME into
  the wrong Chat field.
- Red fixtures reject removing manual groups, collapsing tool arguments into ids,
  collapsing tool result output/name into pairing id, collapsing Gemini MIME into
  image URL, removing transforms, removing isolated field mapping, duplicating
  semantic ids, assigning business fields to MetadataCenter, and omitting protocol
  extension association.

## Canonical textual truth for the field-matrix audit

This Markdown section is the human-readable truth text for the generated review
surface. The machine-readable source remains
`docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`; the generated
HTML review surface remains
`docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html`.

Truth contract:
- Chat Process protocol is OpenAI Chat native fields plus protocol-neutral
  `request.*` / `response.*` / `edge.*` extension fields.
- OpenAI Chat native field names are preserved exactly, including `[]` item
  notation. Native fields are never renamed into a new protocol namespace.
- Responses, Anthropic Messages, and Gemini are mapped by semantic meaning, not
  by copied field names. Many-to-one and one-to-many mappings are normal.
- Tool-call id, tool-call name, tool-call arguments, tool-result pairing id,
  tool-result output, tool-result name, tool-result error state, image URL, file
  id, inline bytes, file URI, and MIME type are distinct semantics.
- Every `shape_branch_gap` content/media/file row must carry explicit
  `shape_branch_cases.positive[]` and `shape_branch_cases.negative[]` contracts:
  source condition, target Chat semantic, adjacent Rust codec owner file, and the
  required Rust test symbol. These rows cannot be closed by relabeling; they
  close only after the named branch tests and owner implementation exist.
- Business payload semantics must not use MetadataCenter, raw payload dump, SSE
  transport, server handler, or provider transport as the truth owner.

## Audited status legend and counts

`current_impl` is an audited status label, not a generic TODO bucket. The matrix
must not use `pending_audit`.

| Status | Count | Meaning |
| --- | ---: | --- |
| `covered` | 161 | Runtime/test owner currently implements the audited semantic for the named path. |
| `covered_but_target_dependent` | 1 | Runtime implements the field only where the target protocol legally supports it; target-incompatible projection must be stripped or rejected by provider-wire owner. |
| `partial` | 84 | Some runtime path or direction is covered, but cross-protocol or value-shape parity is incomplete. |
| `extension_declared` | 214 | The OpenAI Chat extension field and semantic owner are declared, but runtime conversion closeout is not claimed. |
| `semantic_declared` | 59 | The OpenAI Chat native field or protocol-neutral extension has a manual semantic owner and transform rule, but runtime conversion closeout is not claimed. |
| `source_inventory_only` | 0 | The source field is inventoried and searchable, but no runtime semantic mapping is claimed; this status must stay at zero after source-owner closeout. |
| `shape_branch_gap` | 18 | Mapping requires branch-specific transform logic by source type/value shape before runtime closeout. |
| `codec_shape_only` | 14 | Current codec validates or preserves the protocol shape but does not yet implement full semantic conversion. |
| `edge_only` | 3 | Transport or request/response edge state; it must not become business semantic payload truth. |

## Gap audit for runtime closeout

This audit separates documentation truth from runtime completion. The current
HTML/YAML/gate surface is locked, but many semantic fields intentionally remain
runtime-closeout work.

| Gap id | Category | Affected status/count | Evidence | Closeout owner/rule |
| --- | --- | --- | --- | --- |
| `gap.client_metadata.target_dependent` | fixed doc gate | `covered_but_target_dependent` / 1 | OpenAI Chat provider wire preserves standard `metadata` but strips non-standard `client_metadata`; old docs implied unconditional preservation. | Keep target-dependent provider-wire behavior explicit; no MetadataCenter/fallback preservation of unsupported `client_metadata`. |
| `gap.runtime_extension_declared` | runtime closeout | `extension_declared` / 214 | Protocol-neutral OpenAI Chat extension fields and owners exist, but runtime conversion completion is not claimed. | Pick the adjacent protocol codec owner per field family, add red fixture first, then implement and prove source/blackbox/live evidence before marking covered. |
| `gap.semantic_declared_runtime_closeout` | runtime closeout | `semantic_declared` / 59 | These fields now have manual semantic owners and transform rules, but no runtime conversion completion evidence yet. | Add field-family red tests and implement adjacent Rust codec owner before changing `semantic_declared` to covered, partial, or unsupported_blocked. |
| `gap.partial_cross_protocol_semantics` | runtime closeout | `partial` / 84 | Main protocol paths cover some directions, but not all equivalent request/response transforms across Responses, OpenAI Chat, Anthropic, and Gemini. | Close request and response directions together in `hub_v1` protocol codec owners; no server/SSE/provider-transport repair. |
| `gap.source_inventory_only` | semantic owner closeout | `source_inventory_only` / 0 | All previously `source_inventory_only` fields now have manual semantic owner groups, explicit transform rules, and non-runtime completion status. | Keep `source_inventory_only` at zero; new source fields must be classified before runtime edits. |
| `gap.shape_branch_transform` | transform closeout | `shape_branch_gap` / 18 | Media/tool/content fields now have gated `shape_branch_cases` for URL vs file id vs inline bytes vs MIME vs file URI. Gemini inlineData/fileData request branches now have source tests in `hub_gemini_codec_characterization.rs`, but the rows stay open until every protocol branch has equivalent owner evidence. | Test every shape branch positively and negatively in the adjacent codec owner; never collapse distinct semantics into nearby fields. |
| `gap.gemini_codec_shape_only` | runtime closeout | `codec_shape_only` / 14 | Gemini codec now extracts `toolConfig.functionCallingConfig` mode/allowed-name semantics; remaining `generationConfig` / safety / citation / grounding / usage semantics are not fully expanded. | Implement Gemini semantic mapping as protocol extensions or explicit unsupported rows; do not treat subtree as raw payload truth. |
| `gap.edge_only_transport_state` | no business runtime closeout | `edge_only` / 3 | Edge rows describe stream/event transport state. | Keep edge fields out of provider/client normal payload; do not reclassify as Chat semantic fields. |

Follow-up implementation plan for closing the non-covered gaps:
`docs/goals/v3-protocol-semantic-field-gap-closeout-plan.md`.
