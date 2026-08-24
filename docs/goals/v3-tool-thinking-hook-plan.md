# V3 Tool-Thinking JSON v2 Hook Design

Status: `phase1_reason_only_verified_pending_full_path_gates`

Date: 2026-08-23

Feature: `v3.tool_thinking_hook_skeleton`

Contract version: `tool_thinking_json_v2`

This is the canonical design for Tool-Thinking. It replaces every former
the historical text/fence request contract. Implementation is blocked until
this document, the function map, the mainline call map, and the verification map
describe the same lifecycle.

## 1. Outcome

When `tool-thinking` is enabled, the proxy dynamically extends the current
request's provider-facing non-Gemini tool contracts. Every model tool call is
asked to add a required `reason` and two optional diagnostic fields to its native parameter object:

- `reason`: a short, direct motivation for this call;
- `goal_alignment_confidence`: an integer from 0 through 100, measured against
  the user's current-turn goal;
- `model_id`: the model's non-empty identifier for this response.

The response hook reads only those explicit fields from a complete native
tool-call parameter container. A complete valid object authorizes one visible
reasoning projection for the turn. Before client projection, the three reserved
fields are removed without changing any native tool name, call ID, command,
input, argument, result, finish reason, or protocol structure.

The feature is transparent to both endpoints:

- the provider sees one ordinary, valid tool contract that appears to come from
  the client;
- the client sees its original native tool-call contract plus, in debug Phase 1,
  at most one normal reasoning item for the turn;
- neither endpoint sees RouteCodex control state, debug state, identity state,
  snapshots, routing, retry, health, or internal metadata.

## 2. Non-negotiable invariants

1. **NO FALLBACK.** No reason, confidence, model ID, tool name, or association is
   guessed from ordinary reasoning, thinking, text, history, tool descriptions,
   request IDs, timestamps, or another parser.
2. Req04 is the sole request semantic owner. It compiles one request-local
   Tool-Thinking contract. Protocol codecs may only preserve or mechanically
   project that contract; they cannot independently invent fields or guidance.
3. Resp03 is the sole response semantic owner. Protocol and SSE adapters only
   deliver complete native tool-call items or typed fragments to Resp03.
4. Phase 1 reasoning projection requires only an explicit, non-empty `reason`
   with the exact type defined here. `goal_alignment_confidence` and `model_id`
   are optional diagnostics in Phase 1; if present they must have their exact
   types, but absence or model mismatch does not block the reason projection.
   Phase 2 may restore the three-field hard gate after the observed response
   rate is sufficient.
5. Reserved-field removal is all-or-nothing per native call. A Phase 1 valid
   parameter object has its recognized auxiliary keys removed; every rejected
   object remains unchanged. Removing those keys must not modify any native
   parameter. Turn-level reasoning authorization is still granted at most once
   and only from explicit valid reason fields.
6. Malformed or incomplete JSON is never repaired. It is classified and remains
   native provider output; it cannot authorize projection.
7. One assistant tool turn produces exactly one terminal observation and at most
   one client reasoning item, even when the turn contains multiple tool calls.
8. The request's established protocol and Direct/Relay execution path select the
   parser. Response content never selects a parser dynamically.
9. Generic SSE framing, terminal semantics, error policy, routing, health,
   continuation, session parsing, handlers, and public interfaces are read-only.
10. Gemini is excluded. No Gemini request or response is modified by this
    contract.

## 3. Exact model-facing guidance

The canonical full guidance is attached once to the first eligible tool. Every
remaining eligible tool receives the compact reminder. Both strings are stable
and deterministic so tool ordering and cache-stable request regions remain
unchanged.

Full guidance:

```text
Tool-call auxiliary JSON fields. This instruction applies only when calling a
tool; it does not apply to ordinary answers.

For every tool call, include `reason` at the top level of the same JSON
parameter object as the tool's native parameters. The other two fields are
optional diagnostics:
- reason: one short phrase stating only the immediate motivation for this call;
- goal_alignment_confidence: if supplied, an integer from 0 to 100 comparing
  this call with the user's latest goal, where 100 is directly required and 0
  is unrelated;
- model_id: if supplied, the non-empty model identifier used for this response.

Positive example for a `bash` tool whose native parameters are
{"command":"pwd","description":"Show current working directory"}:
{"command":"pwd","description":"Show current working directory",
 "reason":"Confirm the current working directory",
 "goal_alignment_confidence":100,"model_id":"x-preview-f-free"}

Negative examples: omit `reason`; use null, a placeholder, or a string score
for a supplied diagnostic;
nest the fields under metadata or another parameter; emit a fence, preamble,
ordinary reasoning, or a second explanation; rename or restructure native tool
parameters. Older tool calls in conversation history do not define the current
schema and must not be copied when they omit these fields.

Emit the tool call immediately. For parallel calls, each call carries its own
`reason`; diagnostic fields are included independently when their values are
known.
```

Compact reminder:

```text
This tool call must include top-level reason beside its native parameters.
goal_alignment_confidence (integer 0-100) and model_id (non-empty string) are
optional diagnostics when their values are known. Do not emit a fence, preamble,
metadata wrapper, placeholder, or second explanation.
```

The guidance is strict. The response validator is tolerant only in the sense
that non-conforming output remains an observable native tool call; it never
guesses missing values and never converts invalid output into success.

## 4. Request contract

### 4.1 Structured function tools

For a native object schema, Req04 appends these properties at the schema's top
level and adds only `reason` to `required`; the two diagnostic properties stay
optional:

```json
{
  "reason": {
    "type": "string",
    "minLength": 1,
    "description": "Immediate motivation for this tool call; short and direct"
  },
  "goal_alignment_confidence": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100,
    "description": "Alignment with the user's latest goal"
  },
  "model_id": {
    "type": "string",
    "minLength": 1,
    "description": "Model identifier used for this response"
  }
}
```

The hook does not change existing properties, existing required entries,
defaults, enums, additional-properties policy, tool names, native description
text, or tool order. Req04 may place its deterministic guidance before the
native description text so the current contract is not hidden behind a long
tool description; the native description bytes and relative order remain
unchanged.

### 4.2 Free-form custom tools

A free-form custom tool has no native object schema, so merely appending text to
its description cannot implement this contract. Req04 therefore creates a
request-local provider-facing structured wrapper while recording the original
custom declaration in a typed turn context:

```json
{
  "type": "function",
  "function": {
    "name": "apply_patch",
    "parameters": {
      "type": "object",
      "properties": {
        "input": {"type": "string"},
        "reason": {"type": "string", "minLength": 1},
        "goal_alignment_confidence": {
          "type": "integer", "minimum": 0, "maximum": 100
        },
        "model_id": {"type": "string", "minLength": 1}
      },
      "required": ["input", "reason"],
      "additionalProperties": false
    }
  }
}
```

`input` is the exact original free-form tool input. The proxy never executes or
returns the wrapper object. Resp03 removes the reserved fields and restores the
original client custom-tool shape before client projection.

The custom provenance is a typed request/response side-channel resource. It is
not stored in request JSON, protocol metadata, history, continuation state,
provider options, or client payload. Static tool registries are never rewritten.

### 4.3 Model ID semantics

Validity requires a non-empty model-reported identifier. Equality with the
provider response's public `model` field is a separate diagnostic, not an
authorization rule. Req04 runs before selected-target wire binding on Relay, so
the implementation must not add a late request mutation or reorder the pipeline
merely to force a display alias. A mismatch is observable and does not alter the
tool call.

### 4.4 Reasoning effort ownership

`effort` must be classified before it is changed:

- Anthropic `output_config.effort` is a standard Anthropic wire field. The
  adjacent Anthropic protocol codec owns its canonical-to-wire projection and
  provider compat must preserve the resulting value unchanged.
- A provider that rejects or reinterprets that standard field owns a registered
  provider-compat rule at ReqOutbound provider compat. The rule must be keyed by
  the selected provider/profile and must not alter generic Anthropic handling.
- The current registered examples are MiniMax Anthropic (remove
  `output_config.effort` and use provider-supported adaptive thinking) and
  OpenCode Zen (map to its supported effort domain). Unsupported values fail
  explicitly; they are not guessed or silently downgraded.

This boundary is independent of Tool-Thinking JSON v2. Toolreason injection and
response stripping remain Req04/Resp03 responsibilities; effort conversion must
not be added to either parser or an SSE adapter.

## 5. Typed request-local context

Req04 produces one typed context beside the governed payload:

```text
V3ToolThinkingTurnContext
  enabled: bool
  contract_version: tool_thinking_json_v2
  original_custom_tools: ordered set of {name, original kind}
```

This context is request scoped and immutable after Req04. It is carried through
the existing Direct or Relay execution skeleton and consumed only by the
registered response hook. It is never serialized into provider or client data.

The shared Req04 owner has one conceptual API:

```text
compile_v3_tool_thinking_turn_context_at_req04(
  governed_payload,
  current_payload_start,
  enabled
) -> V3ToolThinkingTurnContext
```

The function performs the guidance append, structured-schema extension, custom
wrapper projection, and provenance capture as one atomic operation. No caller
may invoke those operations separately. A failed compilation returns an
explicit Req04 error before provider wire construction; there is no partially
governed payload and no downstream cleanup.

The carrier bindings are fixed:

| Path | Req04 carrier | Response consumer |
|---|---|---|
| Relay | `V3HubRelayRequestOutcome.tool_thinking_turn_context` | `V3HubRelayResponseHookProfile` and its registered JSON/SSE hook state |
| Direct | request-local Direct Req04 hook outcome held outside the provider-attempt loop | `V3DirectResponseCompatContext`, then the registered JSON/SSE response hook |

A boolean `tool_thinking_enabled` is insufficient because it cannot identify a
proxy-wrapped custom declaration. The context is compiled once per execution.
Direct provider retries reuse the same governed request and context; they do not
append guidance again or reconstruct provenance from the mutated tool list. A
Direct-to-Relay handoff starts from the untouched captured client request and
lets Relay Req04 compile its own same-request context.

Disabled mode produces an inactive context and payload identity. An enabled
request with no tools remains unchanged and later produces no Tool-Thinking
observation.

Resp03 produces a separate typed, request-local result after the complete native
tool turn is available:

```text
V3ToolThinkingTurnResult
  terminal_status: OK | MISSING | INVALID | MISPLACED
  ordered_tool_names: [native names]
  valid_fields: Option<{reason, goal_alignment_confidence, model_id}>
  projection_text: Option<String>
```

`valid_fields` and `projection_text` are present only for `OK`. The result is the
only authorization consumed by client-protocol projection and terminal
observation. It is not serialized, persisted, reconstructed from payload, or
identified through visible text/IDs. Streaming implementations keep a typed
turn accumulator until the already registered protocol codec declares the whole
assistant tool turn terminal. They must not finalize from the first complete
call because a later parallel call can change an otherwise `OK` turn to
`MISSING`, `INVALID`, or `MISPLACED`. They expose exactly one finalized result
and release it after projection.

## 6. Request lifecycle

```text
Client raw request
  -> ReqInbound normalization (no Tool-Thinking semantics)
  -> Req04 native tool governance
  -> Req04 Tool-Thinking contract compilation
       - append stable guidance
       - extend structured schemas
       - wrap free-form custom tools
       - emit typed turn context
  -> route / selected target
  -> protocol projection preserves the governed tool contract
  -> provider-bound payload snapshot gate
  -> provider
```

Direct and Relay invoke the same Req04 compiler. A downstream protocol
projection may translate `parameters` to Anthropic `input_schema`, but it must
preserve the required `reason` field, any supplied diagnostics, and the custom `input` wrapper. It must not run a
second injection helper.

The provider-bound snapshot is a mandatory gate. Source presence is insufficient:
every eligible final tool schema must contain required `reason` after all
protocol conversions; confidence/model remain optional properties. A custom
wrapper with only `input` is a request-path failure.

## 7. Protocol request matrix

| Entry / provider protocol | Provider-facing parameter container | Req04 result |
|---|---|---|
| Responses / Responses | `function.parameters` | structured function schema |
| Responses / OpenAI Chat | `function.parameters` | structured function schema |
| Responses / Anthropic | `tools[].input_schema` | mechanical projection of the same schema |
| OpenAI Chat / OpenAI Chat | `function.parameters` | structured function schema |
| Anthropic / Anthropic | `tools[].input_schema` | structured object schema |
| Gemini / any | native Gemini contract | unchanged; excluded |

## 8. Response lifecycle

```text
provider raw response/SSE
  -> protocol adapter collects the complete native tool-call item
  -> RespInbound02 preserves the complete parameter container
  -> Resp03 strict validator + reserved-field redactor
  -> Resp03 one-turn aggregation
  -> Resp03 custom-tool restoration using typed provenance
  -> one normal reasoning item when authorized
  -> protocol client projection
```

Protocol normalization must not unwrap a custom wrapper before Resp03. For
example, Responses-entry/OpenAI-Chat-provider conversion must carry the complete
function `arguments` object into Resp03; extracting only its `input` field before
Resp03 is forbidden because it destroys the sole extractor's source.

Every protocol adapter emits one complete typed native item without inspecting
the three auxiliary names:

```text
V3NativeToolCallItem
  protocol_kind
  native_tool_kind
  native_name
  native_call_id
  complete_parameter_value
  complete_parameter_raw_json
  original_native_item
```

`complete_parameter_raw_json` is required wherever the wire carried JSON text or
an object whose duplicate keys would otherwise be collapsed by a generic JSON
`Value` decoder. It is assembled by the protocol-specific item collector before
semantic normalization. Resp03 uses a duplicate-aware strict object visitor over
those exact bytes. The adapter does not search for reserved names, classify,
redact, restore custom shape, format reasoning, or observe status. If the
protocol decoder cannot retain the native parameter bytes, that is an explicit
adapter contract failure; converting first and guessing later is forbidden.

Custom restoration happens only after the reserved fields are processed:

```text
provider function_call arguments
  {input, reason, goal_alignment_confidence?, model_id?}
    -> Resp03 classifies reason and any supplied auxiliary fields
    -> Resp03 removes explicit reserved fields
    -> typed provenance authorizes mechanical function_call -> custom_tool_call
    -> client custom_tool_call.input = original input string
```

No tool name is inferred from command text. A function call without matching
typed custom provenance remains a function call.

Custom restoration and reasoning authorization are deliberately independent.
When typed provenance matches and the complete wrapper has a valid string
`input`, Resp03 always restores the client custom-tool shape and byte-preserves
that input, including when auxiliary fields are missing or invalid. This is the
mandatory inverse of a proxy-created request projection, not a fallback and not
a Tool-Thinking success. The turn still reports `MISSING` or `INVALID` and emits
no Tool-Thinking reasoning. If the wrapper itself is malformed or `input` is not
a string, Resp03 does not guess or repair it; the malformed provider-native call
remains unchanged and the turn is `INVALID`.

## 9. Strict validation and redaction

Resp03 also removes the request-local tool-list projection when a provider
echoes `tools` in a response. The stable removal identity is the reserved
field name (`reason`, `goal_alignment_confidence`, `model_id`) plus the
request guidance marker; provider-generated descriptions are not part of the
identity because a provider may normalize or omit them. Native tool schema
properties are preserved. If a native schema already owns one of the reserved
names as a business field, Req04 leaves that schema byte-for-byte unchanged;
the tool is not eligible for Tool-Thinking injection, and Resp03 must never
reinterpret that native field as a Tool-Thinking field.

### 9.0 Phase 1 acceptance gate

Phase 1 measures the observable value of the feature before enforcing the
optional diagnostic fields as a model-compliance gate. `reason` is the only
field required for a first-stage reasoning projection. A response that has a
valid, correctly placed, non-empty `reason` may project that reason even when
`goal_alignment_confidence` or `model_id` is absent. When either optional field
is present, Resp03 records its presence, type/range, and exact-model match in
the console observation; it does not reject an otherwise valid reason solely
because an optional diagnostic field is missing.

The Phase 1 online exit gate is:

- at least 50% of applicable real tool turns with a valid explicit `reason`
  produce exactly one client reasoning projection;
- every projected reason is stripped from the provider response surface;
- native tool name, call ID, input, arguments, command, patch, and finish reason
  remain unchanged;
- every governed turn still produces exactly one `OK`, `MISSING`, `INVALID`, or
  `MISPLACED` observation;
- confidence/model diagnostics are measured and reported, but are not required
  for Phase 1 pass;
- no client leakage, duplicate projection, silent observation loss, or
  feature-caused transport/mapping/error failure occurs.

Phase 1 does not remove the final contract requirement. The three-field,
exact-model gate remains the Phase 2 hardening target after reason projection
and response wiring are stable.

### 9.1 Projection authorization

A Phase 1 call is valid for projection when one complete parameter object
contains a trimmed, non-empty `reason` string and no duplicate occurrence of a
reserved field. If either diagnostic is present, its type/range is validated;
an absent or model-mismatched optional diagnostic does not invalidate the
reason-only projection. Otherwise the turn receives `MISSING`, `INVALID`, or
`MISPLACED`, and no Tool-Thinking reasoning is produced.

### 9.2 All-or-nothing redaction

Redaction is part of the same strict parse transaction as authorization. Resp03
removes the three reserved top-level keys only after one complete native tool
parameter object passes the Phase 1 reason-only validator. A partial, invalid,
misplaced, duplicate, malformed, or incomplete object is not rewritten. No
second privacy parser, key-only scrubber, text search, or malformed-JSON repair
is allowed.

This ordering deliberately gives the explicit no-rewrite rule precedence for
negative samples. “Zero auxiliary-field leakage” is therefore an acceptance
property of conforming valid calls and of all proxy-authored guidance/control
data; reserved-looking data in a rejected provider-native call remains part of
that unchanged rejected call. The formal live window requires 10/10 valid model
calls, so no rejected reserved-looking object may be used to claim acceptance.

### 9.3 Status table

| Native parameter condition | Terminal status | Reasoning | Native fields | Reserved fields |
|---|---|---|---|---|
| valid non-empty reason; diagnostics absent or valid | `OK` | one turn projection | preserved | supplied reserved fields removed |
| none present | `MISSING` | none | preserved | none |
| some missing | `MISSING` | none | preserved | unchanged |
| wrong type / empty / range | `INVALID` | none | preserved | unchanged |
| outside native container | `MISPLACED` | none | preserved | not treated as a valid source |
| duplicate reserved key | `INVALID` | none | unchanged | never authorizes projection |
| incomplete / malformed JSON | `INVALID` | none | protocol-native behavior | no repair or guess |

For a provenance-matched custom wrapper, “native fields preserved” means its
valid string `input` is mechanically projected back to the original
`custom_tool_call.input` for every status. This inverse projection never changes
the terminal status and never authorizes reasoning.

### 9.4 Turn aggregation

One assistant turn produces one terminal status. `OK` requires every observed
eligible native tool call in the turn to contain its own complete valid
three-field object. If any call fails, the turn is not `OK`, no Tool-Thinking
reasoning is projected, and each call follows its own all-or-nothing mutation
rule. Deterministic non-OK precedence is `INVALID` over `MISPLACED` over
`MISSING`; the observation detail records bounded per-call classifications.

Only an all-OK turn uses the first call's valid reason in native call order for
the one visible projection. Other valid calls are still validated and stripped,
but never create additional reasoning items or terminal lines.

## 10. One-turn aggregation and client projection

The assistant turn, not the individual chunk, is the aggregation boundary. A
parallel tool turn lists the actual tool names once and uses the first valid
reason in native tool-call order:

```text
调用工具 <tool_name>[、<tool_name>...]：<reason>
```

There are no quotation marks, forced “because”, confidence, model ID, debug
label, JSON, or fence in client-visible reasoning. Phase 1 projects a normal
visible reasoning item accepted by the entry protocol. Phase 2 private reasoning
is future work.

Provider-native reasoning and Tool-Thinking reasoning are two independent
canonical semantic items. Native reasoning remains byte-identical and in its
original canonical order. Resp03 creates at most one separate Tool-Thinking
item and places it immediately before the first native tool-call item of that
turn; it never uses native reasoning text as source or suppresses/deduplicates
it. A client protocol that exposes only one scalar reasoning field may encode
the two canonical items into that field with its registered deterministic
delimiter; that wire encoding does not merge their authorization or identity.

The synthetic item is identified only by typed request-local Resp03 result state.
Visible IDs such as `rcc_reason_*`, textual prefixes such as `调用工具`, marker
characters, and ordinary reasoning content are not identity and cannot authorize
creation, replay, suppression, or deduplication.

| Client entry | Required normal projection |
|---|---|
| Responses JSON | one separate `reasoning` output item immediately before the first tool-call item |
| Responses SSE | one registered reasoning-item event sequence, closed before the first native tool-call terminal event |
| OpenAI Chat JSON | keep native `message.reasoning_content` as the first segment; when non-empty append exactly `\n` and the Tool-Thinking text, otherwise use only the Tool-Thinking text |
| OpenAI Chat SSE | after all native reasoning deltas and before the first buffered tool-call delta, emit exactly one additional `reasoning_content` delta |
| Anthropic JSON | after all native thinking/redacted-thinking blocks and before the first `tool_use`, insert one ordinary unsigned `thinking` block containing the Tool-Thinking text |
| Anthropic SSE | before the first buffered `tool_use`, emit one complete unsigned `thinking` lifecycle: start, one `thinking_delta`, stop; emit no synthetic `signature_delta` |

No protocol adapter recognizes the text of this item. It receives a typed
Resp03 projection result and performs only the registered client-protocol
encoding.

## 11. Streaming contract

The execution plan already knows the entry protocol, provider protocol, and
Direct/Relay path before response consumption. The corresponding typed adapter
is selected once from those facts. For an enabled turn, the registered adapter
holds every native tool-call frame until the existing protocol terminal closes
the assistant tool turn. It does not change terminal recognition. Native text
and native reasoning continue through their normal path; no tool-call frame may
reach the client before Resp03 has finalized the whole turn, because doing so
could leak reserved fields or authorize projection before a later invalid
parallel call is known.

- OpenAI Chat: buffer `tool_calls[].function.arguments` by call index until a
  complete JSON object exists and retain the exact assembled argument bytes.
- Responses: consume complete function/custom call items or their registered
  argument/input delta events, retaining exact argument/input bytes.
- Anthropic: buffer `input_json_delta.partial_json` by content-block index and
  close at the native block/turn terminal; non-stream JSON decoding must retain
  the raw `tool_use.input` object bytes before generic `Value` conversion.
- Gemini: pass through unchanged.

At the existing turn terminal, the adapter gives the ordered complete native
items and their exact parameter bytes to Resp03 once. Resp03 returns the ordered
native items (redacted per valid call or untouched per rejected call) plus one
typed terminal result. The adapter then performs only registered protocol
encoding: optional synthetic reasoning first, followed by native tool calls in
their original order. Adapters do not validate fields, choose status, format
reasoning, emit observations, or switch parsers based on response content.
Generic SSE framing does not change. A partial fragment is never emitted as a
fabricated redacted object.

## 12. Observability

Each observed assistant tool turn emits exactly one terminal line:

```text
TOOLREASON OK        stage=<owner> session_id=<canonical> request_id=<canonical> tool=<names> confidence=<0-100> thinking=<bounded reason> model=<id>
TOOLREASON MISSING   stage=<owner> session_id=<canonical> request_id=<canonical> tool=<names> confidence=<missing> thinking=<missing> model=<missing>
TOOLREASON INVALID   stage=<owner> session_id=<canonical> request_id=<canonical> tool=<names> detail=<bounded classification>
TOOLREASON MISPLACED stage=<owner> session_id=<canonical> request_id=<canonical> tool=<names> detail=<bounded classification>
```

The same turn may additionally emit a separate bounded `PROJECTED` diagnostic,
but terminal status counting remains exactly one. Canonical identities come from
the existing request scope. They are never generated, inferred, or repaired by
this feature.

Dry-run evidence is side-channel only and records the same request ID across:

```text
client raw request
-> Req04 governed request
-> provider-bound request
-> provider raw response
-> complete native tool-call item
-> Resp03 status/redaction
-> client projection
```

## 13. Transparency and failure safety

- No injected schema, guidance, reserved field, fence, raw JSON, debug label, or
  control state reaches the client in a conforming tool call.
- Missing/invalid auxiliary data cannot create 400, 500, 502, panic, SSE
  truncation, tool-name corruption, call-ID corruption, duplicate reasoning, or
  command mutation.
- Native provider failures continue through the existing Error chain.
- No provider-specific branch is added to Hub or Chat Process.
- Legacy fence text is never a Tool-Thinking source and never authorizes `OK` or
  reasoning. The final implementation has no legacy marker parser, sanitizer, or
  projection path. Ordinary or historical text is not rewritten.

## 14. Evidence that selected this design

Same-request production evidence:

```text
openai-responses-router-gpt-5.5-20260823T004943173-925485-193
```

proved:

1. the final OpenAI Chat `exec_command` schema contained required `reason` and optional diagnostics
   fields;
2. the final `apply_patch` custom-to-function wrapper contained and required only
   `input`;
3. the provider raw `exec_command` arguments contained only `reason` in the
   polluted long session;
4. strict non-projection behavior correctly refused to invent confidence/model;
5. the current Relay response converter would discard custom wrapper fields by
   keeping only `input` before Resp03.

Fresh direct-provider A/B used the same first real system message, all 14 real
tools in their original order, a new user turn, and forced `apply_patch`:

| Variant | Successful calls | Complete valid fields |
|---|---:|---:|
| complete required schema + compact guidance | 10/10 | 10/10 |
| same schema + repeated full guidance | 10/10 | 10/10 |
| compact guidance + nonempty model schema without exact enum | 10/10 | 10/10 |

The full repeated guidance did not improve auxiliary-field adherence. The
observed production gap is final schema loss, not insufficient guidance length.
With no exact model enum, model IDs were `x-preview-f-free` in 2/10 and the
model's self-ID `ox-alpha` in 8/10; all were non-empty. These curls are diagnostic
evidence only, not RCC acceptance.

## 15. Required code ownership

Semantic owners:

- request compiler and schema/custom wrapper builder:
  `hub_v1/servertool_hooks.rs`;
- strict validator, redactor, turn aggregator, custom restorer, reasoning
  projector, and terminal observation:
  `hub_v1/resp_chat_process_03_governed.rs`.

Typed plumbing only:

- Direct request/response hook context and registered SSE consumer;
- Relay request outcome / response hook profile;
- protocol normalizers that must preserve complete native parameter containers.

The existing implementation contains semantic work in the wrong owners. The
following relocation is mandatory; preserving both old and new paths is
forbidden:

| Current symbol / behavior | Required final behavior | Final owner |
|---|---|---|
| `V3DirectProtocolCodec::prepare_before_send` invokes Req04 inside the provider-attempt loop | move contract compilation before the first attempt; retries reuse the same governed payload and immutable context | Direct request hook skeleton carrying Req04 output |
| the Responses-specific direct kernel separately invokes `V3ResponsesDirectCodec::prepare_before_send` | consume the same precompiled Req04 output; do not invoke injection a second time | Direct request hook skeleton |
| `project_openai_responses_custom_tools_to_function_schema` adds Tool-Thinking fields | retain only protocol-shape projection; never add auxiliary fields | ReqOutbound protocol projector |
| `normalize_openai_chat_custom_tool` and `openai_chat_freeform_custom_tool_parameters` add Tool-Thinking fields | retain only mechanical custom-to-function projection when Tool-Thinking is disabled; when enabled, preserve the Req04-compiled function schema byte-for-byte | ReqOutbound protocol projector |
| `build_v3_responses_function_call_from_openai_chat_tool_call` / `parse_v3_openai_chat_custom_tool_input` extract only custom `input` | with matching typed provenance, preserve the complete wrapper object until Resp03; inspect no auxiliary field | OpenAI Chat RespInbound normalizer |
| `anthropic_tool_use_as_responses_call` requires an `input`-only wrapper and extracts it before Resp03 | with matching typed provenance, preserve the complete Anthropic input object until Resp03; inspect no auxiliary field | Anthropic RespInbound normalizer |
| Direct/Relay contexts carry only `tool_thinking_enabled: bool` | carry the immutable `V3ToolThinkingTurnContext`; do not reconstruct custom provenance from payload | registered Direct/Relay hook plumbing |
| any legacy fence parser or ordinary reasoning/thinking scanner authorizes Tool-Thinking | remove authorization path physically; only explicit top-level JSON keys in the complete native parameter object reach the strict validator | Resp03 |
| JSON response mapping merges Tool-Thinking text into the first provider-native reasoning item | preserve every native reasoning item unchanged and insert one separately typed Tool-Thinking reasoning item before the first tool call | Resp03 projector |
| SSE logic scans legacy text/fence markers, pending message text, `rcc_reason_*`, or `调用工具` to discover/replay/deduplicate Tool-Thinking | remove these semantic scans physically; emit only from the validated typed turn result selected by the registered path context | Resp03 registered stream projector |

Protocol normalizers may select a preservation shape from typed provenance, but
they must not validate, redact, restore, format, observe, or project. Resp03 is
the only stage allowed to read the three reserved field names from a response.
ReqOutbound is not allowed to call a Tool-Thinking schema helper. Direct retries
are not allowed to call the Req04 compiler.

Forbidden owners:

- HTTP handlers and server response builders;
- generic SSE transport/state machines;
- provider health, routing, retry, Error policy, or continuation;
- MetadataCenter or protocol metadata;
- static tool registries;
- provider-specific Hub branches.

## 16. Test design

### 16.1 Req04 white-box

- disabled identity;
- structured schema extension without changing native fields or order;
- idempotent full/compact guidance;
- custom tool wrapper preserves exact free-form input contract;
- typed custom provenance never serializes into payload;
- Gemini unchanged;
- no tools unchanged;
- provider-bound OpenAI Chat, Responses, and Anthropic schemas retain required
  `reason` and optional diagnostics after protocol conversion.
- Direct first attempt and same-provider/provider-switch retries contain one
  guidance append and one unchanged compiled schema;
- Direct-to-Relay handoff recompiles from the untouched captured client request,
  not from the Direct-governed payload.

### 16.2 Resp03 white-box

- valid three-field object authorizes one projection and removes reserved keys;
- missing, partial, wrong type, empty, range, duplicate, misplaced, malformed,
  and incomplete cases never authorize projection;
- duplicate reserved keys are detected from retained native parameter bytes and
  never collapse into first-wins or last-wins success;
- explicit reserved keys do not leak from a complete recognized container;
- ordinary reasoning/thinking/text containing the same words is not a source;
- native command, input, tool name, call ID, status, and finish reason survive;
- generic custom tool restoration is provenance-gated and byte-preserves input;
- multiple tools create one turn status and at most one reasoning item.
- a parallel turn is `OK` only when every eligible call is valid; mixed valid and
  missing/invalid calls produce one deterministic non-OK status and no reasoning;
- custom restoration succeeds for `OK`, `MISSING`, and `INVALID` auxiliary
  statuses whenever typed provenance and a valid string `input` are present;
- malformed custom wrapper or non-string `input` is never guessed, restored, or
  converted to success;
- an identical three-field object in ordinary reasoning/text never authorizes
  redaction, restoration, observation, or projection;
- native reasoning remains byte-identical and ordered while Tool-Thinking is a
  separate item immediately before the first native tool call;
- `rcc_reason_*`, `调用工具`, marker characters, and matching visible text never
  authorize or suppress projection.

### 16.3 Protocol/SSE black-box

- Responses JSON and SSE;
- OpenAI Chat JSON and SSE;
- Anthropic JSON and SSE;
- Direct and Relay equivalence;
- custom wrapper survives request projection and reaches Resp03 complete;
- no adapter performs a second parse or strips fields early;
- Gemini negative control;
- stream fragments split inside every reserved field and inside native input.
- provider raw response, RespInbound output, Resp03 output, and client projection
  are asserted separately so pre-Resp03 field loss cannot be hidden by a final
  smoke result;
- the synthetic reasoning item closes before the first native tool-call terminal
  event, while provider-native reasoning may precede both and remains unchanged;
- repeated native reasoning and prefix/ID collisions do not cause duplicate or
  swallowed Tool-Thinking projection.

### 16.4 Architecture gates

- resource, function, mainline, verification, and module maps agree;
- real call edges are adjacent and registered;
- typed provenance is absent from provider/client payload snapshots;
- no generic SSE or Server path changed;
- no legacy fence prompt/parser is active;
- no fallback/guess/sanitizing parser exists outside Resp03.

## 17. Formal RCC acceptance

After worktree tests and architecture gates pass, integrate into the latest
`main`, build and install the exact source hash, use only managed
`routecodex restart`, and verify all configured listener health. Do not use port
4444 for functional Tool-Thinking requests.

Required entry matrix:

- port 7777: Responses Direct, Responses Relay, OpenAI Chat Relay;
- port 10000: actually enabled Anthropic Direct/Relay paths;
- current active non-Gemini providers only.

For every applicable protocol/provider/path combination, open fresh real Codex
sessions and collect at least 10 consecutive tool turns. Curl remains diagnostic
only.

Machine-counted acceptance metrics:

1. terminal observation coverage: 100%, exactly one per tool turn;
2. complete valid model contract: 10/10 per fresh window;
3. valid reserved-field removal: 100%;
4. valid reasoning projection: 100%, at most once per turn;
5. missing/invalid native-field protection: 100%;
6. custom input restoration: 100%;
7. duplicate projection, silent observation loss, reserved-field leakage from
   valid calls, and proxy-authored guidance/fence/debug leakage: zero;
8. feature-caused 400/500/502, panic, SSE truncation, tool mapping/name/call-ID or
   native argument corruption: zero.

Every sampled turn must correlate the exact canonical session ID and request ID
across raw inbound, provider-bound request, provider raw response, complete native
tool item, Resp03 terminal observation, and client projection.

## 18. Implementation order and completion boundary

1. Update architecture maps and typed resource relationships to this design.
2. Add red tests for the final custom wrapper schema and pre-Resp03 field loss.
3. Add the typed request-local custom provenance carrier.
4. Make Req04 wrap custom tools and compile one stable contract.
5. Make protocol projections preserve the contract; remove duplicate injection.
6. Make RespInbound02 preserve complete custom-wrapper arguments.
7. Make Resp03 validate, redact, aggregate, restore custom tools, and project.
8. Bind Direct and Relay through the existing hook skeleton without generic SSE
   changes.
9. Run focused tests, full V3 build, install, managed restart, and formal RCC
   samples.
10. Only after all online gates pass: DSH Review, targeted commit, and push.

The feature remains incomplete while any final provider-facing tool schema lacks
required `reason`, any provider-complete object is lost before Resp03,
any valid turn fails client reasoning projection, or any observed tool turn lacks
one canonical terminal status.

## 19. Independent JSON v2 closeout addendum (2026-08-23)

This addendum is the execution contract for the current isolated worktree. It
does not authorize a merge, commit, or modification of `main`. It deliberately
keeps JSON v2; it does not reopen the abandoned turn-fence v3 experiment.

### 19.1 Target and scope

- Worktree: `/Users/fanzhang/Documents/github/routecodex/playground/tool-thinking-json-v2-closeout-20260823`.
- Functional server: a standalone build of this worktree on port `10000`.
- Production ports `7777` and `4444` are negative controls only; they must not
  receive Tool-Thinking functional requests.
- The active production config must not contain a `10000` server. The standalone
  test config may contain exactly one isolated `10000` server.
- Feature enablement and client projection are server-scoped. A global manifest
  flag is not evidence that a request on this server is governed.

### 19.2 Required implementation behavior

1. Req04 is the only injection owner. It receives the final provider-bound
   native tool list, compiles one request-local JSON v2 contract, injects the
   exact wire model id, and does not mutate system/developer/history ordering,
   native names, native schemas, or native arguments except for the declared
   request-local auxiliary contract.
2. Resp03 is the only semantic response owner. It reads explicit `reason`,
   `goal_alignment_confidence`, and `model_id` fields from the completed native
   tool-call argument object. `reason` authorizes Phase 1 projection;
   confidence/model are optional diagnostics. It never reads ordinary reasoning/thinking/text,
   labels, console output, tool descriptions, request IDs, or model guesses.
3. In Phase 1, a correctly typed non-empty `reason` authorizes one normal
   reasoning-content item even when the optional diagnostics are absent or the
   observed model id differs. Recognized auxiliary fields are stripped from a
   valid object and `confidence`/`model_id` remain console-only diagnostics;
   none are sent to the client.
4. Missing or malformed `reason`, malformed present diagnostics, duplicated,
   misplaced, or otherwise unrecognized fields leave the native tool call and
   all native arguments untouched and produce exactly one terminal
   `MISSING`/`INVALID`/`MISPLACED` observation for the governed turn. No
   fallback, repair, inferred value, second parser, or ordinary reasoning
   capture is allowed.
5. A turn with multiple native tool calls is aggregated once: one terminal
   observation and at most one projected reasoning item. Provider retries and
   protocol fragments must not create repeated observations or projections for
   the same canonical request/turn.
6. Direct and Relay use the same Req04 builder and Resp03 parser. Protocol and
   SSE layers only deliver typed completed items/fragments and terminal context;
   they do not parse, strip, infer, project, or add a provider-specific branch.
7. Native function, custom/free-form, server, and MCP tool name, call id,
   arguments/input/command/patch and finish semantics remain byte/semantic
   equivalent. `apply_patch` is a mandatory positive sample. Gemini and a
   disabled server are mandatory negative controls.

### 19.3 Required diagnostic evidence

For every tested transaction, write a dry-run or redacted evidence record that
correlates one canonical `session_id` and `request_id` through these adjacent
stages:

```text
raw client request
  -> Req04 governed provider-bound tool list
  -> provider raw request/response
  -> completed protocol item
  -> Resp03 result
  -> client projection
```

The record must show tool name, wire model, auxiliary-field presence and
validity, terminal status, projection count, native-payload identity, and any
HTTP/SSE/mapping error. A console line without the preceding and following
correlated evidence cannot establish root cause. Model non-compliance is a
measured result, not permission to guess or rewrite the response.

### 19.4 Verification sequence

1. Refresh resource/function/mainline/verification maps and the local
   collaboration run record; verify the unique Req04/Resp03 owners and inspect
   all current dirty changes before editing.
2. Add red tests for server-scoped enablement, exact model validation, missing
   and malformed fields, duplicate observations, multi-tool aggregation,
   custom `apply_patch`, native-payload identity, and no projection of natural
   reasoning. Then make only the unique hook owner green.
3. Run focused Rust tests and `cargo check`; resolve every failure or classify
   it with a reproducible pre-existing cause. No red test may be reported as a
   pass.
4. Build and install the isolated release artifact, record source/build
   hashes, and start only the standalone `10000` server from that artifact.
   Verify `/health` and the absence of `10000` from the production aggregate.
5. Run fresh-session black-box groups: at least 10 Anthropic/MiniMax
   transactions, 10 OpenAI Chat transactions, and 10 Responses transactions
   wherever the isolated server has an applicable route. Include single-tool,
   multi-tool, custom `apply_patch`, missing-field, malformed-field, and
   provider-retry cases. Direct/Relay must be tested separately when available.
   Curl is diagnostic only; it cannot replace a real Codex business sample.
6. For each group, calculate rather than eyeball: Req04 coverage, provider raw
   field presence, valid/missing/invalid/misplaced rates, exact model match,
   one terminal status per turn, projection rate for valid turns, native
   identity, duplicate count, leakage count, and 400/500/502/panic/SSE/tool
   mapping failures.
7. Re-run the failing production-shaped samples that motivated this work, then
   perform the module-boundary and no-fallback scans. Any code change after a
   build or online sample invalidates that evidence and requires the affected
   gates to run again.

### 19.5 Completion criteria

Completion means the isolated `10000` build has a reproducible evidence bundle
showing all applicable paths are wired to Req04 and Resp03, valid JSON v2
responses are fully stripped and project only `reason`, native tool calls are
unchanged, and every governed turn has exactly one terminal observation. The
model's JSON v2 adherence rate must be reported honestly; it is not required to
be 100%, but every non-conforming response must be classified without mutation
or fallback. Duplicate/missing observations caused by proxy plumbing, client
leakage, native-payload corruption, feature-caused HTTP/SSE/mapping failures,
and panics must be zero.

The handoff must include changed paths, exact source and binary hashes, test
commands/results, per-protocol statistics, representative raw-to-client
correlations, unresolved risks, and explicit confirmation that `main` was not
modified. Do not run DSH Review, merge, push, or claim production completion
from this isolated task; those are separate gates after an authorized
integration.

### 19.6 Phase 1 acceptance override (2026-08-23)

For the first production iteration, `reason` is the only required model field.
`goal_alignment_confidence` and `model_id` are optional diagnostics: the
request guidance may describe them and Req04 may expose their schema, but
Resp03 must not reject, repair, infer, or block projection because either is
absent or differs from the expected value. When present and well-typed they
are logged only, then discarded with the other internal fields.

Phase 1 passes the model-adherence gate when at least 50% of applicable
governed tool turns contain a valid non-empty `reason` and those valid reasons
are correctly projected once into client reasoning content. This is a rate
gate, not a permission to mutate failures: every remaining turn must still
produce one accurate terminal `MISSING`/`INVALID`/`MISPLACED` observation and
leave the native call untouched. The 50% gate does not waive zero-tolerance
requirements for parser miswiring, duplicate observations, leakage, native
payload changes, or feature-caused protocol/runtime failures.
