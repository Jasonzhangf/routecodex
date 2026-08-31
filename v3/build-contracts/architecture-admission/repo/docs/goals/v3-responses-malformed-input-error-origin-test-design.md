# V3 Responses Malformed Input Error-Origin Test Design

Design ID: `V3-RESPONSES-MALFORMED-INPUT-ERROR-ORIGIN-20260816`

## Goal

Malformed client `/v1/responses` fields rejected while building
`V3HubReqInbound02Normalized` must enter the typed Error chain as client input and
project HTTP 400. They must not be reported as a RouteCodex runtime HTTP 500.

## Evidence and owner

- Reproduction request: `reasoning.effort = 7`.
- The Responses schema requires a qualitative string; numeric `7` is invalid payload.
- Validation owner remains `responses_openai_codec.rs` at Req02.
- Error-origin owner is `V3ResponsesRelayRuntimeError` plus
  `project_v3_responses_relay_runtime_failure` in the Rust Responses Relay runtime.
- No request cleanup, value coercion, provider attempt, retry, health mutation,
  handler compensation, or payload-carried control state is allowed.

## Positive and reverse tests

- Positive: `ClientInboundCanonical` projects Error01-06 with HTTP 400 and code
  `invalid_responses_request`.
- Reverse: provider response projection failures remain runtime/provider-response
  failures and never project as client-invalid.
- Reverse: internally generated web-search request canonicalization failures remain
  internal dispatch failures and never project as client-invalid.
- Live: replay the exact numeric-effort payload after global install and aggregate
  restart; require HTTP 400 and no provider route-selection/failure event for its
  request ID.
- Control: a valid string effort still reaches normal routing and returns a provider
  response.

## Required gates

- Focused Rust unit tests for all three origins.
- Protocol field-parity verifier and mutation red fixtures.
- V3 runtime build, global install, one aggregate restart, all configured health
  endpoints, exact live replay, valid control replay, then DSH Review.
