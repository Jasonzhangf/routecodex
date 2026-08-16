# V3 Entry/Exit/VR Decoupling Architecture Remediation Plan

Status: approved_in_progress, 2026-08-08
Design ID: `v3-entry-exit-vr-decoupling-20260807-r1`
Owner feature: `v3.openai_chat_relay_runtime_integration`
Related feature: `v3.protocol_conversion_field_parity`

Architecture review correction: this plan is an implementation contract, not a
claim that the current dirty diff is correct. The current diff remains
incomplete until every item below is implemented and independently verified.
Jason approved this design id on 2026-08-08. Formal implementation may proceed
within the owner, resource, stage-shape, and live-verification boundaries below.

## 0. Approval Supersession

The SSE and route-fact portions of this plan are superseded by
`docs/goals/v3-openai-chat-anthropic-sse-terminal-closeout-fix-design.md`
design `v3-openai-chat-anthropic-sse-terminal-closeout-20260808-r4` and are
blocked pending Jason approval of that exact design.

The following corrections are rigid:

- SSE is transport only. It performs standard framing and transport lifecycle
  handling, but never infers semantic terminality, success, failure, routing,
  retry, continuation, or control state from event names, data JSON, EOF, or
  `[DONE]`.
- Provider and client protocol codecs parse their own standard event schemas
  and perform only registered adjacent semantic projection.
- OpenAI Chat semantic terminality is `choices[].finish_reason=stop`; `[DONE]`
  is a transport sentinel and never semantic evidence.
- Request messages, input, prompt, instructions, tool text, image contents, and
  historical turns must not be used to reconstruct routing or any other control
  state. Routing consumes explicit typed facts for the current turn only.
- The existing approved r1 scope does not authorize implementation that relies
  on the superseded SSE or payload-derived route-fact assumptions.

## 1. Goal And Acceptance

Remove the accidental coupling between the OpenAI Chat entry/exit path and the
Virtual Router/provider protocol. The entry protocol must only identify how the
client request is parsed and how the client response is projected. The VR must
only classify/select a route and concrete target. The selected target's typed
provider identity must determine provider wire protocol and the adjacent
provider request/response codecs.

Architecture clarification: entry and exit are not literally unrelated. The
client entry protocol determines the matching client response projection, and
VR may consume a registered `entry_protocol` routing fact when configuration
declares such a match. The forbidden coupling is different: entry protocol must
not imply provider wire protocol, provider wire protocol must not imply client
exit shape, and VR/Target must not own either protocol conversion.

Acceptance:

- OpenAI Chat entry can relay to an Anthropic wire target through the standard
  request and response lifecycle.
- Response validation and `RespInbound01` context use the selected provider wire
  protocol, never a hard-coded entry protocol or provider protocol.
- VR does not inspect or reconstruct entry/exit protocol semantics to choose a
  provider protocol; it returns target truth only.
- Provider protocol dispatch is centralized and typed; no provider-key/name
  special cases or duplicated transport builder remain in the OpenAI Chat
  runtime.
- JSON and SSE cross-protocol projection either preserve the registered semantic
  fields or fail explicitly at the owning adjacent codec. No fallback, silent
  strip, payload cleanup, or handler/SSE compensation is added.
- No RouteCodex control state is written to or reconstructed from normal
  request/response payload.
- The OpenAI Chat runtime has no dependency on a Responses-entry runtime for
  provider protocol or transport dispatch; shared protocol mechanics live in a
  protocol-neutral adjacent owner.

## 2. Scope And Boundaries

In scope:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs` only when an
  existing public adjacent projector must be exposed or its contract must be
  corrected
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_compat_shared.rs` as the
  protocol-neutral provider protocol/transport helper owner
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` only
  to remove its private ownership of shared protocol/transport helpers and call
  the neutral owner; do not make it a dependency of another entry runtime
- `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs` as the owner
  of OpenAI Chat provider validation and Responses/canonical-to-OpenAI-Chat
  client semantic projection
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs`
  only for the registered protocol-aware response compat edge; it must preserve
  the actual provider protocol in the raw node and cannot turn provider raw into
  client shape
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs`
  as the unique provider-response-wire to canonical Chat response conversion
  node, dispatching only by the typed selected provider protocol
- focused OpenAI Chat relay integration tests
- the affected feature/function/mainline/resource/verification maps and their
  generated review surface
- `provider_failure_runtime_policy.rs` only to remove the current unconditional
  debug output

Out of scope:

- changing VR route classification, pool precedence, health, retry, or provider
  selection policy
- changing entry protocol parsing or client response protocol contracts
- server handler, SSE transport, provider transport, continuation store, or
  MetadataCenter changes
- provider-specific branches in Hub/VR/RequestExecutor
- configuration, credentials, global install, restart, or production cutover
  before source and architecture gates pass
- fallback, downgrade, candidate scanning as a substitute for selected-target
  truth, or compatibility repair after an error

Required owner bindings before implementation:

- `v3-resource-operation-map.yml`: `v3.hub.entry_protocol`,
  `v3.hub.provider_protocol`, `v3.request.provider_semantic`,
  `v3.hub.provider_wire_payload`, `v3.response.provider_raw`,
  `v3.hub.response_semantic`, `v3.response.client_payload`
- `v3-function-map.yml`: `v3.openai_chat_relay_runtime_integration` and
  `v3.protocol_conversion_field_parity`
- `v3-mainline-call-map.yml`: `v3.openai_chat_relay.controlled_runtime`,
  especially edges `v3-openai-chat-relay-06` through
  `v3-openai-chat-relay-17`
- `v3-verification-map.yml`, module registry, and the generated OpenAI Chat
  relay wiki/manifest

## 3. Architecture Contract

The only valid mainline is:

```text
OpenAI Chat client input
  -> ReqInbound01/02/03/04
  -> ReqExecution05
  -> VR/Target concrete selected candidate
  -> provider protocol derived from selected candidate.provider_type
  -> ReqOutbound07
  -> Provider Compat06/Provider Wire08/Transport09
  -> Provider RespInbound01
  -> provider-protocol response codec
  -> Hub RespInbound02/RespChatProcess03/RespContinuation04
  -> client-entry response projector
  -> RespOutbound05/ServerRespOutbound06
```

Invariants:

1. `V3HubEntryProtocol::OpenAiChat` is valid at the client input boundary and
   client-output projection boundary only. It must not be used as a substitute
   for selected provider protocol.
2. `V3HubProviderWireProtocol` is derived from the concrete selected target,
   not from the entry, endpoint, provider key, provider name prefix, or response
   shape.
3. The JSON/SSE response orchestration receives entry protocol and selected
   provider protocol as separate typed axes. It must validate provider raw with
   the provider codec and build `V3ProviderRespInbound01RawContext` with the
   selected provider protocol; it must not run the OpenAI Chat provider
   validator on Anthropic/Responses/Gemini wire.
4. Anthropic wire responses must first use the existing Anthropic adjacent
   projector at `V3HubRespInbound02Normalized` to canonical Chat semantics, then
   use the OpenAI Chat client projector at Resp05. The OpenAI Chat runtime may
   orchestrate node transitions but must not implement either semantic
   conversion or move it into the handler.
5. SSE framing remains transport behavior. Semantic conversion belongs to the
   provider response codec/runtime owner; the server only transports returned
   frames.
6. A missing or unsupported protocol mapping is an explicit error. It must not
   retry through another protocol or convert the error into a successful client
   response.
7. Shared selected-target protocol derivation and provider transport dispatch
   belong to `provider_compat_shared.rs`; they cannot be owned by
   `responses_relay_runtime.rs`, because that couples OpenAI Chat entry execution
   to a Responses-entry runtime.
8. Provider raw must enter `V3ProviderRespInbound01Raw` with its actual selected
   provider protocol. Converting Anthropic raw directly into an OpenAI Chat
   client response before Resp01 and then relabeling it as OpenAI Chat provider
   raw is forbidden.
9. Cross-protocol SSE remains incremental. Full stream materialization before
   the first client frame is forbidden even when the final semantic output is
   correct.
10. `ProviderRespCompat02ProviderCompat` preserves provider response wire shape.
    The only provider-wire to canonical Chat conversion point is
    `V3HubRespInbound02Normalized`, as locked by
    `v3.stage_protocol_shape_contract`. It must retain typed entry/provider
    protocol axes while replacing only the payload shape with canonical Chat.
11. `V3HubRespChatProcess03Governed` and
    `V3HubRespContinuation04Committed` consume only canonical Chat response
    semantics. They must not branch on raw Anthropic/OpenAI/Gemini payload
    shape. `V3HubRespOutbound05ClientSemantic` is the sole canonical Chat to
    entry-protocol client projection point.

## 4. Current Review Findings To Fix

### P0: response projector hard-codes provider protocol

Current `openai_chat_relay_runtime.rs::project_json_response` passes
`V3HubProviderWireProtocol::OpenAiChat` to both
`validate_v3_openai_chat_provider_response_payload` and
`V3ProviderRespInbound01RawContext::new`. This rejects or mislabels a selected
Anthropic wire response after the request path correctly selected Anthropic.

Repair by making the provider protocol an explicit parameter and routing the
response through the owner appropriate for that protocol. Do not make the
entry protocol dynamic to conceal this defect.

The deeper defect is ordering: the current Anthropic JSON branch first calls
`project_anthropic_json_as_openai_chat_response`, producing final client shape,
then feeds that value to Resp01 as if it were OpenAI Chat provider raw. The fix
must preserve actual Anthropic provider truth at Resp01, canonicalize at the
`V3HubRespInbound02Normalized` edge, run Resp03 and Resp04, and only then project
the finalized semantic response to OpenAI Chat at Resp05. Do not place semantic
conversion in `ProviderRespCompat02ProviderCompat`; that node is wire-shape
compatibility only.

### P0: shared dispatch is owned by another entry runtime

The current OpenAI Chat runtime calls
`provider_wire_protocol_for_selected_candidate` and
`build_v3_provider_transport_request_for_protocol` from
`responses_relay_runtime.rs`. Although their internal direction is correct,
their owner is not: an OpenAI Chat entry runtime must not depend on a Responses
entry runtime to reach a provider. Move or extract this shared behavior into the
registered protocol-neutral `provider_compat_shared.rs` owner, then make both
entry runtimes consume it. The helper's input may be a selected Target10
candidate; its output must be typed protocol/transport request data and must not
include entry-specific runtime error types.

### P0: Anthropic SSE is fully materialized

`project_anthropic_sse_as_openai_chat_stream` currently calls
`materialize_v3_provider_sse_as_canonical_response`, waits for the complete
Anthropic stream, and only then creates OpenAI Chat frames. This violates the
controlled OpenAI Chat runtime's first-frame-before-terminal contract and makes
SSE semantic conversion a batch repair. Replace it with an incremental adjacent
codec/transducer that preserves terminal, usage, text/reasoning, and tool-call
deltas and emits `[DONE]` only after a valid terminal event.

### P1: protocol conversion logic is in runtime orchestration

The new `project_v3_openai_chat_response_from_responses_semantic` and
`project_v3_openai_chat_sse_events_from_responses_semantic` functions implement
field-level conversion inside `openai_chat_relay_runtime.rs`. Move this semantic
projection into `openai_chat_codec.rs` (or another registered protocol projector
owned by `v3.protocol_conversion_field_parity`). The runtime should only
orchestrate adjacent typed nodes and failure policy.

### P0: canonical response node is currently only a wrapper

The active stage contract says `V3HubRespInbound02Normalized` converts
`provider_response_wire -> canonical_chat_response`, but the current builder in
`resp_inbound_02_normalized.rs` only wraps `ProviderRespCompat02ProviderCompat`
without changing the payload. This discrepancy allowed Resp03 to branch on
provider wire shapes and reject Anthropic outright. Implement the declared node
contract with typed protocol dispatch and update its tests/maps before treating
cross-protocol behavior as complete. This is a contract repair, not a new
shortcut helper in a relay runtime.

### P1: unconditional runtime debug output

Remove the current unconditional `[RESOLVE-TRACE]` `eprintln!` in
`provider_failure_runtime_policy.rs`. Runtime logs are evidence only and cannot
become a second routing owner. Do not replace it with another unconditional
print or a provider-specific diagnostic branch.

### P2: stale local transport/import surface

After the typed shared transport dispatch is bound, remove only imports and
symbols proven unused by the compiler and function map. The deleted local
OpenAI-only transport builder must remain deleted; do not restore it as a
wrapper.

### P1: architecture gate is stale and over-broad

`verify-v3-openai-chat-relay-runtime-integration.mjs` still requires the deleted
OpenAI-only transport builder and therefore rejects the shared typed dispatch.
It also rejects the identifier
`is_metadata_center_local_search` without distinguishing a typed control-resource
read from a forbidden normal-payload field. Update the gate to require the real
selected-target protocol helper/transport dispatch and to scan actual payload
leak patterns precisely. Do not weaken the MetadataCenter isolation rule.

### Compilation status at plan creation

`cargo +stable check -p routecodex-v3-runtime --lib --manifest-path v3/Cargo.toml`
currently completes with warnings. The earlier all-target run was observed once
failing on a concurrent moved-value edit and once succeeding after the worktree
changed; all-target compilation must therefore be rerun from a stable base
before implementation claims. Warnings and the above architecture findings
remain open; this is not a completion claim.

## 5. Implementation Steps

1. Refresh `.agent-collab` according to `.agent-collab/PROTOCOL.md`; claim the
   feature and record the current dirty-worktree boundary. Do not overwrite
   unrelated changes.
2. Re-read the five V3 maps, the OpenAI Chat relay plan/test design, protocol
   parity design, and the VR target protocol execution SOP. Confirm every new
   call is an adjacent registered edge before editing.
3. Add or confirm red tests for: selected Anthropic target from OpenAI Chat
   entry, actual provider protocol at Resp01, response context protocol
   mismatch, pre-Resp01 client projection, cross-entry runtime imports, and SSE
   first-frame-before-terminal. Red tests must fail for the current defects and
   must not weaken existing same-protocol tests.
4. Move shared selected-target provider protocol derivation and transport
   dispatch to `provider_compat_shared.rs` with a neutral error contract. Update
   Responses, OpenAI Chat, and any other relay callers that currently own a
   duplicate dispatch branch; then delete the old Responses-runtime helper.
5. Parameterize the JSON response lifecycle with the selected typed provider
   protocol. Feed raw provider shape and protocol into Resp01, preserve wire
   shape through ProviderRespCompat02, canonicalize at
   `V3HubRespInbound02Normalized`, govern/commit through Resp03/Resp04, and
   project client protocol only at Resp05.
6. Move field-level OpenAI Chat client projection out of runtime orchestration
   into the registered protocol codec owner. Reuse existing Anthropic and
   Responses canonical projectors; do not duplicate parser/conversion logic.
7. Replace Anthropic SSE materialization with an incremental cross-protocol
   projector. Preserve message text, reasoning, tool-call delta identity,
   finish reason, usage, error, terminal, and `[DONE]` ordering. Unsupported
   events fail at the codec owner.
8. Remove the unconditional debug print and stale imports/functions. Keep
   `provider_failure_runtime_policy` responsible for policy only; it must not
   gain protocol projection behavior.
9. Update function/mainline/verification/resource documentation and generated
   manifest/wiki only after the real symbols and call edges exist. Mark all
   runtime gates active only when they actually execute in package/build entry.
10. Update the OpenAI Chat relay architecture gate in lockstep with the real
   shared typed transport symbol and precise payload-leak patterns. Preserve a
   red mutation proving a real `metadata_center` payload field is rejected.
11. Perform the post-edit architecture self-review against owner paths, forbidden
   paths, adjacent edges, provider/payload separation, fallback denylist, and
   entry/exit/VR hard-code scans before functional verification.

## 6. Verification Matrix

Source and focused behavior:

- `cargo +stable check -p routecodex-v3-runtime --tests --manifest-path v3/Cargo.toml`
- `cargo +stable test -p routecodex-v3-runtime --test openai_chat_relay_runtime_integration --manifest-path v3/Cargo.toml -- --nocapture`
- focused positive and negative JSON/SSE cross-protocol projection tests
- a timing test proving the first cross-protocol SSE client frame is observable
  before provider terminal
- same-protocol OpenAI Chat JSON/SSE regression tests
- `git diff --check`

Architecture and maps:

- `npm run verify:v3-openai-chat-relay-runtime-integration`
- `npm run test:v3-openai-chat-relay-runtime-integration-red-fixtures`
- `npm run verify:v3-protocol-conversion-field-parity`
- `npm run test:v3-protocol-conversion-field-parity-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-cargo-fmt`
- hard-code/fallback/silent-failure architecture gates applicable to this feature

Broader verification after focused gates are green:

- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
- `CARGO_NET_OFFLINE=true cargo clippy --manifest-path v3/Cargo.toml --workspace --all-targets -- -D warnings`
- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml --workspace -- --nocapture`

Runtime closeout, only after source and architecture gates:

- build/install the declared global RouteCodex artifact
- use the aggregate `routecodex restart --port <locator-port>` identity once
- verify all configured member ports with `/health`
- replay an old OpenAI Chat same-entry sample and a real cross-protocol sample
- record installed build identity, SHA, health, request id, and response evidence

Review gate:

- run `codex-review` only after the above source, build, install/restart, health,
  and online replay evidence exists
- any code/test/config change after PASS invalidates PASS and requires the
  affected verification and a new review

## 7. Risks And Explicit Non-goals

- Do not infer provider protocol from `choices`, `content`, SSE event names, or
  an error message. The selected target is the sole protocol source.
- Do not make VR depend on the OpenAI Chat runtime or client exit projection.
- Do not let Anthropic conversion bypass Resp01/Resp02/Resp03/Resp04 or let
  response outbound repair a malformed provider response.
- Do not add a fallback from Anthropic to OpenAI Chat or from one selected target
  to another after response projection failure.
- Existing unrelated dirty changes are not reverted, reset, checked out, or
  included in this task's commit.
- Do not keep shared provider dispatch under an entry-specific runtime merely
  because it is already implemented there; that preserves the coupling this
  task exists to remove.

## 8. Completion Signal

The implementation is complete only when the selected-target-driven protocol
path passes focused positive/negative tests, all required architecture gates,
global install/restart/health, old-sample online replay, and an independent
Codex architecture review with an unambiguous PASS verdict. Otherwise report
the exact failed gate and remaining risk.

## 9. Mandatory Architecture Review Record

Pre-implementation verdict: **FAIL**. Implementation is blocked until the red
tests and owner bindings in Sections 2-6 are established. The current dirty
implementation violates the active architecture contract in these places:

- OpenAI Chat response orchestration hard-codes the provider protocol instead
  of carrying selected-target truth into Resp01.
- Anthropic JSON is projected to client shape before Resp01, so provider raw
  truth and the adjacent response-node order are lost.
- `V3HubRespInbound02Normalized` does not yet implement its registered
  `provider_response_wire -> canonical_chat_response` conversion contract.
- Provider SSE compatibility materializes and relabels provider wire data;
  Anthropic-to-OpenAI Chat SSE is not incremental.
- Shared provider protocol and transport dispatch are owned by a
  Responses-entry runtime, creating a forbidden entry-runtime dependency.
- Field-level client projection remains in runtime orchestration rather than
  the registered protocol codec owner.

Required post-implementation review: repeat the module/resource/call-edge
audit against the actual diff before functional gates, then run independent
Codex review only after install, aggregate restart, health checks, and online
same-protocol plus cross-protocol replay. A functional PASS cannot override an
architecture FAIL.

## 10. Test Design Binding

This remediation uses the existing controlled-runtime and protocol-parity test
designs as the baseline; it does not create a second semantic owner:

- `docs/goals/v3-openai-chat-relay-runtime-integration-test-design.md` remains
  the project black-box owner for one Req01-Req09 and Resp01-Resp06 lifecycle,
  first-frame timing, Error01-06, and side-channel rejection.
- `docs/goals/v3-protocol-conversion-field-parity-test-design.md` remains the
  field-level codec owner for cross-protocol semantic mappings and explicit
  unmapped-field failures.
- New tests in this slice must be placed in the existing OpenAI Chat relay
  integration test surface or the adjacent protocol codec test surface. They
  must bind to the following evidence cases:

| Case | Positive evidence | Reverse/negative evidence | Owning boundary |
| --- | --- | --- | --- |
| Selected target protocol | OpenAI Chat entry selects Anthropic target and sends `/v1/messages` | selected protocol is not inferred from entry or response shape | Target -> Provider Compat dispatch |
| Resp01 truth | raw Anthropic JSON/SSE retains `provider_protocol=Anthropic` | client-shaped OpenAI Chat payload cannot be accepted as Anthropic raw | ProviderRespInbound01Raw builder |
| Resp02 conversion | Anthropic/OpenAI Chat/Responses raw converts to canonical Chat | provider wire fields do not reach Resp03 as an unconverted shape | RespInbound02 codec dispatch |
| Resp05 projection | canonical Chat projects to OpenAI Chat client response | Resp03/Resp04 cannot emit client protocol shape early | OpenAI Chat client codec |
| SSE lifecycle | first client delta is observable before provider terminal | `[DONE]` before terminal and incomplete terminal fail explicitly | Provider response codec/transducer |
| Control isolation | typed control carrier survives outside payload | `metadata_center`, routing, retry, continuation, debug fields fail at owning boundary | Req/Resp codec boundary |

Tests must assert typed node protocol fields and payload shape separately. A
passing client response alone is insufficient evidence because it can be
produced by the forbidden pre-Resp01 conversion path.
