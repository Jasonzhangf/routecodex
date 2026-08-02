# V3 Runtime Timing Observability Test Design

## Scope

`feature_id: v3.runtime_timing_observability` owns monotonic timing truth for the
Responses Direct/Relay runtime. `V3RuntimeObservability` and
`V3RuntimeStreamObservationSnapshot` carry the typed terminal summary.

`feature_id: v3.console_human_readable_layering` is a read-only projection owner.
It may format Runtime durations as milliseconds, but it must not derive internal
or external time from Server HTTP elapsed.

OpenAI Chat, Anthropic, and Gemini entry runtimes remain outside this slice until
they publish the same Runtime observability contract. No synthetic Server
observability is allowed for those entries.

## Timing Semantics

- `runtime_total`: monotonic time from Runtime entry until the terminal Runtime
  response is governed and ready, or until a Direct SSE stream reaches clean EOF.
- `external`: accumulated monotonic time spent in every provider transport
  attempt. For JSON this ends after the complete provider body is available. For
  SSE this ends only after the incremental decoder accepts clean EOF.
- `internal`: `runtime_total - external`. The Runtime owner computes this from
  the same monotonic lifecycle and rejects an impossible negative interval.
- `time_t`: Server HTTP elapsed remains a separate transport projection. It is
  not a source for any Runtime timing field.

Provider retry/reselect attempts accumulate external time. Provider Action Gate
wait, routing, Hub processing, provider response governance, and client
projection preparation remain internal Runtime time.

## Lifecycle

1. Responses Runtime opens one monotonic request timing state.
2. Immediately before each provider transport send, Runtime opens an attempt.
3. JSON/error attempts close when the complete transport result returns.
4. Relay SSE materialization closes after the provider stream decoder reaches
   clean EOF.
5. Direct SSE transfers the active timing state into the observed client stream.
6. `[DONE]` or a terminal event updates semantic status but does not close timing.
7. Direct SSE decoder `finish()` at clean EOF closes external and runtime spans
   and publishes the typed summary in the stream observation snapshot.
8. Server merges the stream snapshot, requires terminal timing for a successful
   response block, and only formats numeric milliseconds.
9. A terminal-success body Drop before clean EOF emits no terminal console
   projection while timing is still absent. A clean-EOF completion with missing
   timing is a Runtime observability contract failure and remains explicit.
10. Direct-to-Relay and Relay-to-Direct protocol handoffs transfer the same
    Runtime-owned timing/attempt accumulator through a typed diagnostic
    side-channel. The receiving Runtime continues that accumulator; Server may
    only move the carrier and must not merge, infer, or restart its truth.

## Positive Tests

- Responses Relay JSON publishes positive `runtime_total`, non-negative
  `external`, and `internal + external == runtime_total` within integer duration
  identity.
- Responses Direct JSON publishes the same typed summary before output returns.
- Retry/reselect accumulates every completed provider attempt in `external`.
- Direct failure followed by Relay success reports two request-wide attempts;
  Relay failure followed by Direct success reports two request-wide attempts.
- A nested Relay-to-Direct-to-Relay sequence neither loses nor double-counts an
  attempt, while a request without a handoff retains its existing one-leg count.
- Relay materialized SSE includes the complete provider stream lifetime.
- Direct SSE has no terminal summary at headers or after `[DONE]` alone.
- Direct SSE publishes timing after decoder `finish()` accepts clean EOF.
- Server renders numeric `time_i`, `time_e`, and Server-owned `time_t`.
- Runtime timing remains a diagnostic side-channel and never enters provider or
  client normal payloads.

## Negative Tests

- No terminal success console line contains `time_i=unreported` or
  `time_e=unreported`.
- Server does not copy `time_t` into `time_i`.
- Server does not synthesize `time_e=0`.
- A malformed tail after `[DONE]` cannot publish successful terminal timing.
- A `response.failed` or `response.incomplete` event missing non-empty
  `error.code` or `error.message` fails as
  `provider_response_sse_event_invalid`; Runtime must not invent provider error
  fields.
- A provider SSE frame whose explicit `event` name differs from the JSON
  `type` fails as `provider_response_sse_event_invalid`; neither field may
  override the other and a failed payload cannot reach success closeout.
- A provider stream error cannot be finalized as successful timing.
- A client disconnect cannot be converted into a successful terminal timing
  observation.
- A terminal-success Drop before clean EOF cannot fabricate completion, 499, or
  `runtime_observability_contract`.
- A clean-EOF terminal success with missing timing cannot be silently
  suppressed; it must expose `runtime_observability_contract`.
- A second timing owner cannot appear in Server, SSE transport, Virtual Router,
  Target, or provider codec crates.
- Request/response payload semantics are byte-equivalent apart from existing
  transport framing.
- Runtime observability/timing/attempt state is absent from every provider and
  client normal payload across both handoff directions.

## Verification

- Focused Runtime JSON timing tests.
- Focused Direct SSE clean EOF, pre-EOF Drop, missing-timing, and malformed-tail
  tests.
- Focused Server console timing projection tests.
- Full `routecodex-v3-runtime` and `routecodex-v3-server` mapped regressions.
- Function/resource/mainline/manifest/verification-map gates.
- Runtime timing red-fixture gate rejects Server synthesis, `unreported`,
  premature SSE finalization, mismatched SSE event types, second writers, and
  record-timing resource-flow drift between call maps and the lifecycle
  manifest.
- V3 build/install, managed restart, health, and exact 5555 sample replay:
  `openai-responses-router-gpt-5.5-20260729T102223233-669944-7581`.
- Mandatory Codex review with unambiguous `VERDICT: PASS`.
