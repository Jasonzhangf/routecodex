# V3 Live Provider Compat Parity Review

Canonical plan: [V3 Live Provider Compat Parity Closeout Plan](../../goals/v3-live-provider-compat-parity-closeout-plan.md)

Machine manifest: [v3.live_provider_compat.parity](../manifests/v3.live_provider_compat.parity.yml)

Feature: v3.live_provider_compat_parity_closeout

Resource binding: v3.live_provider_compat.matrix

Canonical manifest path: docs/architecture/manifests/v3.live_provider_compat.parity.yml

## Purpose

This review surface separates V3 controlled/source completion from real provider compatibility.

- controlled evidence cannot be live evidence.
- production ready requires controlled + live evidence.
- provider-specific differences stay in provider runtime or codec owners.
- Hub Pipeline and Virtual Router must not grow provider/model/key compatibility branches.
- live probes are read-only unless Jason explicitly authorizes config, credential, install, or restart mutation.

## Lifecycle

~~~mermaid
flowchart TD
  M[V3LiveCompat01MatrixDeclared] --> C[V3LiveCompat02ControlledEvidenceBound]
  C --> L[V3LiveCompat03LiveEvidenceBound]
  L --> P[V3LiveCompat04ProductionReadinessProjected]
~~~

## Matrix Contract

The machine manifest covers every endpoint and transport pair:

| Endpoint | JSON HTTP | SSE HTTP | WebSocket v2 |
| --- | --- | --- | --- |
| Responses Direct | controlled verified, live pending | controlled verified, live pending | controlled verified, live blocker |
| Responses Relay | controlled verified, live blocker | controlled verified, live blocker | controlled verified, live pending |
| Anthropic Messages | controlled verified, live pending | controlled verified, live pending | blocked: no entry contract |
| OpenAI Chat Completions | controlled verified, live pending | controlled verified, live pending | blocked: no entry contract |
| Gemini Generate Content | controlled verified, live pending | controlled verified, live pending | blocked: no entry contract |

The manifest also locks the required error cases: http_401, http_402, http_403, http_429, http_5xx, sse_body_level_failure, malformed_provider_body, timeout, disconnect, and cancel.

## Capability Contract

The /v1/models capability case tracks the Codex request-builder fields that can change emitted provider payloads:

- supports_reasoning_summaries
- support_verbosity
- supports_parallel_tool_calls
- context_window
- max_context_window
- supports_search_tool
- use_responses_lite
- tool_mode
- input_modalities

## Production Blockers

Current blockers are explicit and must not be silently converted into readiness:

- live_inbound_websocket_replay_pending: client-facing Responses WebSocket proxy is controlled-verified, but real live/provider WebSocket replay remains pending.
- responses_websocket_v2_live_endpoint_pending: provider-verified Responses WebSocket v2 endpoint and real two-turn success remain pending.
- live_relay_cutover_pending: controlled Relay closeout does not prove live Relay Server cutover.
- live_provider_replay_matrix_pending: read-only live provider replay matrix still needs real provider evidence.

Read-only audit on 2026-07-16T01:09:15Z found reachable ports 5520, 4444, and 10000 reporting RouteCodex 0.90.3935, while 5555 had no listener. That audit is not V3 live provider parity evidence and keeps live_v3_provider_replay_pending explicit.

## Required Gates

- npm run verify:v3-live-provider-compat-parity
- npm run test:v3-live-provider-compat-parity-red-fixtures
- npm run verify:v3-architecture-docs
- npm run verify:v3-resource-map
- npm run verify:v3-module-boundaries
- npm run verify:v3-rust-only
- npm run verify:v3-cargo-fmt
- npm run verify:v3-clippy
- npm run test:v3-workspace
- git diff --check

## Completion Boundary

This closeout can prove the matrix contract and identify verified/pending/blocker states. It does not by itself authorize or prove live config mutation, credential mutation, global install/restart, P6 deletion, or production cutover.
