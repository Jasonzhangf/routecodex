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
| Responses Relay | controlled + live verified | controlled + live verified | controlled verified, live pending |
| Anthropic Messages | controlled verified, final 5555 profile blocker | controlled verified, final 5555 profile blocker | blocked: no entry contract |
| OpenAI Chat Completions | controlled + live verified | controlled + live verified | blocked: no entry contract |
| Gemini Generate Content | controlled verified, final 5555 profile blocker | controlled verified, final 5555 profile blocker | blocked: no entry contract |

The manifest also locks the required error cases: http_401, http_402, http_403, http_429, http_5xx, sse_body_level_failure, malformed_provider_body, timeout, disconnect, and cancel.

Provider failure evidence is split by safety boundary. HTTP 401, HTTP 403, HTTP 5xx, and provider timeout are controlled_verified through `npm run verify:provider-failure-ban-blackbox`: each failing primary records one provider failure attempt, then backup/default is hit and the client receives HTTP 200 instead of an early terminal provider error. Live 401/403 remains live_pending because production credentials must not be mutated to manufacture auth/authorization errors; live 5xx/timeout remains live_pending until a natural or authorized live provider failure sample exists.

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

- responses_relay_live_verified: /v1/responses Relay source binding, controlled Server entry, and live JSON/SSE provider replay are verified.
- live_provider_replay_matrix_pending: the broader matrix still needs real provider evidence for pending Anthropic, Gemini, and live 401/403/5xx/timeout cases.
- anthropic_messages_live_replay_pending: Anthropic Messages JSON/SSE is not enabled in the final 5555 profile.
- gemini_generate_content_live_replay_pending: Gemini Generate Content JSON/SSE remains outside the final 5555 profile.
- final_5555_profile_anthropic_endpoint_not_enabled and final_5555_profile_gemini_endpoint_not_enabled: live 5555 returned typed endpoint_not_enabled errors for protocols excluded from the final responses + openai_chat profile.

Live audit on 2026-07-16T03:41:00Z used the globally installed managed V3 5555 profile with endpoints responses and openai_chat. Evidence is recorded in .agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json. It verified /v1/models for gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna with required Codex capability fields, Responses Direct JSON/SSE/client WebSocket, and OpenAI Chat Relay JSON/SSE against the real provider. Anthropic Messages and Gemini Generate Content returned explicit endpoint_not_enabled because the final 5555 profile does not declare those endpoints. The audit status is live_v3_provider_replay_partial_verified; it is not a full production cutover, live config mutation, or P6 deletion claim.

Gemini blocker recheck on 2026-07-16T10:06:05Z used globally installed rccv3 snapshot 0.90.3935 after managed restart of /Volumes/extension/.rcc/config.5555.v2.toml. Evidence is recorded in .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_json_sse_after_restart_60d0c90f4.txt and .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_after_restart_config_logs.txt. Both Gemini JSON and SSE returned HTTP 501 endpoint_not_enabled with Error01-06 projection before provider send; the active profile contains no Gemini provider endpoint, and the old model_not_found misroute to the default OpenAI target was not reproduced.

Responses Relay live recheck on 2026-07-16T11:44:22Z used globally installed rccv3 snapshot 0.90.3935 and /Volumes/extension/.rcc/config.5555.v2.toml on managed instance v3-2412d59aaae7317c9867. Evidence is recorded in .agent-collab/runs/20260716T110035Z-Macstudio.local-31201-f5633c/logs/live-provider-matrix-20260716T114218Z/summary.json. `/v1/models` returned the required Codex capability fields, `/v1/responses` Relay JSON/SSE returned HTTP 200 with exact markers, and both traces contained the fixed Req01-Req09/Resp01-Resp06 lifecycle without Direct/P6 markers.

Responses Direct fresh live recheck on 2026-07-16T12:20:33Z used a temporary native V3 direct config generated from /Volumes/extension/.rcc/config.5555.v2.toml, then removed it after replay and restored the original managed V3 5555 Relay instance. Evidence is recorded in .agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/direct-fresh-live-20260716T122025Z/summary.json. Direct JSON returned HTTP 200 with marker V3_DIRECT_FRESH_JSON_OK, Direct SSE returned HTTP 200 with marker V3_DIRECT_FRESH_SSE_OK and response.completed, and Direct client WebSocket returned response.completed with marker V3_DIRECT_FRESH_WS_OK. The JSON/SSE traces contained Direct/P6 nodes and no Relay trace. Restoration evidence is recorded in .agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/relay-restored-live-20260716T122141Z/summary.json: `/v1/models`, Relay JSON, and Relay SSE all returned live_verified after the original config was restarted.

## Required Gates

- npm run verify:v3-live-provider-compat-parity
- npm run test:v3-live-provider-compat-parity-red-fixtures
- npm run verify:provider-failure-ban-blackbox
- npm run verify:v3-architecture-docs
- npm run verify:v3-resource-map
- npm run verify:v3-module-boundaries
- npm run verify:v3-rust-only
- npm run verify:v3-cargo-fmt
- npm run verify:v3-clippy
- npm run test:v3-workspace
- git diff --check

## Completion Boundary

This closeout proves a partial live 5555 provider replay after authorized global install, managed V3 restart, temporary non-production Direct replay, and final live profile responses + openai_chat restoration. It includes Responses Direct JSON/SSE/client WebSocket, Responses Relay JSON/SSE, /v1/models, and OpenAI Chat Relay JSON/SSE. It also records controlled provider-failure evidence for 401/403/5xx/timeout reroute/default-pool behavior. It does not prove credential mutation, P6 deletion, Anthropic/Gemini live replay, live 401/403/5xx/timeout provider failures, or full production cutover.
