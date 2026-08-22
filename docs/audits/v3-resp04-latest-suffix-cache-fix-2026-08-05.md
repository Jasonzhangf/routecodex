# V3 Resp04 latest-suffix cache fix — 2026-08-05

## Real-sample evidence

- DS4 request 18 contains 294 messages.
- DS4 request 19 contains 297 messages.
- Request 19's first 294 messages are JSON-equivalent to request 18.
- The only appended suffix is assistant visible/reasoning content, assistant tool call, then the paired tool result.
- The cache mismatch was the EOS inserted between two adjacent Chat assistant messages: content-only followed by tool-calls-only.

## Locked contract

- Historical messages are immutable after their original round.
- Req inbound performs the declared static protocol projection and never scans or rewrites historical turns.
- Resp04 local continuation save records the historical message count before appending the finalized response delta.
- Only messages originating from that newly appended suffix may be coalesced.
- Tool declarations, calls, call ids, and results keep source order and pairing; no sorting is allowed.
- The removed whole-history inbound ordered projector must not be reintroduced.

## Unique owner and forbidden repair sites

- Owner: `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs`.
- Forbidden repair sites: Req inbound whole-history pass, handler, SSE, provider transport, usage projection, console projection, DS4 cache policy, MetadataCenter, or request-send cleanup.

## Verification

- Immutable-prefix regression: 294-message historical prefix remains exactly equal; an existing historical split remains unchanged; only the newest reasoning/text/tool-call suffix coalesces.
- `responses_relay_local_continuation_integration`: 31/31 PASS.
- V3 architecture docs, resource map, module boundary, and protocol parity gates: PASS.
- Protocol parity mutations: 109/109 rejected.
- Installed V3: `0.90.4142`, SHA256 `f188324e61efbfd53175b19f0ba2ed7af2d67c37f7b40fb8554efc1240344462`.
- Aggregate restart and health: 10000/4444/5520/5555 PASS.
- Jason's post-install real test reported cache behavior normal.
