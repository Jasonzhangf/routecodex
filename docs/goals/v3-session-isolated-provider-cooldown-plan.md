# V3 Session-Isolated Provider Failure Plan

Status: implementation in progress; source/runtime/live evidence incomplete.

## 1. Objective

Move every provider-failure-derived state from process-wide provider isolation to:

```text
server_id + routing_group + session_id + provider_runtime_identity
provider_runtime_identity = provider_id + auth_alias + model_id
```

`normalized_error_family` remains an ActionGate sub-dimension. It never replaces `session_id`.
Session A failure, cooldown, retry/reselect admission, waiter, permit, success release, terminal
commit or recovery witness must not affect session B.

## 2. Typed Session Contract

Server/ReqInbound is the only origin of `session_id`. It reads the current HTTP request data plane,
validates a non-empty value and constructs `V3ProviderFailureSessionScope`. Direct and every Relay
runtime input carry that type explicitly through JSON, SSE and post-commit paths.

Missing `session_id` enters Error01-06 before provider send. The runtime must not derive or replace it
with routing group, request ID, conversation ID, continuation scope, console identity,
MetadataCenter, debug data, thread-local state or a process singleton. There is no legacy global-key
fallback.

## 3. Owners And Boundaries

- `V3ProviderHealthStore` uniquely owns consecutive failures, session cooldowns, affirmative sibling
  health evidence, atomic revive tokens, original cooldown deadlines and cleanup.
- `V3ProviderActionGate` owns session-isolated 1/3/5-second recovery lanes, waiters, permits,
  generations, success releases, abandonment and terminal commits.
- `V3Error05RecoveryAdmissionWitness` carries the same typed session scope and cannot be consumed by
  another session lane.
- Runtime owns provider-failure recovery orchestration.
- Target only consumes a session-bound read-only availability reader. It never reads or mutates the
  HealthStore.
- Virtual Router remains health-blind and is hit once. Recovery re-expands and reselects only from
  the immutable `V3Router07OpaqueTargetHitOnce.target_plan` captured in `selected.route`.
- Error06 only projects a terminal Error05 decision. It never decides health, retry or reselect.

Only failure-derived punishment becomes session-local. `configured_disabled`, `health_disabled`,
quota and concurrency remain provider-global objective facts. Request-local provider compatibility
failure remains request-local. `client_disconnect` remains health-neutral.

## 4. Health And Revive State Machine

1. The same session must fail the same provider runtime identity three times before that session
   enters cooldown. Failures from different sessions never combine.
2. Success clears only the current session's failure count, cooldown, revive cycle and matching
   ActionGate state. It also records affirmative health evidence for that session/provider identity.
3. When the current immutable route plan is exhausted, Runtime may ask HealthStore for one atomic
   revive of the same in-plan provider identity.
4. Revive requires an explicit valid success/healthy record from another session under the same
   server, routing group and provider runtime identity. Missing records are not health evidence.
5. The revive token is bound to the current session/provider/original `cooldown_until_ms`. At most
   one concurrent caller consumes it for that cooldown cycle.
6. Revive success clears current-session state only.
7. Revive failure preserves the original `cooldown_until_ms`. It must not write
   `now_ms + cooldown_ms`; no second revive or provider send is allowed before the original deadline.
8. At the original deadline the provider returns to ordinary candidate evaluation.
9. Success, expiry and bounded idle cleanup remove session state. Cooldown/provider health is never
   persisted.

## 5. Required Runtime Surfaces

- Responses Direct JSON and SSE, including response codec and post-commit stream failure.
- Responses Relay JSON and SSE.
- OpenAI Chat Relay JSON and SSE.
- Anthropic Relay JSON and SSE.
- Gemini Relay JSON and SSE.
- Provider transport, provider response codec, non-terminal, terminal and already-terminal paths.
- ActionGate failure/wait/recovery/success/terminal paths and Error05 witness serialization.

No TypeScript business implementation, provider-specific branch, second VR hit, rebuilt default
route, cross-plan provider, Server-side retry policy, MetadataCenter carrier, persistent health or
fallback is allowed.

## 6. Test Design

The authoritative matrix is
`docs/goals/v3-session-isolated-provider-cooldown-test-design.md`.

Minimum positive locks:

- A three failures cool A only; B immediately sends the same provider.
- A exhausted plan plus affirmative healthy B record grants one atomic A revive.
- Revive success clears A only.
- Failed revive becomes ordinarily eligible only at the original deadline.

Minimum negative locks:

- A1+B2 never combine; B success never clears or releases A.
- Missing/wrong-session scope fails before provider send and cannot hit another ActionGate lane.
- Missing sibling record, wrong server/group/provider/auth/model or cooled sibling cannot revive.
- Concurrent exhausted calls receive at most one revive token.
- Failed revive does not extend its deadline and cannot send twice before expiry.
- Runtime recovery never calls Virtual Router again and never selects outside `selected.route`.
- Target has no health mutation, VR has no health import, TS has no second implementation.

## 7. Verification And Completion

Required source evidence:

- genuine pre-change red verifier and behavioral tests;
- provider-health, ActionGate, Error05, Target/Runtime and every Direct/Relay JSON/SSE paired test;
- resource/function/mainline/verification maps, lifecycle manifest, wiki and mutation fixtures;
- gate wiring in `package.json`, V3 build/architecture umbrella and CI;
- `cargo fmt`, Clippy, workspace tests and V3 CLI build.

Required runtime evidence:

- global install artifact hash/version matches verified source;
- one aggregate `routecodex restart --port <locator-port>` and every member `/health` passes;
- controlled real A/B replay proves A-only cooldown and B success;
- controlled exhaustion replay proves one revive and no second provider send before the original
  deadline after revive failure;
- canonical provider request/response, attempts, provider failure event and console/session evidence
  agree for each request.

Codex review runs only after source, install, restart and live evidence. It must return an explicit
semantic PASS. Any later code, test, build or runtime-config edit invalidates that PASS and requires
the affected verification, install/restart/live replay and review again.

Completion requires all evidence above, a precise commit, note/MEMORY/skill closure and searchable
MemoryPalace re-mine. Local tests or documentation alone are not completion.
