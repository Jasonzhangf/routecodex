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
| Responses Relay | controlled + live verified | controlled + live verified | controlled + current 5555 live verified |
| Anthropic Messages | controlled + current 5555 live verified | controlled + current 5555 live verified | blocked: no entry contract |
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
- input_modalities

It also tracks selector absence for the currently exposed `gpt-5.5` catalog:

- no use_responses_lite
- no tool_mode

## Production Blockers

Current blockers are explicit and must not be silently converted into readiness:

- responses_relay_live_verified: /v1/responses Relay source binding, controlled Server entry, and live JSON/SSE provider replay are verified.
- anthropic_messages_live_verified_current_5555: Anthropic Messages JSON and SSE are enabled and live verified on the current multi-provider 5555 profile.
- live_provider_replay_matrix_pending: the broader matrix still needs real provider evidence for Gemini, remote continuation, and live 401/403/5xx/timeout cases.
- remote_continuation_exact_pin_provider_profile_unavailable: the current 5555 profile has no Responses `websocket_v2` provider transport, no `websocket_v2_url`, and no model with both `remote_continuation` and `tool_outputs`, so provider-owned exact-pin two-turn replay remains blocked.
- gemini_generate_content_live_replay_pending: Gemini Generate Content JSON/SSE remains outside the final 5555 profile.
- final_5555_profile_gemini_endpoint_not_enabled: Gemini remains outside the current 5555 endpoint profile and retains the typed endpoint_not_enabled blocker.

## Current 5555 Multi-Provider Profile

The 2026-07-23T03:15:26Z audit is the current 5555 truth. Globally installed RouteCodex `0.90.3971` reports `server_id=responses_v3_5555`, `manifest_version=3`, and a healthy V3 listener after `routecodex restart --port 5555`. The profile enables `responses` and `anthropic` entries and routes across `minimax_openai`, `minimax_anthropic`, `glmrelay_openai`, and `glmrelay_anthropic`. The default pool remains weighted MiniMax OpenAI + Anthropic; the non-default pools intentionally include GLMRelay targets.

Anthropic Messages JSON provider-request dry-run stopped before provider send with `providerNetworkSend=false`, and the live JSON request returned HTTP 200 `type=message`. Anthropic Messages SSE provider-request dry-run preserved `stream=true`, `streamIntent=sse`, and `Accept: text/event-stream` while still stopping before provider send. The live SSE request returned HTTP 200 `text/event-stream` with `message_start`, `content_block_delta`, and `message_stop`, and no error event. Evidence:

- `.agent-collab/runs/20260722T155834Z-Macstudio.local-4466-2caf-v3-p0-response-error/live-dryrun-messages-20260722T164017Z.summary.json`
- `.agent-collab/runs/20260722T155834Z-Macstudio.local-4466-2caf-v3-p0-response-error/live-messages-json2-20260722T164155Z.summary.json`
- `.agent-collab/runs/20260722T171600Z-Macstudio.local-88821-c652a9-v3-live-compat-matrix/live-dryrun-messages-sse-20260722T172253Z.summary.json`
- `.agent-collab/runs/20260722T171600Z-Macstudio.local-88821-c652a9-v3-live-compat-matrix/live-messages-sse-20260722T172233Z.summary.json`
- `.agent-collab/runs/20260722T171600Z-Macstudio.local-88821-c652a9-v3-live-compat-matrix/live-current-5555-status.log`

Responses Relay client-facing WebSocket v2 is also live verified on the same current 5555 profile:

- `.agent-collab/runs/20260723T020344Z-Macstudio.local-23790-wscont/live-probes-initial/ws_probe_after_restart_20260723T030907Z.json` opened `ws://127.0.0.1:5555/v1/responses` and returned `response.completed` with marker `WS_RELAY_LIVE_OK`.
- `.agent-collab/runs/20260723T020344Z-Macstudio.local-23790-wscont/live-probes-initial/ws_tool_loop_after_restart_20260723T031352Z.json` opened the same client WebSocket, received a first `response.completed` with `function_call`, sent a second `response.create` with `previous_response_id` + `function_call_output`, and received the second `response.completed`.
- `.agent-collab/runs/20260723T020344Z-Macstudio.local-23790-wscont/current-5555-remote-continuation-inventory.json` records that exact-pin provider-owned remote continuation remains unavailable in this profile because active providers are `openai_chat` / `anthropic` and none declares Responses `websocket_v2` transport, `websocket_v2_url`, `remote_continuation`, or `tool_outputs`.

This audit did not mutate provider config, credentials, or live config. It used only the allowed aggregate lifecycle command `routecodex restart --port 5555` and did not use any start/server-start/run-managed-child lifecycle command.

## Historical Audits

The 2026-07-16T03:41:00Z audit used an older managed V3 profile with responses and openai_chat entries. Evidence is recorded in `.agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json`. It verified `/v1/models`, Responses Direct JSON/SSE/client WebSocket, and OpenAI Chat Relay JSON/SSE against the real provider. Its Anthropic exclusion applied only to that historical profile and is superseded by the current 5555 evidence above; Gemini remains excluded. The audit status remains `live_v3_provider_replay_partial_verified`, not a full production cutover, live config mutation, or P6 deletion claim.

Current 2026-07-21 catalog ceiling supersedes the old gpt-5.6 exposure for new `/v1/models` responses: RouteCodex exposes Codex built-ins only through `gpt-5.5` until the gpt-5.6 client surface is explicitly enabled.

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

This closeout proves a partial live 5555 provider replay after authorized global install and managed V3 restart evidence, plus the current multi-provider audit. It includes Responses Direct JSON/SSE/client WebSocket, Responses Relay JSON/SSE/client WebSocket, Anthropic Messages JSON/SSE, `/v1/models`, and OpenAI Chat Relay JSON/SSE. It also records controlled provider-failure evidence for 401/403/5xx/timeout reroute/default-pool behavior. It does not prove two-turn provider-owned remote continuation/tool_outputs exact-pin live replay, credential mutation, P6 deletion, Gemini live replay, live 401/403/5xx/timeout provider failures, or full production cutover. A follow-up provider-side WebSocket v2 probe found 0 HTTP 101 upgrades across 13 configured Responses providers and 52 candidate endpoints, and the current 5555 profile inventory has no Responses WebSocket v2 provider candidate, so remote continuation remains blocked by provider/profile endpoint availability rather than by the client-facing Relay WebSocket path.
