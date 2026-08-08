# V3 OpenAI Chat Anthropic SSE Terminal Closeout Fix Design

```yaml
design_id: v3-openai-chat-anthropic-sse-terminal-closeout-20260808-r4
debug_id: bug_id:v3_4444_openai_chat_sse_terminal_truncation
approval_state: approved_by_jason_2026-08-08
base_commit: c1dcf6e36a26f4648643f3eace926244e8cfb671
goal: >-
  Enforce three separate owners. SSE transport handles only standard framing,
  bytes, EOF, cancellation, and transport errors. Provider/client protocol
  codecs handle their own standard event fields and registered semantic
  projection. Runtime only sequences adjacent typed nodes. No layer may infer
  business or control state from SSE framing, EOF, [DONE], event ordering, or
  request/response text. OpenAI Chat semantic termination is
  choices[].finish_reason=stop; data: [DONE] is only its transport sentinel.
request_control_rule: >-
  Routing, switching, continuation, retry, health, provider selection,
  MetadataCenter, stopless, and servertool state must not be inferred from
  messages, input, prompt, instructions, tool text, image contents, or
  historical turns. Route selection consumes only registered typed current-turn
  route facts supplied by the owning boundary.
current_turn_rule: >-
  Routing observes the current request turn only. Historical request items
  cannot create, restore, or alter route/control facts.
sse_boundary_rule: >-
  The V3 SSE module preserves standard fields and opaque data, including
  [DONE], and reports transport outcomes only. It does not parse event names or
  data JSON for terminal, required_action, failure, routing, retry, or control
  semantics.
protocol_codec_rule: >-
  A registered adjacent provider/client codec may parse its own standard event
  schema and perform an explicitly mapped semantic projection. Unsupported or
  malformed standard protocol data fails at that codec. EOF and [DONE] never
  invent semantic fields.
root_cause:
  first_divergence_node: >-
    SSE closeout and runtime orchestration currently participate in protocol
    semantic terminal decisions instead of passing standard frames to the
    registered provider/client codec owners.
  unique_owner: >-
    Provider/client codec edges own standard event decoding and semantic
    projection. V3 SSE owns only transport framing/outcomes. Runtime owns only
    adjacent typed-node sequencing. The typed route-fact boundary separately
    owns current-turn facts and never reconstructs control from payload text.
  positive_intervention_evidence: >-
    Existing source contracts already register V3 SSE as opaque transport and
    keep provider/client semantics outside it. The prior isolated experiment
    remains diagnostic evidence only; it does not authorize a runtime-side
    terminal rule.
  reverse_intervention_evidence: >-
    Required reverse controls are: changing only [DONE] or EOF cannot create a
    finish_reason; changing only historical request content cannot change route
    facts; malformed provider events fail at the codec owner; transport remains
    unaware of those semantic failures.
  ruled_out:
  - V3 SSE transport as a semantic terminal owner
  - server handler/SSE/outbound compensation
  - Virtual Router deriving provider protocol from entry/exit or payload text
  - request messages or history as a control-state source
  - [DONE], EOF, ordering, or response text as semantic inference sources
current_flow:
  - provider transport yields standard SSE frames
  - protocol-neutral SSE transport decodes standard frame boundaries
  - runtime currently parses frame data and participates in terminal decisions
  - provider/client protocol semantic ownership is therefore duplicated in orchestration
proposed_flow:
  - V3ProviderRespInbound01Raw preserves selected provider protocol and raw stream shape
  - V3 SSE yields opaque standard frames without semantic inspection
  - adjacent provider codec parses only its registered standard event schema
  - V3HubRespInbound02Normalized produces canonical Chat response semantics
  - Resp03 and Resp04 govern and commit canonical semantics
  - Resp05/client codec projects OpenAI Chat response semantics
  - OpenAI Chat finish_reason=stop is semantic terminal; [DONE] is only the protocol transport sentinel
  - Server transports frames and reports only transport lifecycle outcomes
  - route classification consumes explicit typed current-turn facts only
data_structure_changes:
  - none
architecture_impact:
  data_plane: unchanged
  control_plane: unchanged
  metadata_center: unchanged
  module_boundaries: changed_with_owner_registration
  owner_registration: >-
    Register the provider/client codec edge and typed current-turn route-fact
    boundary before implementation. Keep route classifier, protocol codecs,
    SSE transport, and runtime orchestration as separate owners.
allowed_paths:
  - v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs
  - v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs
  - v3/crates/routecodex-v3-route-classifier/src/active_turn.rs
  - v3/crates/routecodex-v3-runtime/src/nodes.rs
  - v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs
  - docs/architecture/v3-resource-operation-map.yml
  - docs/architecture/v3-function-map.yml
  - docs/architecture/v3-mainline-call-map.yml
  - docs/architecture/v3-verification-map.yml
  - docs/architecture/wiki/mainline-call-graph.md
  - docs/architecture/manifests/v3.openai_chat_relay.controlled_runtime.mainline.yml
  - docs/goals/v3-openai-chat-anthropic-sse-terminal-closeout-fix-design.md
forbidden_paths:
  - v3/crates/routecodex-v3-server/**
  - v3/crates/routecodex-v3-virtual-router/**
  - v3/crates/routecodex-v3-provider-responses/**
  - provider configuration and ~/.rcc/**
  - handler/SSE transport compensation
  - history, continuation, request payload, response payload, or metadata cleanup
non_goals:
  - no routing behavior based on messages/input/prompt text or history
  - no entry/exit protocol coupling through VR
  - no SSE transport semantic parsing or terminal inference
  - no use of [DONE] or EOF as semantic completion evidence
  - no request-message reverse inference of control state
  - no fallback, retry, silent strip, or provider-health compensation
required_verification:
  - focused red -> green architecture test proving SSE transport does not parse event names or data JSON
  - codec tests for standard provider event -> canonical Chat -> OpenAI Chat finish_reason projection
  - reverse tests proving [DONE]/EOF cannot invent finish_reason or success
  - route negative tests proving history and business text cannot change control route facts
  - current-turn tests proving only registered typed facts affect route classification
  - OpenAI Chat same-protocol JSON/SSE regression
  - OpenAI Chat -> Anthropic JSON/SSE protocol parity and exact live replay
  - module boundary, resource relation, function map, mainline call map, verification map, and architecture gates
  - stable cargo fmt, clippy, workspace tests, and V3 CLI build
  - global install, config check, one managed aggregate restart, all listener health checks
  - Codex architecture review only after installed-runtime evidence
exact_replay:
  endpoint: http://127.0.0.1:4444/v1/chat/completions
  protocol: openai_chat_sse
  provider_protocol: anthropic
  model: minimax_anthropic.MiniMax-M3
  request_id: openai-chat-router-minimax_anthropic.MiniMax-M3-20260808T024627588-715034-1242
experiment_artifacts_not_for_merge:
  - /private/tmp/routecodex-exp-entryexit-sse-20260808
```

## Architecture Review Findings

### P0: Runtime Owns SSE Semantic Decisions

`openai_chat_relay_runtime.rs` currently parses `data`, decodes provider JSON,
tracks terminal state, enforces `[DONE]` ordering, and requires `[DONE]` at EOF.
Those are mixed concerns. The runtime may sequence typed transport and codec
results, but it must not infer protocol semantics from raw SSE frames.

Required repair:

1. Keep `routecodex-v3-sse` opaque and protocol-neutral.
2. Move provider-event parsing and validation to the registered adjacent
   provider protocol codec.
3. Move OpenAI Chat event projection, `finish_reason`, and its standard
   transport sentinel contract to the OpenAI Chat codec edge.
4. Keep Server and runtime closeout limited to transport lifecycle and typed
   codec outcomes.

### P0: Request Payload Reconstructs Route Facts

`routecodex-v3-route-classifier/src/active_turn.rs` and
`routecodex-v3-runtime/src/nodes.rs` currently scan `messages`, `input`,
`prompt`, user text, historical tool calls/results, image contents, and tool
declarations to derive route classifications/capabilities. This directly
conflicts with the rigid rule that request messages cannot reconstruct control
state and routing observes only the current turn through registered typed
facts.

Required repair:

1. Define a typed current-turn route-fact carrier at the owning entry/Req edge.
2. Do not pass raw request history or business text to Virtual Router as
   control truth.
3. Keep explicit protocol data such as requested model and current-turn media
   shape in their registered data-plane facts; do not classify free text or
   historical tool content into route/control state.
4. Delete superseded payload-scanning inference after proving all callers and
   tests have migrated to the typed owner. No compatibility fallback remains.

### P1: Current Maps Register The Wrong Boundary

The active `vr.route_classifier` map says it consumes
`request.normal_payload` and the V3 OpenAI Chat runtime map assigns SSE
incremental projection to Runtime. Before implementation, update the resource,
function, mainline, verification, manifest, and generated wiki contracts so
the machine truth reflects the corrected owner boundaries. A runtime patch
without these map changes is architecture-invalid even if focused tests pass.

## Fix Sequence

1. Freeze formal implementation under r4 approval gate; preserve the prior
   experiment as evidence only.
2. Add red architecture tests for transport semantic parsing and payload-derived
   route/control inference.
3. Update machine maps and review surfaces to declare the typed current-turn
   route-fact carrier and provider/client codec SSE edges.
4. Implement the clean fix in a new worktree from the approved base. Remove the
   old inference paths physically; do not layer a second path beside them.
5. Run focused positive/reverse tests, module/resource/mainline gates, build,
   global install, aggregate restart, all-port health, exact live replay, and
   only then Codex architecture review.

## Approval Gate

Jason approved this exact r4 design on 2026-08-08. Implementation is
authorized only for this scope, after the resource/function/mainline/
verification contracts and red tests are updated. The prior r3 approval is
superseded.

Approval record:

```text
批准 design_id=v3-openai-chat-anthropic-sse-terminal-closeout-20260808-r4
```
