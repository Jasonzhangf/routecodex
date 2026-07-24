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
