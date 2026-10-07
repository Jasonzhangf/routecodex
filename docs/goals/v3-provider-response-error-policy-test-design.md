# V3 Provider Response Error Policy Test Design

## Objective

Pass successful, representable provider responses without content adjudication. Genuine provider HTTP and native SSE errors enter the typed Error01-06 path before client commit. Client exhaustion terminates transport without an error response or fabricated completion.

## Lifecycle

```text
provider HTTP / complete SSE attempt
  -> protocol parsing and genuine error extraction
  -> successful output: lossless canonical projection -> Resp03/Resp04 -> client commit
  -> genuine failure: typed Error01-05 -> retry/reselect/cooldown decision
  -> configured minimum backoff through Provider Action Gate
  -> recovery: successful provider output -> client commit
  -> exhaustion: typed Error06 -> transport termination
```

## Owners and boundaries

- Config authoring/compile owner: `routecodex-v3-config`.
- Genuine error extraction owner: registered provider protocol codecs before Resp03.
- Retry timing/admission owner: `v3.provider_action_gate`.
- Terminal failure owner: typed Error06, with transport termination at the client boundary.
- `V3ProviderFailureDirective` is an error/control side-channel. It must never enter provider/client payload, MetadataCenter, continuation context, debug snapshot, or protocol metadata.
- SSE transport and Server handler remain framing/projection only.

## White-box matrix

### Config

- Provider-local policy accepts exactly one of legacy `action` or full `path`.
- Full path compiles with injected provider id/type scope.
- `path + action`, neither, invalid attempt/backoff, and non-final project fail fast.
- Legacy `semantic_error_policy.action` still compiles unchanged.

### Successful response passage

- Chat text, reasoning, tool calls and refusal survive JSON and SSE conversion, including co-located deltas.
- Anthropic refusal remains output and maps to the representable Responses incomplete reason.
- Responses incomplete reasons remain opaque business values.
- Empty output and zero usage do not make a successful protocol response fail.
- Content keywords cannot turn successful provider output into a failure.

### Directive and policy execution

- Genuine errors retain typed source and declared recovery path; Error05 never re-matches business content.
- `max_attempts=3` means initial send plus two same-provider retries.
- Retry delays follow `max(action_gate_delay, configured_backoff)` with saturating exponent and 60-second cap.
- Success on retry stops further retry/project and only successful response reaches Resp04.
- Exhaustion ends client transport without provider error bytes.

## Black-box matrix

- JSON and SSE representable incomplete/refusal output passes Direct and Relay paths.
- Genuine native SSE error ends transport without error bytes or fabricated completion.
- Second attempt success commits only successful response.
- Exhausted attempts leave continuation at pre-request state.
- Real HTTP failures use the provider-scoped typed recovery path and never become a client error response.
- One recoverable failure leaves the provider eligible; a subsequent real success resets the pre-cooldown streak.
- Positive control: normal provider HTTP 200 content completes unchanged.

## Required verification

- `cargo test --release --locked --manifest-path v3/Cargo.toml -p routecodex-v3-server --test no_response_adjudication_blackbox -- --nocapture`
- `cargo test --release --locked --manifest-path v3/Cargo.toml -p routecodex-v3-server --test no_first_failure_cooldown_blackbox -- --nocapture`
- `npm run test:v3-provider-action-gate`
- `npm run verify:v3-provider-action-gate`
- `npm run test:v3-provider-action-gate-red-fixtures`
- `npm run test:v3-hub-relay-runtime-closeout`
- `npm run verify:v3-hub-relay-runtime-closeout`
- `npm run test:v3-hub-relay-runtime-closeout-red-fixtures`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-cargo-fmt`
- `npm run test:v3-workspace`
- `git diff --check`

Runtime closeout additionally requires V3 global install, one aggregate restart, every configured listener health check, failing-shape replay, positive control replay, then DSH Review.
