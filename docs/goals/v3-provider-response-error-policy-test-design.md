# V3 Provider Response Error Policy Test Design

## Objective

Turn provider terminal responses that match configured provider-local error policy into the existing typed Error01-06 path before provider success and Resp04 continuation commit. Preserve one policy identity and one disposition path from terminal-response classification through retry/backoff and final Error06 projection.

## Lifecycle

```text
provider terminal JSON / materialized SSE
  -> extract bounded ProviderResponseFacts
  -> first configured policy match
  -> typed V3ProviderFailureDirective side-channel
  -> Error01-05 retry/reselect/cooldown decision
  -> configured minimum backoff through Provider Action Gate
  -> success: Resp03/Resp04 + provider-success record
  -> exhaustion: one configured Error06 projection
```

## Owners and boundaries

- Config authoring/compile owner: `routecodex-v3-config`.
- Terminal fact extraction and semantic-failure construction owner: Responses Relay runtime before Resp03.
- Retry timing/admission owner: `v3.provider_action_gate`.
- Final HTTP/public-code projection owner: typed Error06 consumer.
- `V3ProviderFailureDirective` is an error/control side-channel. It must never enter provider/client payload, MetadataCenter, continuation context, debug snapshot, or protocol metadata.
- SSE transport and Server handler remain framing/projection only.

## White-box matrix

### Config

- Provider-local policy accepts exactly one of legacy `action` or full `path`.
- Full path compiles with injected provider id/type scope.
- `path + action`, neither, invalid attempt/backoff, and non-final project fail fast.
- Legacy `semantic_error_policy.action` still compiles unchanged.

### Response facts and matching

- Chat `choices[].message.content`, `choices[].delta.content`, and finish reason.
- Anthropic root `content[].text` and `stop_reason=end_turn`.
- Responses `output[].content[].text`, wrapped `response.output[]`, terminal status.
- Root/wrapped `error.code`, `error.type`, `error.message`, plus root `message`.
- Keywords only in id/model/metadata do not match.
- Valid ordinary HTTP 200 output does not match.

### Directive and policy execution

- First match carries exact policy id/reason/path; Error05 does not re-match compressed message.
- Two similar policies cannot switch identities after classification.
- `max_attempts=3` means initial send plus two same-provider retries.
- Retry delays follow `max(action_gate_delay, configured_backoff)` with saturating exponent and 60-second cap.
- Success on retry stops further retry/project and only successful response reaches Resp04.
- Exhaustion emits one Error06 projection with configured status/public code.

## Black-box matrix

- JSON HTTP 200 embedded error is rejected before continuation commit.
- Materialized provider SSE with same terminal error matches identically.
- Second attempt success commits only successful response.
- Exhausted attempts leave continuation at pre-request state.
- Real HTTP 429 can use same provider-scoped manifest path and map to configured 503.
- Positive control: normal provider HTTP 200 content completes unchanged.

## Required verification

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
