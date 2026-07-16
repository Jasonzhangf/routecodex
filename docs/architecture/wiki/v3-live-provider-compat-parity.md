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
| Responses Direct | controlled + live verified | controlled + live verified | controlled + live verified for client-facing WebSocket |
| Responses Relay | controlled verified, live blocker | controlled verified, live blocker | controlled verified, live pending |
| Anthropic Messages | controlled verified, final 5555 profile blocker | controlled verified, final 5555 profile blocker | blocked: no entry contract |
| OpenAI Chat Completions | controlled + live verified | controlled + live verified | blocked: no entry contract |
| Gemini Generate Content | controlled verified, final 5555 profile blocker | controlled verified, final 5555 profile blocker | blocked: no entry contract |

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

- responses_relay_cutover_pending: /v1/responses Relay cutover is still not claimed by this matrix.
- live_relay_cutover_pending: controlled Relay closeout does not prove live Relay Server cutover.
- live_provider_replay_matrix_pending: the broader matrix still needs real provider evidence for pending Anthropic, Gemini, and error cases.
- anthropic_messages_live_replay_pending: Anthropic Messages JSON/SSE is not enabled in the final 5555 profile.
- gemini_generate_content_live_replay_pending: Gemini Generate Content JSON/SSE remains outside the final 5555 profile.
- final_5555_profile_anthropic_endpoint_not_enabled and final_5555_profile_gemini_endpoint_not_enabled: live 5555 returned typed endpoint_not_enabled errors for protocols excluded from the final responses + openai_chat profile.

Live audit on 2026-07-16T03:41:00Z used the globally installed managed V3 5555 profile with endpoints responses and openai_chat. Evidence is recorded in .agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json. It verified /v1/models for gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna with required Codex capability fields, Responses Direct JSON/SSE/client WebSocket, and OpenAI Chat Relay JSON/SSE against the real provider. Anthropic Messages and Gemini Generate Content returned explicit endpoint_not_enabled because the final 5555 profile does not declare those endpoints. The audit status is live_v3_provider_replay_partial_verified; it is not a full production cutover, live config mutation, or P6 deletion claim.

Gemini blocker recheck on 2026-07-16T10:06:05Z used globally installed rccv3 snapshot 0.90.3935 after managed restart of /Volumes/extension/.rcc/config.5555.v2.toml. Evidence is recorded in .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_json_sse_after_restart_60d0c90f4.txt and .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_after_restart_config_logs.txt. Both Gemini JSON and SSE returned HTTP 501 endpoint_not_enabled with Error01-06 projection before provider send; the active profile contains no Gemini provider endpoint, and the old model_not_found misroute to the default OpenAI target was not reproduced.

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

This closeout proves a partial live 5555 provider replay after authorized global install, managed V3 restart, and final live profile responses + openai_chat. It does not prove credential mutation, full Relay cutover, P6 deletion, Anthropic/Gemini live replay, the full error matrix, or production cutover.
