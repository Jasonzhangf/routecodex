# V3 SSE transient failure health-policy test design

Design ID: `V3-SSE-TRANSIENT-NO-PROVIDER-COOLDOWN-20260816`

## Lifecycle and owner

Provider SSE transport/decode/EOF failures enter the typed Error chain and Runtime provider-failure policy. Before any replay-unsafe business byte reaches the client, the existing Direct/Relay retry and target reselection path owns recovery. After business-byte commit, the current stream must fail explicitly because replay would mix two provider outputs; the post-commit observer may close its action-gate permit but must not mutate provider health.

The unique health-policy owner is `V3ProviderFailureRuntimeHealth` plus `V3ProviderHealthStore`. SSE transport and Server remain framing/lifecycle-only.

## White-box tests

- Three post-commit SSE failures do not create consecutive provider failures, provider cooldown, or a cooldown probe.
- A fresh session still sees the same provider key as available after those failures.
- The action-gate failure observation still completes so a committed stream does not leak an in-flight permit.

## Module and project black boxes

- A Responses Direct stream containing only empty lifecycle frames followed by provider failure or EOF remains pre-commit and enters the existing retry/reselect state machine.
- A genuine output/tool frame still authorizes incremental client streaming; a later error fails that stream without replaying a second provider into it.
- Real non-SSE provider errors such as HTTP 401/403 continue to use the manifest-configured failure threshold and provider cooldown policy.

## Positive and negative evidence

- Positive: controlled pre-commit failure retries/reselects and ends in HTTP 200 from the selected healthy candidate.
- Negative: repeated post-commit SSE failure cannot change another session's availability or create provider probe state.
- Control: repeated configured HTTP provider failures still create cooldown at their configured threshold.

## Required closeout

Focused Rust red/green tests, V3 provider-health/action-gate gates, architecture/module/resource gates, release install from the committed clean worktree, aggregate `routecodex restart`, all configured health endpoints, old failure-shape replay, successful SSE control replay, and DSH architecture review.
