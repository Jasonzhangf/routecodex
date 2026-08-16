# V3 Responses Cross-Provider Reasoning History Test Design

## Lifecycle

`Responses client history -> Provider12 configured request compatibility -> Responses provider wire -> upstream Responses API`

## Verified Failure

- A real 5555 session first received Anthropic Relay reasoning projected as a Responses
  `reasoning` item with a provider-specific signature in `encrypted_content`.
- A later Direct ASXS attempt forwarded that historical item unchanged and received HTTP 400
  `invalid_encrypted_content`.
- Removing only `encrypted_content` changed the same minimal upstream replay to HTTP 404
  `Invalid URL (POST /responses)` because the upstream rejects historical summary-only reasoning.
- Mapping the historical summary to an assistant `output_text` message made the same upstream replay
  return HTTP 200. Plain ASXS auth, URL, model, large text, function call history, and current-turn
  Responses reasoning each passed independently.

## White-Box

- Positive: when explicitly configured, historical `reasoning.summary` becomes one assistant message
  with `output_text` before the latest user turn.
- Positive: encrypted-only historical reasoning remains unchanged because no semantic summary exists
  to project.
- Positive: current-turn reasoning at or after the latest user remains unchanged.
- Negative: with the compatibility option disabled, Provider12 preserves the original payload.
- Negative: empty/invalid summary parts do not cause an opaque reasoning item to be deleted.

## Module Black-Box

- V2 provider-directory compilation projects the explicit compatibility option into the V3 provider
  manifest without provider-ID special cases.
- Provider12 applies the option only from the selected provider target at provider wire build time.
- Hub Pipeline and Virtual Router do not inspect, rewrite, or classify provider-specific reasoning.

## Project Black-Box

- Build and globally install V3.
- Aggregate restart only through `routecodex restart --port 5555`.
- Verify 10000, 5520, and 5555 health report the installed version.
- Replay the captured mixed-provider Responses history through 5555 pinned to `asxs.gpt-5.5`.
- Require a successful ASXS response and no `provider_http_400`, `provider_http_404`,
  `invalid_encrypted_content`, or `Invalid URL (POST /responses)` for the replay request ID.

## Architecture Boundary

This is configured provider request compatibility owned by `routecodex-v3-provider-responses` at
`V3Provider12ResponsesWirePayload`. It does not change route selection, capability classification,
Hub Chat Process, continuation ownership, client history, or response projection. The compatibility
operation is opt-in and provider-ID neutral.
