# V3 Tool-Thinking JSON Contract Design

Status: implementation_in_progress_pending_live_replay
Date: 2026-08-21
Feature: `v3.tool_thinking_hook_skeleton`

This document is the canonical design contract for the feature. It replaces the
former `<toolreason>...</toolreason>` fence contract. Code changes are forbidden
until this document and the three V3 architecture maps agree with this contract.

## 1. Objective and non-goals

When `tool-thinking` is enabled, the request Chat Process adds a provider-facing
instruction explaining that every model tool call should carry three auxiliary
fields in the tool-call's native parameter JSON object:

- `reason`: short motivation for this tool call;
- `goal_alignment_confidence`: integer from 0 through 100, measured against the
  user's current-turn goal;
- `model_id`: the model identifier used for this response.

The response Chat Process observes these fields, records bounded diagnostics,
removes only these auxiliary fields before client projection, and projects one
visible `reasoning_content` item per turn during Phase 1. The original tool name,
call id, argument/input object, result, finish reason, and ordinary content remain
semantically unchanged.

The request hook extends each non-Gemini provider-facing tool schema with these
required observability properties. The model places them in the native parameter
container; Resp03 removes them before execution and client projection. This
feature does not change executed commands, add a public protocol field, add a
pipeline node, reject missing fields, use a fence as the current
contract, infer a reason from user/history/tool text, or change routing/retry/
health/continuation/Stopless/provider policy.

## 2. Contract version and authority

The contract is versioned as `tool_thinking_json_v2`. Authority order:

1. this document;
2. the `v3.tool_thinking_hook_skeleton` entries in the V3 architecture maps;
3. the Rust Chat Process hook and fixtures;
4. provider/client black-box evidence.

Any source, test, prompt, or evidence that treats a raw `<toolreason>` marker as
the primary contract is stale. It must be removed or explicitly marked legacy
before implementation starts. A passing old-fence test cannot qualify the JSON
implementation.

## 3. Model-facing request contract

The guidance is injected at the final provider-facing tool-list surface after
ordinary tool governance and before provider wire encoding. It must explain:

```text
For every tool call, put the tool-reason fields in the tool's parameter JSON
object. They are observability metadata, not execution parameters; the proxy
removes them before execution and client projection.
reason: one short phrase stating only why this tool is needed now.
goal_alignment_confidence: integer 0-100 comparing this call with the user's
current-turn goal; 100 means directly required, 0 means unrelated.
model_id: the exact model id used for this response.
If several tools are called in one assistant turn, provide one object per call.
Do not emit a fence, commentary, or a second textual explanation.
```

Positive OpenAI-style function call:

```json
{
  "name": "exec_command",
  "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"
}
```

Positive Anthropic/Gemini-style native call:

```json
{
  "name": "exec_command",
  "input": {"cmd": "pwd", "reason": "确认当前工作目录", "goal_alignment_confidence": 100, "model_id": "x-preview-f-free"}
}
```

Fields outside the parameter container are invalid-placement diagnostics only;
the native tool call continues unchanged and cannot cause 400/502.

```json
{"name":"exec_command","reason":"..."}
{"name":"exec_command","arguments":"{\"cmd\":\"pwd\"}","toolreason":"..."}
{"name":"exec_command","arguments":"{\"cmd\":\"pwd\"}","toolreason":"..."}
```

Invalid placement is an auxiliary-field classification only. The native tool
call continues unchanged; it must not cause 400/502 or mutate the command.

## 4. Protocol shape matrix

| Protocol | Native tool-call object | Native argument field | Auxiliary-field location |
|---|---|---|---|
| OpenAI Chat | `tool_calls[].function` or canonical function object | `arguments` | JSON value inside `arguments` |
| OpenAI Responses | `function_call` item | `arguments` | JSON value inside `arguments` |
| Anthropic | `content[].type=tool_use` | `input` | object inside `input` |
| Gemini | excluded from this contract | `args` | no injection |
| Relay canonical Hub | canonical tool-call object | canonical native input | canonical input object |

The logical contract is identical across protocols. Codecs only normalize native
shape. Tool-reason harvest, field stripping, association, and reasoning
projection belong to Resp03. Direct and Relay use the same semantic extractor.

## 5. Request lifecycle and owner

```text
ReqInbound02 standardized
  -> ReqChatProcess03/04 normal tool governance
  -> tool-thinking JSON guidance hook
  -> final provider-facing tool list
  -> ReqOutbound05 / provider wire codec
```

The request hook is idempotent and runs once per current turn. It appends the
canonical guidance and required fields to the final provider-facing tool schema.
It may not create a sibling tool surface, rewrite request shape, or inject values
into a command. Direct and Relay bind to this same hook; no
provider-specific prompt branch is allowed.

Node contract:

```text
Node: ReqChatProcess tool-thinking request hook
Owner: Rust Chat Process request governance
Input: current-turn governed tool list + feature manifest + model id
Output: same tool list with one canonical JSON guidance block
Normal: native declarations and arguments are byte/semantic stable
Error: unsupported placement is explicit diagnostic; no invalid provider payload
Unexpected: duplicate guidance is not added; no fence guidance is emitted
Blackbox: provider request contains JSON contract and no primary fence contract
```

## 6. Response lifecycle and owner

```text
ProviderRespInbound01 raw
  -> RespInbound02 protocol parse/normalization
  -> RespChatProcess03 tool-call harvest
  -> one-turn aggregation + auxiliary-field stripping
  -> reasoning_content projection
  -> RespOutbound04 / client frame
```

Resp03 inspects the provider-originated tool-call parameter container after the
native shape is known and before client projection. It must not search arbitrary text for fields,
or interpret normal model `thinking`/`reasoning` as tool-reason data. Only fields
inside the native parameter container qualify.

Node contract:

```text
Node: RespChatProcess03 tool-thinking extractor/projector
Owner: Rust Chat Process response governance
Input: normalized provider response + same-turn hook scope
Output: native tool call without auxiliary fields + one reasoning item
Normal: preserve name/call id/input/arguments; map one turn once
Error: malformed auxiliary data is diagnostic-only; native call survives
Unexpected: misplaced/partial/duplicate/provider-wrapper variation is classified
Blackbox: client sees no auxiliary fields and receives at most one projection
```

Supported imperfect output cases are: complete fields; missing fields; null,
empty, wrong-type, or out-of-range values; partial streamed assembly; multiple
tool calls; repeated chunks; all native protocol wrappers; and legacy fence input
only as compatibility evidence.

## 7. Field semantics and compatibility policy

`reason` is valid only as a non-empty string in the current tool-call parameter
container (`input`, JSON `arguments`, or `args`).
`goal_alignment_confidence` is valid only as an integer in 0..100. `model_id` is
valid only as a non-empty string. A model-id mismatch is diagnostic-only.

| Input condition | Tool call | Diagnostic | Client reasoning |
|---|---|---|---|
| all valid | strip auxiliary fields only | `JSON OK` | one mapped item |
| fields missing | native call survives | `JSON MISSING` + field list | map only valid reason |
| wrong type/range | native call survives | `JSON INVALID` + field list | no guessed value |
| fields outside the parameter container | native call survives | `JSON MISPLACED` | no projection from misplaced data |
| duplicate streamed observation | native call survives | count once | no duplicate projection |
| no qualifying tool object | ordinary response path | no tool-reason event | no projection |
| legacy fence only | native call survives after legacy redaction | `LEGACY_FENCE` | compatibility only if unambiguous |

The current turn is the aggregation boundary. Multiple calls may be listed in one
sentence, but the feature emits at most one synthesized reasoning item:

```text
调用工具 <tool_name>[、<tool_name>...]：<reason>
```

No quotation marks, forced “因为”, confidence, model id, or fence is exposed.
Phase 1 uses visible `reasoning_content`; Phase 2 private projection is future
work and is not part of this implementation gate.

## 8. Hard stripping boundary

Only `reason`, `goal_alignment_confidence`, and `model_id` are stripped from a
recognized tool-call parameter container. The stripper must not recursively walk arbitrary
payloads or alter `name`, `call_id`, `id`, `type`, ordinary fields inside
`arguments`, `input`, or `args`,
`parameters`, tool results, ordinary text, native reasoning, status, or
continuation/history.

The client response must contain neither these auxiliary extensions nor a raw
legacy fence. This is a response projection rule, not request-side cleanup.

## 9. Observability contract

Diagnostics are side-channel only. Every qualifying tool call ends with exactly
one terminal observation:

```text
TOOLREASON JSON OK       stage=<resp02|resp03> tool=<name> alignment=<0-100> model=<id>
TOOLREASON JSON MISSING  stage=<resp02|resp03> tool=<name> missing=<fields>
TOOLREASON JSON INVALID  stage=<resp02|resp03> tool=<name> invalid=<fields>
TOOLREASON JSON MISPLACED stage=<resp02|resp03> tool=<name> field=<field>
TOOLREASON PROJECTED     stage=resp03 tool=<name>[,<name>] turn=<turn>
```

`OK` means valid fields were found. `PROJECTED` means the client semantic response
contains the synthesized reasoning item. These are independent facts.

## 10. Direct and Relay equivalence

Relay uses ReqChatProcess and RespChatProcess. Direct uses its registered
same-protocol request/response hook at the existing lifecycle boundary. Neither
path owns a second parser:

```text
provider raw object
  -> protocol-specific shape adapter
  -> shared tool-thinking extractor
  -> shared one-turn aggregator/stripper

## 11. Implementation and closeout plan: direct response observation

Status: closeout_required_after_live_stdout_evidence

### 11.1 Confirmed failure chain

The current failure is not provider non-compliance alone. The request-side
schema is present in the provider-bound request, but the direct SSE response
processor previously received hard-coded `false` values for
`tool_thinking_enabled` and `toolreason_client_projection`. Consequently the
Resp03 SSE consumer did not collect tool names, did not aggregate fields, and
did not emit a terminal MISSING observation. A second failure allowed a
Responses-only thinking-tag wrapper to wait for `response.completed` while the
actual provider stream was Chat or Anthropic shaped.

### 11.2 Required implementation

1. Pass the manifest-derived tool-thinking and client-projection flags from the
   direct response projection owner into the direct SSE consumer.
2. Keep the single Resp03 toolreason lifecycle for Responses, OpenAI Chat, and
   Anthropic streams. Protocol adapters may only expose native tool name and
   parameter chunks; they may not create a second extractor.
3. Handle Anthropic `content_block_start/content_block_delta/content_block_stop`
   in that shared lifecycle. Use `content_block.name` as the tool name and
   buffer only the native `input_json_delta` parameter object.
4. Make the Responses thinking-tag wrapper protocol-safe. It may rewrite only
   a real Responses stream; Chat and Anthropic frames must pass through without
   waiting for a Responses terminal event.
5. At stream close, emit exactly one `TOOLREASON MISSING` for a tool call with
   no valid auxiliary object. Never synthesize missing values and never turn a
   missing observation into success.
6. When the complete native parameter JSON is valid, strip only the three
   auxiliary fields and preserve the original command/tool arguments byte or
   semantically unchanged.

### 11.3 Mandatory file/owner review

Before code changes, verify the resource map, function map, mainline call map,
and verification map entries for:

- Req04 tool-thinking request hook;
- Resp03 toolreason extractor/aggregator/stripper;
- direct SSE consumer and protocol adapter;
- direct response compatibility wrapper;
- client reasoning projection.

The only owners allowed to change are the registered Rust Chat Process hooks
and the existing direct SSE hook skeleton. Do not add provider branches in the
router, handler, outbound codec, or client adapter. Do not add fallback,
request-side cleanup, arbitrary-text parsing, or a second response parser.

### 11.4 Verification matrix

| Gate | Required evidence |
|---|---|
| Unit | valid JSON, missing fields, wrong types/range, partial stream, duplicate chunks, multiple tools, native command preservation |
| Protocol | Responses SSE, OpenAI Chat SSE, Anthropic SSE; Gemini remains excluded |
| Request | same requestId raw inbound and provider-bound request show guidance plus required schema at the actual provider system/tool surface |
| Raw response | same requestId provider raw response identifies the real native tool object and exact auxiliary-field presence/absence |
| Resp03 | exactly one OK/MISSING/INVALID observation per turn; real tool name; no ordinary thinking/reasoning contamination |
| Client | no `reason`, `goal_alignment_confidence`, `model_id`, or fence leakage; at most one visible `reasoning_content` item per turn; original tool call remains executable |
| Negative | malformed or missing auxiliary fields never create 400/502, never mutate the command, never become guessed values, and never suppress the terminal observation |
| Runtime | `npm run build:v3`, `npm run install:v3`, managed `routecodex restart`, health 4444/7777/10000, then live replay with installed binary hash |
| Live | at least one real Codex sample per active direct/relay protocol path; evidence must bind requestId to raw request, provider request, raw response, client projection, and console observation |

### 11.5 Completion definition

The feature is complete only when all of the following are true:

- every qualifying live tool call produces exactly one terminal observation;
- a missing model field produces visible `TOOLREASON MISSING` in the managed
  process console with the real tool name;
- a valid model field set produces `TOOLREASON OK` with alignment and model id;
- the client receives one correctly formatted visible reasoning item only for a
  valid, recognized toolreason object;
- the client never sees auxiliary fields or legacy fences;
- Chat, Responses, and Anthropic direct/relay samples pass without 400/502
  caused by this feature;
- all evidence is from the rebuilt and restarted binary, not a resident old
  process;
- no code review, commit, or completion claim is made while any gate above is
  missing or inferred from source inspection alone.
  -> path-specific client projection
```

Direct SSE framing is transport only. It may not perform field extraction,
tool-name inference, fence detection, or reasoning construction.

## 11. Configuration and feature bundle

`tool-thinking` remains one compiled atomic hook bundle:

```text
tool-thinking.req04.json_guidance
tool-thinking.resp03.json_extract_strip
tool-thinking.resp03.turn_aggregate
tool-thinking.resp03.reasoning_project
```

Disabled mode preserves original behavior. Enabled mode binds all hooks together.
A partially compiled bundle is a manifest error; it must not silently enable only
request or response behavior.

## 12. Design gates before code

Before modifying Rust, synchronize this document with:

1. `docs/architecture/v3-function-map.yml`;
2. `docs/architecture/v3-mainline-call-map.yml`;
3. `docs/architecture/v3-verification-map.yml`;
4. `docs/goal-prompts/v3-tool-thinking-hook.md`;
5. JSON fixtures for OpenAI Chat, Responses, Anthropic, and Gemini;
6. one explicitly legacy-only fence fixture.

The design gate fails if any active contract or required test still says that a
fence is the primary request/response format.

## 13. Implementation and verification order

Implementation is blocked until Section 12 is complete. Then:

1. add red fixtures for object-level JSON fields and invalid placements;
2. implement one shared Resp03 extractor/stripper;
3. implement request guidance using this exact JSON contract;
4. bind Direct and Relay to the same semantic functions;
5. remove old primary fence prompt/parser/metrics, retaining only explicit legacy
   compatibility handling;
6. run focused Rust tests, architecture gates, and `git diff --check`;
7. build from current `main`, globally install, managed-restart, and verify all
   listeners;
8. replay real Codex samples and provider raw snapshots;
9. require every qualifying call to end in `JSON OK`, `JSON MISSING`,
   `JSON INVALID`, or `JSON MISPLACED`, plus an independent projection result;
10. only after runtime evidence is complete may review/commit proceed.

No 400/502 may be introduced by absent or malformed auxiliary fields. Native
argument/schema failures are a separate provider-wire contract failure and must
not be hidden by this feature.

## 14. Active closeout contract: hook-only session/request correlation

Status: `implementation_in_progress_pending_online_replay`

The only permitted product changes for the remaining defect are the existing
registered Chat Process tool-thinking hooks and the existing direct SSE hook
skeleton's typed context plumbing. SSE transport, frame decoding, terminal
event rules, queueing, error projection, provider adapters, handlers, and
outbound protocol code are read-only. If one of those layers is the cause,
stop and report the evidence; do not compensate there.

For every qualifying tool call, prove this exact same-request chain:

```text
outer request/session log
== provider-bound request snapshot
== provider raw response snapshot
== Resp03 hook observation
== client projection
```

The proof must use canonical `session_id` and `request_id` values. Do not
synthesize a session from a request ID, use `request-local-*` as a substitute,
or infer pairing from timestamp/order. Missing canonical context is a hard
diagnostic failure, not a reason to guess or fallback.

Required hook behavior:

- Direct and Relay enter the same semantic extractor through existing hook
  registrations; no second parser is added.
- Auxiliary fields are recognized only inside the native tool-call parameter
  container. Native model thinking/reasoning is never harvested as toolreason.
- Only `reason`, `goal_alignment_confidence`, and `model_id` are stripped from
  a recognized container. Native command/input/name/call-id and malformed tool
  calls remain unchanged.
- Every qualifying tool call ends with exactly one terminal `OK`, `MISSING`,
  `INVALID`, or `MISPLACED` observation carrying canonical IDs. Silent
  absence is a failed hook path.
- Client projection is a normal `reasoning_content` item only when fields were
  actually parsed in the native container. No fence, schema fields, raw JSON,
  or guessed reason may reach the client.
- Missing or malformed fields never alter the original tool call and never
  create a 400/502; they remain visible in console diagnostics.

Mandatory live gates:

1. Direct OpenAI Chat, Direct OpenAI Responses, Relay Responses/Chat, and
   Anthropic native tool calls; Gemini is a negative control and stays
   uninjected/unmodified.
2. Complete, missing-field, and malformed/partial samples for every applicable
   protocol.
3. Same-request raw inbound, provider-bound request, raw response, hook log,
   and client body/SSE correlated by exact IDs.
4. Client assertions: clean native tool arguments, no auxiliary fields,
   exactly one visible `reasoning_content` item per turn when valid, no native
   reasoning false positive, and no duplicate projection.
5. Failure assertions: no 400/502, no panic, no hook-introduced terminal-event
   requirement, and no silent missing observation when a qualifying tool call
   exists.

Run targeted tests, full V3 build, distribution install, managed restart, all
health checks, and live replay on the same source hash. Any new SSE framing or
terminal failure is evidence against the hook-only change and must be reported,
not fixed by changing SSE logic.

Completion requires every live qualifying sample to have exact request/session
correlation, a terminal observation, correct stripping, and correct client
projection; negative controls unchanged; build/install/restart on that same
hash; and evidence recorded. One working sample or source inspection is not
completion.
