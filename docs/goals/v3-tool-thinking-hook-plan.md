# V3 Tool-Thinking Hook Design and Implementation Plan

Status: Phase 1 implementation landed; live quality closeout and DSH Review pending.

Date: 2026-08-20

## 1. Objective

Add a config-driven `tool-thinking` Hook Skeleton feature for the V3 Chat Process.
The request hook adds a tool-use reason contract to the provider-facing tool list.
The response hook handles imperfect model output, maps a recovered reason to
`reasoning_content`, and removes the raw `<toolreason>` marker before the response
leaves Resp03.

Phase 1 exposes only the normalized `reasoning_content` to the client for quality
monitoring. The raw marker and proxy implementation details remain hidden.

Phase 2 keeps the same parser, recovery, association, and redaction logic, but
projects synthesized `reasoning_content` only into model continuation context.
The client projection omits the synthesized field.

The feature is a Hook Skeleton extension. It must not add a public protocol field,
change tool parameters, add a handler path, add a provider codec path, or create a
new mainline pipeline node.

## 2. Acceptance contract

The implementation is acceptable only when all conditions hold:

1. `tool-thinking` can be disabled without changing request or response payloads.
2. Enabled request hooks modify only legal tool description fields in the
   provider-facing tool list.
3. The detailed tool-reason contract is present in the injected tool description
   and does not mention RouteCodex, Proxy, hooks, private state, filtering, or
   implementation details.
4. Resp03 is the only semantic response owner for collecting, associating,
   normalizing, and redacting tool reasons.
5. A valid reason maps to exactly one sentence in `reasoning_content`:
   `调用工具 <tool_name>，因为 <reason>`.
6. Original tool name, call id, arguments, tool parameters, status, finish reason,
   and ordinary response content semantics remain unchanged.
7. Raw `<toolreason>` content never reaches the client, regardless of whether
   recovery succeeds.
8. Phase 1 exposes normalized `reasoning_content` for client monitoring.
9. Phase 2 uses the same normalized value as private model continuation content
   and omits the synthesized field from the client projection.
10. Malformed, incomplete, duplicated, missing, misplaced, and multi-tool output
    has deterministic behavior covered by positive and negative tests.
11. SSE, handler, inbound/outbound transport, provider runtime, and continuation
    transport do not parse or repair tool-thinking semantics.
12. No control state, parser status, recovery status, hook identity, or scope is
    written to normal request/response payload, provider metadata, client metadata,
    or tool arguments.

## 3. Scope

### In scope

- Static manifest registration of the tool-thinking hook bundle.
- Req04 injection into the final provider-facing tool list.
- Resp03 canonical response inspection after normalization and tool-frame repair.
- Robust extraction and bounded recovery of `<toolreason>`.
- Association of a reason with the current tool call.
- Normalization to `reasoning_content`.
- Hard removal of raw and confirmed malformed markers.
- Phase 1 visible reasoning-content projection.
- Phase 2 private continuation projection design and gate.
- Responses JSON, Responses SSE after canonical materialization, OpenAI Chat,
  Anthropic Relay, and Gemini Relay parity where their canonical Chat Process
  shape exposes a legal tool-description surface.
- Client/provider black-box tests and malformed-response fixtures.

### Out of scope

- Adding `toolreason` to tool parameters or function arguments.
- Adding a synthetic tool solely to carry the reason.
- Writing the reason to MetadataCenter control state.
- Parsing provider raw SSE in the SSE transport layer.
- Parsing user text, historical text, tool output, or tool arguments as reasons.
- Changing StoplessCenter, `reasoningStop`, `stop_schema`, or Stopless budgets.
- Changing provider selection, routing, retry, health, or error policy.
- Changing Direct into Relay or adding a fallback path.
- Rewriting client history or cleaning historical payloads.
- Enabling Phase 2 private projection before Phase 1 monitoring evidence exists.

Direct same-protocol paths that bypass Chat Process are not covered by this hook
bundle. They must not silently reroute to Relay. Direct support requires a separate
registered direct semantic hook with the same parser contract.

## 4. Architecture constraints

The feature follows the existing fixed Hook Skeleton:

```text
Config authoring
  -> V3Config05ManifestPublished
  -> static hook registry

Req03 continuation classified / restored
  -> Req04 normal tool governance
  -> Req04 tool-thinking description hook
  -> Req04 finalized provider-facing payload
  -> ReqOutbound / provider

Provider response
  -> RespInbound normalization
  -> Resp03 tool-frame repair
  -> Resp03 tool-thinking harvest / normalize / redact
  -> existing ordinary-tool and Stopless hooks
  -> Resp04 continuation commit
  -> Resp05 client projection
```

The hook may mutate the current node's borrowed payload view. It may not mutate
history before the current response is finalized, and it may not mutate the
save-to-restore immutable interval.

The parser's model semantic output is not control state. The following remain
control-side only:

```text
enabled
hook id
request/response scope
current turn identity
association confidence
recovery kind
malformed/missing counters
phase visibility policy
```

These values belong in typed hook resources or diagnostics. They must not enter
`reasoning_content`, `metadata`, tool arguments, provider options, or client body.

## 5. Config and manifest design

The authoring switch is initially a boolean feature flag:

```toml
[features]
tool_thinking = true

`tool_thinking` is the configuration key for the logical `tool-thinking` feature.
```

The compiler expands it into one atomic hook bundle. The runtime consumes the
compiled manifest and does not read TOML dynamically.

Logical bundle:

```text
tool-thinking.req04.tool_list_prompt
tool-thinking.resp03.harvest_normalize_redact
tool-thinking.resp04.visibility_projection
```

Phase policy is a manifest/profile decision, not a payload field:

```text
visible  -> Phase 1; synthesized reasoning_content is client-visible
private  -> Phase 2; synthesized reasoning_content is model-continuation-only
```

Only one visibility policy may be active for a hook set. An incomplete bundle,
unknown phase, or unsupported hook binding fails manifest validation. It must not
silently disable only one side of the lifecycle.

Required manifest declarations:

- fixed request node: `V3HubReqChatProcess04Governed`;
- fixed response node: `V3HubRespChatProcess03Governed`;
- commit visibility decision immediately before Resp04 canonical commit/client
  projection;
- allowed resource: current-node borrowed view;
- private projection resource for Phase 2;
- forbidden resources: provider transport, client payload, MetadataCenter control,
  SSE transport, handler, debug snapshot, and unrelated session state.

## 6. Request hook: tool-list injection

### Exact insertion point

Run after normal tool governance and all registered Stopless/servertool tool
declarations are finalized, before Req04 exits and before ReqOutbound builds the
provider wire payload.

The hook must be idempotent and must operate only on the current provider-bound
payload. Client-originated tool descriptions and historical descriptions remain
unchanged.

### Allowed payload targets

```text
Responses function/custom tool: tools[].description
OpenAI Chat function tool:      tools[].function.description
Canonical flat function tool:   tools[].description
```

Do not modify:

```text
name
type
parameters
function.parameters
strict
tool_choice
parallel_tool_calls
messages
instructions
input
metadata
arguments
```

For a tool type without a legal description surface, the hook registry must mark
that tool type unsupported. Do not fall back to `instructions`, add a fake tool,
or emit provider-invalid fields.

Exclude RouteCodex internal tools such as `reasoningStop`, `noop`, and internal
servertool bridges. Ordinary client/function/custom tools are eligible.

### Exact injected prompt contract

The implementation must keep one canonical prompt constant. Formatting changes
require fixture updates because the marker grammar is part of the response parser
contract.

Chinese contract:

```text
调用此工具前，先输出一个工具调用动机，格式必须是：
<toolreason>动机</toolreason>

格式规则：
- 只输出调用该工具的直接动机。
- 使用简洁、直接的短句；类似 caveman 风格。
- 每个工具调用只输出一个 toolreason。
- toolreason 必须位于对应工具调用附近。
- 不输出计划、步骤、推理过程、工具结果或任务总结。
- 不重复工具参数，不复制用户原文。
- 不输出 RouteCodex、Proxy、hook、注入、过滤、客户端或内部策略信息。
- 不在 toolreason 外增加工具调用说明。
- 没有明确动机时，仍只给最短、事实性的动机；不要编造结果。
```

English contract for English-model profiles:

```text
Before each tool call, output exactly one tool-call motive in this form:
<toolreason>motive</toolreason>

Format rules:
- State only the direct motive for calling this tool.
- Use a short, direct caveman-style sentence.
- Emit exactly one toolreason for each tool call.
- Keep the toolreason next to its corresponding tool call.
- Do not output a plan, steps, chain of thought, result, or task summary.
- Do not repeat tool arguments or copy the user message.
- Do not mention RouteCodex, Proxy, hooks, injection, filtering, client state,
  or internal policy.
- Do not add tool-call explanation outside the toolreason marker.
- If the motive is uncertain, state only the shortest factual motive; do not
  invent a result.
```

The model-visible contract intentionally describes normal tool behavior. It must
not reveal the proxy implementation or tell the model that the field will be
removed later.

## 7. Response hook: canonical processing

### Exact processing order

```text
1. Receive canonical Hub response after provider compatibility parsing.
2. Complete existing tool-frame normalization/repair.
3. Identify current assistant tool-call batches.
4. Collect toolreason candidates from allowed canonical text sources.
5. Associate candidates with current tool calls.
6. Normalize each accepted candidate to reasoning_content.
7. Redact raw and confirmed malformed markers from client-visible text.
8. Preserve all tool-call and protocol terminal semantics.
9. Produce the configured visible/private projection.
10. Return through the existing Resp03 outcome and existing Resp04 commit path.
```

Do not insert this logic in the Stopless state machine. The response hook runs at
the same Resp03 skeleton location, but tool-thinking and Stopless keep separate
state and evidence contracts.

### Accepted source locations

Only inspect the current canonical assistant response:

1. assistant content adjacent to the current tool-call batch;
2. assistant `reasoning_content` for the current response;
3. canonical reasoning blocks belonging to the current assistant response.

Never inspect user content, historical assistant content, tool output, tool
arguments, provider metadata, debug fields, or raw transport frames.

### Canonical mapping

Input:

```text
<toolreason>Need inspect config.</toolreason>
tool call: read_file
```

Output:

```text
reasoning_content:
  调用工具 read_file，因为 Need inspect config.
```

Existing model `reasoning_content` is preserved and the normalized sentence is
appended. It is never replaced by a guessed value.

Tool call name, id, arguments, parameters, status, finish reason, and ordinary
content remain semantically unchanged.

## 8. Imperfect-response recovery contract

Recovery is bounded and deterministic. It may recover an incomplete marker, but it
may not invent a motive or infer a motive from tool arguments/results.

| Input condition | Action | reasoning_content |
| --- | --- | --- |
| complete open/close tag | parse and bind | generate |
| missing closing tag | consume to current assistant/tool boundary | generate if unique |
| empty tag | redact | omit |
| whitespace-only tag | redact | omit |
| nested tags with one clear text candidate | unwrap once | generate |
| nested/duplicated tags with ambiguity | redact all confirmed markers | omit |
| reason/tool count mismatch | bind only unambiguous candidates | omit unmatched |
| reason after call in same batch | positional association if unique | generate if unique |
| reason in arguments | pass through arguments; do not parse | omit |
| reason in tool output | pass through tool output; do not parse | omit |
| no reason emitted | preserve tool call | omit |
| marker appears in user/history text | do not parse or strip | unchanged |
| parser error after marker boundary is known | redact marker span | omit |

Raw marker removal is mandatory even when recovery fails. The implementation must
avoid deleting unrelated normal text when the boundary is not established. If a
marker is malformed and its safe end cannot be determined, the hook must fail
explicitly at the owning Resp03 boundary rather than silently pass potentially
leaking text downstream.

## 9. Phase 1 visible projection

Phase 1 response example:

```json
{
  "content": "",
  "reasoning_content": "调用工具 read_file，因为需要读取配置文件",
  "tool_calls": [
    {
      "id": "call_1",
      "name": "read_file",
      "arguments": "{}"
    }
  ]
}
```

The client may inspect the normalized `reasoning_content`. It must not receive:

```text
<toolreason>...</toolreason>
tool-thinking enabled
recovery=...
association=...
hook=...
```

Phase 1 monitoring fields belong in ordinary internal diagnostics, not in the
client response.

## 10. Phase 2 private projection gate

Phase 2 is not part of the first implementation slice. It is enabled only after
Phase 1 evidence proves parser quality and client projection stability.

The normalized response has two views:

```text
ClientResponseProjection:
  normal response content
  original tool call
  no raw marker
  no synthesized reasoning_content

ModelContinuationProjection:
  normal response content
  original tool call
  synthesized reasoning_content
```

The private projection must be created before canonical continuation commit. It may
not be reconstructed in RespOutbound, SSE, handler, or the next ReqInbound pass.

If the existing Resp04 implementation shares one finalized payload between client
projection and continuation storage, the implementation must first add a
hook-owned private projection resource or equivalent existing skeleton capability.
Do not solve the split by adding an external response field or a second outbound
semantic implementation.

## 11. Lifecycle and ownership

```text
Config compile:
  feature flag -> atomic hook bundle

Req04:
  final tool list -> append canonical description contract

Provider:
  sees ordinary tool descriptions and emits toolreason

Resp03:
  canonical response -> collect -> associate -> normalize -> redact

Phase 1:
  normalized reasoning_content -> client projection + continuation

Phase 2:
  normalized reasoning_content -> model continuation only
  client projection omits it

Resp04:
  commit already-governed canonical continuation

Next Req04:
  restore model continuation without re-parsing or repairing the immutable interval
```

Potential private resource for Phase 2:

```text
resource_id:
  v3.tool_thinking.current_turn_reasoning_projection

identity:
  request_id
  session_id
  conversation_id
  port/server_id
  routing_group
  response_turn_id
  tool_call_id
  tool_name

writer:
  tool-thinking Resp03 hook only

readers:
  matching Resp04 commit / model-continuation projection only

forbidden:
  MetadataCenter control state
  provider transport
  client payload
  SSE
  handler
  debug snapshot
  unrelated session/tool
```

The reason text is model semantic data, not routing/control state. The resource
must nevertheless be typed, scoped, single-owner, and released at commit,
terminal, scope change, or error.

## 12. Stopless interaction

Tool-thinking response handling runs before the existing ordinary-tool/Stopless
branch at Resp03. It must not modify StoplessCenter.

If a response contains both a normal tool call and `reasoningStop`:

```text
normal tool call reason -> reasoning_content
reasoningStop           -> existing Stopless state machine
```

`toolreason` is never accepted as:

```text
stop_schema
reasoningStop evidence
next_step_prompt
Stopless completion evidence
```

Non-stop tool progress must retain the existing Stopless reset behavior.

## 13. Implementation file and map plan

Before runtime edits, bind the feature to the resource, function, mainline, module,
and verification maps. Expected owner surfaces:

| Concern | Expected owner surface |
| --- | --- |
| Config declaration/validation/compile | `v3/crates/routecodex-v3-config` |
| Static hook declaration | V3 Hub manifest/static hook registry |
| Req04 tool-list mutation | `v3/crates/routecodex-v3-runtime/src/hub_v1` Req04/servertool hook owner |
| Resp03 parser/association/redaction | `v3/crates/routecodex-v3-runtime/src/hub_v1` Resp03/servertool hook owner |
| Resp04 visible/private projection | existing Resp04 continuation owner plus declared hook resource |
| Canonical protocol parity | adjacent Hub protocol projection tests |
| Client monitoring evidence | Resp05/client projection black-box tests |

Do not create a new provider codec, server handler, SSE semantic parser, or
parallel tool-governance implementation.

## 14. Test design

### Request-side positive tests

- disabled flag leaves tools byte/semantic-equivalent;
- enabled flag appends the exact contract once per eligible tool;
- Responses and Chat description paths use the correct field;
- original tool parameters and choice remain unchanged;
- internal tools are not decorated;
- restored continuation does not duplicate the contract;
- provider-facing payload contains the contract, client-originating request does not;
- tool descriptions with existing contract remain idempotent.

### Response-side positive tests

- complete marker maps to the correct tool's `reasoning_content`;
- existing reasoning content is preserved and normalized reason appended;
- multiple tools map in stable order;
- marker is removed from content;
- tool calls and arguments remain identical;
- Phase 1 client payload exposes normalized reasoning_content;
- Stopless and ordinary tool calls remain independent.

### Response-side negative tests

- no marker does not synthesize a reason;
- empty marker does not synthesize a reason;
- missing close does not leak raw text;
- malformed marker does not swallow unrelated assistant content;
- duplicated marker is not copied to multiple tools;
- user/history/tool-output markers are not parsed or stripped;
- tool arguments are not parsed as reason;
- tool output is not parsed as reason;
- unbound reason is not assigned by guesswork;
- raw marker cannot reach client JSON or SSE;
- parser diagnostics cannot reach client payload or metadata;
- tool call semantics cannot be changed by recovery.

### Phase 2 gate tests

- client projection omits only synthesized tool-thinking reasoning;
- existing client-visible model reasoning remains intact;
- model continuation retains normalized reasoning_content;
- Resp04 save occurs after projection preparation;
- save-to-restore immutable interval performs no parsing, repair, or reconstruction;
- next Req04 consumes the already-governed continuation;
- private reason cannot cross session, port, group, conversation, or call id.

### Required verification categories

- config schema/manifest validation;
- static Hook Skeleton owner and fixed-node binding;
- resource ownership and side-channel isolation;
- request payload contract tests;
- response malformed-recovery tests;
- positive/negative protocol parity tests;
- client-facing JSON/SSE redaction tests;
- provider-facing request dry-run;
- Phase 1 live sample replay before any Phase 2 enablement;
- build/install/restart/live verification for runtime implementation;
- DSH review only after all required runtime evidence is complete.

## 15. Implementation sequence

1. Create feature/resource/function/mainline/verification map entries and bind exact
   owners and allowed paths.
2. Add red fixtures for tool-list prompt placement, response malformed recovery,
   raw-marker leakage, and wrong tool association.
3. Add config compilation and atomic hook registration with Phase 1 `visible`
   policy.
4. Implement Req04 description-only injection with exact-format/idempotence tests.
5. Implement Resp03 canonical response collector, bounded recovery, association,
   normalization, and hard redaction.
6. Implement Phase 1 visible `reasoning_content` projection.
7. Run focused tests, architecture gates, build, install, restart, and live replay.
8. Monitor real samples and classify parser quality: complete, recovered, missing,
   malformed, unbound, duplicate, and leaked.
9. Only after Phase 1 evidence is acceptable, design/enable the private projection
   resource and Phase 2 continuation split.
10. Re-run the full continuation immutability, protocol parity, client redaction,
    and live sample gates before Phase 2 rollout.

## 16. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Provider emits malformed marker | bounded recovery plus mandatory redaction |
| Marker appears in user/tool text | source restriction to current assistant response |
| One reason maps to multiple tools | call-batch association and no-copy rule |
| Reason leaks to client | Resp03 redaction and client projection tests |
| Reasoning content leaks control state | typed hook resource; no counters/scope in payload |
| Description injection changes provider validation | only legal description surface; target validation after projection |
| Stopless treats toolreason as stop evidence | separate parser and evidence types |
| Phase 2 changes continuation history | private projection must exist before Resp04 commit |
| Direct path bypasses Chat Process | explicit scope; no reroute/fallback |
| Streaming parser sees partial frames | parse canonical response after semantic materialization, not SSE transport |

## 17. Definition of Done

Phase 1 is done only when:

- config, maps, hook registration, and owner boundaries are active;
- exact tool-list injection is provider-facing and idempotent;
- Resp03 handles complete and imperfect model output with deterministic tests;
- raw markers never reach clients;
- normalized `reasoning_content` is client-visible for monitoring;
- tool-call semantics remain unchanged;
- architecture gates, build, install, restart, and live replay pass;
- evidence records contain focused, broad, and live results;
- no Phase 2 private claim is made without its projection/continuation gates.

Phase 2 is separately done only when:

- private model continuation projection is a declared owned resource;
- client and model views are proven distinct;
- Resp04 commit remains the continuation semantic owner;
- immutable interval tests pass;
- client redaction and model continuation live samples pass;
- Phase 1 visible monitoring can be disabled without changing parser behavior.
