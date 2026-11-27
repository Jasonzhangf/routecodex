# V3 Provider Response Error Policy Test Design

## Objective

Pass successful, representable provider responses without content adjudication. Genuine provider HTTP and native SSE errors enter the typed Error01-06 path before business commit. Only a complete real non-2xx response from the actual exhausted final identity may project using the client entry protocol. All other exhausted failures terminate only the affected transport without a fabricated response or completion.

## Lifecycle

```text
provider HTTP / complete SSE attempt
  -> protocol parsing and genuine error extraction
  -> successful output: lossless canonical projection -> Resp03/Resp04 -> client commit
  -> genuine failure: typed Error01-05 -> declared successor or explicit active-key retry decision
  -> recovery: accepted provider business output -> client commit
  -> exhaustion: typed Error06 qualification
       -> complete actual-final non-2xx before business commit -> entry-protocol projection
       -> internal / incomplete / transport / stale-witness / synthetic failure -> affected transport termination
```

## Owners and boundaries

- Config authoring/compile owner: `routecodex-v3-config`.
- Genuine error extraction owner: registered provider protocol codecs before Resp03.
- Candidate recovery owner: Error/Target. Explicit active-key retry and queue state belong to Target and remain separate from Provider health. Requests do not wait for cooldown or recovery admission.
- Terminal qualification owner: typed Error06. Server projects only a qualified complete actual-final non-2xx response before business commit using the client entry protocol; every other exhausted failure terminates only the affected transport. A transport-only SSE head or heartbeat is not business commit.
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
- Zero usage alone does not make a successful protocol response fail. After complete response governance, an attempt without visible text or an independent business result enters the internal 502 recovery chain; reasoning alone does not authorize completion.
- A final containing only nonrendering code points is empty; visible text mixed with those code points remains complete business content.
- Content keywords cannot turn successful provider output into a failure.

### Directive and policy execution

- Genuine errors retain typed source and declared recovery path; Error05 never re-matches business content.
- By default, a failed complete identity is excluded from another send in the same request; recovery selects an untried eligible declared successor. Explicit active-key policy may retry within its declared episode budget and apply its separate fourth-failure queue transition; it never overrides Provider health.
- The final or only eligible identity remains Provider-health neutral. Recovery does not wait for cooldown, probes or admission. The separately declared fixed two-second delay applies only to consecutive unresolved errors in the same session.
- Accepted business success stops further retry or reselection and reaches Resp04 once.
- Exhaustion projects only a complete real non-2xx response from the actual exhausted final identity before business commit. Internal, incomplete, transport, stale-witness and synthetic failures end only the affected transport without provider error bytes or fabricated completion.

## Black-box matrix

- JSON and SSE representable incomplete/refusal output passes Direct and Relay paths.
- A genuine native SSE failure is not a complete HTTP non-2xx witness. After declared recovery is exhausted, it ends only the affected transport without error bytes or fabricated completion. Projection of a qualified complete HTTP error into client SSE is a separate path.
- Second attempt success commits only successful response.
- Exhausted attempts leave continuation at pre-request state.
- Non-final real HTTP failures remain private and recover through an untried eligible declared successor. Only a complete actual-final non-2xx response may project before business commit, with its actual status, applicable headers, body and cause retained through necessary client-protocol conversion.
- The existing `complete_final_provider_http_502_preserves_status_and_body` public Relay regression asserts the actual HTTP 502, provider `text/html` content type, exact HTML body, no transport error, one send and no cooldown for the final identity. Independent requests remain usable.
- Public Direct and Relay requests discard a reasoning-plus-explicit-final attempt whose final contains only U+200B or FEFF, recover through the next candidate, and expose neither the source attempt nor an internal error.
- One recoverable failure leaves the provider eligible; a subsequent real success resets the pre-cooldown streak.
- Positive control: normal provider HTTP 200 content completes unchanged.
- Responses custom calls projected to Chat keep their existing custom-kind association and input wrapper. Submit the returned JSON/SSE call unchanged with the actual client result; the next Responses request must retain the original custom call, complete input or absence, and matching custom output.
- Chat providers returning custom-call input wrappers preserve every JSON input value and true absence through JSON and SSE, including fragmented wrapper text. Submit the actual returned call and client execution or validation result unchanged; the next Chat request must contain exactly one wrapper. Malformed raw argument text remains intact.
- Responses custom calls returned through Anthropic JSON/SSE retain their business type association. Execute the actual returned tool_use and submit it unchanged with its matching actual tool_result; the next Responses request must recover custom call/output kinds, original IDs, name and complete input, including natural object input fields and scalar wrappers.
- Chat JSON/SSE clients execute an ordinary returned call and a later custom returned call that reuse one ID. Submit both actual call/result turns unchanged; the next Responses wire must preserve the earlier function result and the later custom result, with the complete arguments/input and actual execution output.
- Chat JSON/SSE calls named tool_search use the actual ordinary, custom or native declaration. Preserve opaque structured values, raw text and missing arguments. Execute or validate each returned call in the client, then submit that call and its actual result unchanged to Chat and Responses; neither parameter validation nor a name collision may cause provider cooldown.
- An otherwise successful provider response that cannot represent tool arguments in Anthropic ends only that client request through the typed local response Error chain. With health enabled, two identical projection failures must leave the same provider/auth/model identity eligible for a subsequent valid request.

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
