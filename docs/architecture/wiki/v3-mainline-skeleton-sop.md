# V3 Mainline Skeleton SOP

Status: audited locked by Jason on 2026-07-23.
Review surface: `docs/architecture/wiki/html/v3-mainline-caller-flow.html`.
Lock manifest: `docs/architecture/v3-architecture-audit-locks.yml`.

## Locked Scope

The following big-skeleton chains are SOP and cannot change without a Jason manual authorization record in `docs/architecture/v3-architecture-audit-locks.yml`:

- `v3.config.compile`
- `v3.entry_protocol_endpoint_binding.mainline`
- `v3.server.startup`
- `v3.responses_direct.required_mainline`
- `v3.hub_pipeline.v1.request`
- `v3.hub_pipeline.v1.response`
- `v3.servertool_hook_skeleton_lifecycle`
- `v3.debug_error_foundation.mainline`

## Debug Entry SOP

1. Open this SOP first for any V3 Hub Pipeline / Direct / Relay / Stopless / servertool / error handling debug.
2. Open the HTML review surface and find the relevant locked chain before reading implementation code.
3. Check the locked chain's contract nodes and resource-flow table.
4. If the issue is outside the locked chain, continue to the relevant branch diagram; if a new pattern is proven, add or update the owning SOP.
5. If a fix would change a locked chain edge, owner, node, resource flow, caller, or callee, stop and record a Jason manual authorization before editing the locked map.

## Locked Contract

- Request skeleton is `ReqInbound -> ReqChatProcess -> ReqOutbound -> ProviderReqCompat -> ProviderReqOutbound -> Transport`.
- Response skeleton is `ProviderRespInbound -> ProviderRespCompat -> RespInbound -> RespChatProcess -> RespContinuation save -> RespOutbound -> Server frame`.
- Direct response projection must pass through Direct-only projection nodes; no provider raw / Resp03 / Resp04 direct-to-client shortcut.
- Stopless/servertool request-side governance is Req04-owned; response-side governance is Resp03-owned; continuation save is Resp04-owned.
- Error handling is a resource graph with Error01-06 plus provider health/availability; side-channel is carrier mechanism, not the resource owner.
- Metadata/debug/snapshot/error carriers must not enter provider body or client normal payload.

## Requested Model / Provider-Switch SOP

Use this SOP when `/v1/responses` returns success on the wrong provider/model, a non-built-in model such as `MiniMax-M3` reports no candidate, or a provider error such as 429/403/413 appears to stop instead of switching.

1. Lock evidence from the live entry first:
   - `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/request.json`
   - `~/.rcc/logs/server-v3-5555.log`
   - provider-request dry-run with `x-routecodex-dry-run: provider-request`
2. Confirm the selected chain:
   - `V3Req04StandardizedResponses`
   - `V3Router05RequestClassified`
   - `V3Router06RoutePoolResolved`
   - `V3Router07OpaqueTargetHitOnce`
   - `V3Target08KindClassified`
   - `V3Target09CandidateSetExpanded`
   - `V3Target10ConcreteProviderSelected`
   - `V3Provider12ResponsesWirePayload`
3. Apply model mapping rules:
   - explicit `match.models` route pools declare inbound client model -> allowed targets mapping.
   - provider-wire hook rewrites outbound `body.model` to selected target `wire_model`.
   - default/no-explicit-model paths must reject silent wrong-model success unless a configured target model id matches the requested model.
   - provider `aliases` are catalog/display metadata only; they must not authorize runtime requested-model matching or provider-wire model rewriting.
4. Apply provider-error rules:
   - every provider/runtime error, including 429/401/403/413/5xx/transport/codec failures, enters `V3Error01SourceRaised -> ... -> V3Error06ClientProjected`.
   - if a selected/explicit pool or default floor candidate remains, action must be provider reselect/switch, not client projection.
   - client projection is allowed only after the selected route candidates and default floor are exhausted.
5. Required proof:
   - dry-run shows selected provider and provider request body `model`.
   - live replay or exact old sample shows `[provider-error]` and `[provider-switch]` for failing candidates, then either final success or explicit exhausted error.
   - marker-only 200 is not evidence unless logs/body prove selected provider/model.

## rccv3 Live Closeout SOP

Use this SOP for V3 native live surfaces served by `config.v3.toml`, including 4444/5555.

1. Build and install the native V3 binary:
   - `RUSTUP_TOOLCHAIN=stable npm run install:v3`
2. Validate the active V3 config:
   - `rccv3 config check -c /Volumes/extension/.rcc/config.v3.toml`
3. Restart the V3 instance with rccv3:
   - `rccv3 restart -c /Volumes/extension/.rcc/config.v3.toml`
   - Do not use legacy `routecodex restart --port <port>` as the authoritative closeout for this rccv3 instance.
4. Verify runtime identity:
   - `rccv3 --version`
   - hash `dist/bin/rccv3`, `/Users/fanzhang/.rcc/install/current/dist/bin/rccv3`, and `/Volumes/extension/.rcc/install/current/dist/bin/rccv3`
   - `curl http://127.0.0.1:4444/health`
   - `curl http://127.0.0.1:5555/health`
5. Verify behavior on installed runtime:
   - provider-request dry-run for the involved model and port.
   - live JSON/SSE probe that proves client transport shape.
   - exact old-sample replay when a saved failing sample exists.
6. Closeout evidence must record:
   - installed hash
   - health for every member port
   - selected provider/model
   - provider-switch chain or explicit exhaustion
   - usage/finish reason when the response completes

## SSE Edge SOP

- SSE is an independent transport edge. It owns bytes, UTF-8/frame parsing, frame limits, backpressure/EOF/drop/error closeout, and opaque frame re-encoding only.
- SSE transport and server frame code must not inspect `data` JSON, event names, `required_action`, terminal status, tool calls, continuation, stopless/servertool, routing, retry, or error-policy semantics.
- Provider inbound streaming semantics belong to provider/protocol response codec owners after `SseTransportIn03ValidatedFrameStream` has produced opaque frames.
- Client outbound streaming semantics belong to `V3HubRespOutbound05ClientSemantic`; `V3ServerRespOutbound06ClientFrame` only hands finalized JSON/client bytes to `Body::from_stream`.
- EOF without a provider/client semantic terminal is a protocol/runtime owner error before client projection, not a server/SSE parser responsibility.
- Console closeout may record stream EOF, provider stream error, or client drop from transport lifecycle only; it must not parse SSE payloads to decide completed/failed/requires_action.

## Required Gates

- `npm run render:v3-mainline-caller-flow`
- `npm run verify:v3-mainline-caller-flow`
- `npm run test:v3-mainline-caller-flow-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:architecture-wiki-html-sync`

## Change Rule

A locked item fingerprint change is forbidden unless `manual_authorizations[]` records:

- `authorization_id`
- `item_id`
- `approved_by: Jason`
- `fingerprint_before`
- `fingerprint_after`
- reason/scope

Normal architecture gates may continue for unaudited chains, but audited locked chains are immutable without the authorization record.
