# V3 SSE transient failure health-policy test design

Design ID: `V3-SSE-TRANSIENT-NO-PROVIDER-COOLDOWN-20260816`

## Lifecycle and owner

Provider SSE transport/decode/EOF failures enter the typed Error chain and Runtime provider-failure policy. Direct and Relay keep every attempt behind the canonical full-attempt atomic commit boundary: no business byte reaches the client until a protocol-valid terminal is observed and the bounded attempt payload is sealed. A pre-terminal failure discards the attempt and returns to the same request-level Error05 recovery controller; there is no post-business-byte retry state in this lifecycle.

The unique health-policy owner is `V3ProviderFailureRuntimeHealth` plus `V3ProviderHealthStore`. SSE transport and Server remain framing/lifecycle-only.

## White-box tests

- Three client cancellations after a sealed success do not create consecutive provider failures, provider cooldown, or a cooldown probe.
- A fresh session still sees the same provider key as available after those client cancellations.
- The action-gate observation still completes so client closeout does not leak an in-flight permit.

## Module and project black boxes

- A Responses Direct stream containing only empty lifecycle frames followed by provider failure or EOF remains pre-commit and enters the existing retry/reselect state machine.
- A genuine output/tool frame does not authorize incremental business-byte commit; a later pre-terminal error discards the complete failed attempt before replacement.
- Real non-SSE provider errors such as HTTP 401/403 continue to use the manifest-configured failure threshold and provider cooldown policy.

## Positive and negative evidence

- Positive: controlled pre-commit failure retries/reselects and ends in HTTP 200 from the selected healthy candidate.
- Negative: repeated client cancellation after sealed success cannot change another session's availability or create provider probe state.
- Control: repeated configured HTTP provider failures still create cooldown at their configured threshold.

## Required closeout

Focused Rust red/green tests, real local TCP replacement-stream coverage, V3 provider-health/action-gate gates, architecture/module/resource gates, release install from the committed clean worktree, aggregate `routecodex restart`, all configured health endpoints, old failure-shape replay, successful SSE control replay, and AGY architecture review with controller PASS.
