# V3 SSE transport / JSON semantic decoupling audit

status: implementation_live_verified_codex_review_blocked_mixed_worktree
feature_id: v3.sse_protocol_codec_projection_boundary
owner_feature_id: v3.sse_protocol_codec_projection_boundary
date: 2026-08-12

## Verification snapshot (2026-08-12)

- Direct SSE focused tests: green (15/15).
- Responses provider SSE tests: green (6/6).
- SSE transport core and websocket projection tests: green (8/8 and 2/2).
- Architecture gates and workspace build: green.
- Global install, aggregate `routecodex restart`, four configured `/health`
  checks, and same-entry `/v1/responses` live replay: green on `0.90.4297`.
- Full runtime lib aggregate: 384/385 passed; the one
  `exact_pin_capability_revision_mismatch_stays_out_of_provider_failure_gate`
  failure passed when rerun alone, so aggregate test stability remains open.
- Workspace test compilation now passes after the H1 fixture was aligned with
  the current `V3DebugManifest` contract. Full workspace tests still stop at
  the unrelated `h2_p6_controlled_replay` live fixture (`node trace header`).
- MCP review `sse-json-decoupling-20260812-r2` is `FAIL`: one Error06
  projection-contract finding and one unrelated provider-compat long
  `call_id` finding. No PASS is claimed.

- Relay JSON-authority tests now cover mismatched opaque event labels for both
  `response.failed` and `response.completed`.

## Decision

1. SSE is transport-only. It may decode bytes, lines, fields, frame boundaries,
   limits, idle, backpressure, disconnect, and EOF. It must not classify
   provider/client business events.
2. All business, error, terminal, retry, reroute, health, availability,
   continuation, tool, and client projection decisions consume parsed JSON or
   a typed result produced by the provider JSON codec.
3. `event:` is opaque transport metadata. It is not a semantic source of truth.
4. `data: [DONE]` is opaque non-JSON data. It never creates success or terminal
   truth. EOF without a JSON semantic terminal is a provider codec failure.
5. Client first-frame commit is a hard control boundary. Before commit, a
   provider JSON failure may enter Error/health/selection and cause reselect.
   After commit, it may close the current stream and update provider health, but
   it must not reroute or rebuild the current client response.

## Current first divergence

The first confirmed owner violation is the direct runtime SSE path:

- `v3/crates/routecodex-v3-runtime/src/shared.rs:343-400`
  `direct_sse_frame_provider_failure_source` reads the SSE `event` field,
  parses provider JSON, and decides whether the client stream starts.
- `v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs:37-158`
  validates the SSE event name against JSON `type` and classifies
  `response.failed`, `response.incomplete`, and `response.completed` in the
  runtime/kernel layer.
- `v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs:161-182`
  records a post-commit provider stream failure into provider health/action
  state.
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs:638-663`
  turns that post-commit observation into session provider failure and action
  failure, which can affect later availability/selection.

The health/availability side-channel itself is allowed. The violation is that
provider protocol semantics and client stream lifecycle are decided in the
runtime/kernel path, and the post-commit cut cannot be proven by the current
tests.

## Log interpretation

The observed `provider-unavailable` line is a control/observability projection,
not proof that the provider error was copied into the client response body:

```text
provider JSON/SSE semantic failure
 -> provider failure session health
 -> availability projection
 -> target selection excludes cc-sol
 -> opencode-go is selected
 -> server console prints provider-unavailable
```

The single line does not carry a client-first-frame timestamp, so it cannot
prove whether the failure happened before or after client commit. A future
diagnostic record must expose that boundary explicitly; this audit does not
invent chronology from the log.

## Why existing gates missed it

`docs/architecture/v3-verification-map.yml` still marks
`v3.sse_protocol_codec_projection_boundary` as `status: design`, and the
corresponding SSE call-map edges remain `binding_pending`. Existing tests cover
provider failure and reselect before client stream commit, transport framing,
and `[DONE]` not being synthesized as success. They do not lock the reverse
case: JSON is authoritative when `event:` disagrees, and a provider failure
after client commit cannot reroute or rewrite the current client response.

The server comment at
`v3/crates/routecodex-v3-server/src/executors.rs:419-427` claims client/provider
connection decoupling, but that only covers keepalive/background execution. It
does not establish protocol-semantic or post-commit control-plane decoupling.

## Transport exceptions that remain valid

The following cannot be delayed until JSON because they are transport facts:

- malformed SSE framing;
- incomplete frame/UTF-8 or oversized line/frame;
- idle timeout, disconnect, and EOF;
- data-field concatenation.

They must remain transport outcomes. A provider JSON codec may use them to
produce a typed provider failure, but no transport outcome may be silently
converted to `response.completed`, success, or client reroute.

## Required implementation boundary

```text
provider bytes
 -> SSE transport decoder
 -> opaque validated frames
 -> data bytes
 -> provider JSON codec
 -> typed provider semantic outcome
 -> Hub response / Error chain / health side-channel
 -> client protocol projection
 -> client SSE encoder
```

Forbidden shortcuts:

- `event:` name -> business decision;
- `[DONE]` or EOF -> success;
- runtime/kernel -> provider business event parser;
- server/SSE layer -> provider error classifier;
- post-commit provider failure -> current-request reroute/rebuild.

## Implementation state

The first implementation slice is now present:

- `hub_v1/provider_sse_json_codec.rs` owns provider Responses JSON parsing and
  typed semantic outcomes.
- Direct initial gating and direct stream outcome no longer read `event:` and
  no longer parse provider JSON in kernel/shared helpers; `[DONE]` remains a
  non-terminal marker.
- Empty-data frames no longer reconstruct and parse the whole SSE frame, so
  `event:`/comment/field names cannot become JSON semantics.
- The red JSON-authority tests are green, and the direct SSE focused suite is
  green.

The implementation has passed targeted tests, build, global installation,
aggregate restart, all four configured port health checks, and same-entry
`/v1/responses` SSE replay. The latest review findings were addressed by
preserving auth/model scope in due global probes and accepting valid Responses
`response.incomplete` events whose termination reason is carried by
`incomplete_details.reason`; both have regression coverage. Workspace
`cargo check --workspace` now passes. Delivery is still blocked until the
remaining full-workspace live H2 fixture failure, mixed-worktree review
findings, and final MCP PASS are closed. The known Error06 external-error
projection finding conflicts with the repository's control-plane/payload
isolation contract and existing red tests; the unrelated provider-compat long
`call_id` finding remains out of this feature's owner boundary.
