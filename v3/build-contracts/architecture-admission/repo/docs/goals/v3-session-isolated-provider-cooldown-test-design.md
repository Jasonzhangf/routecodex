# V3 Session-Isolated Provider Failure Test Design

Status: contract locked; red evidence and implementation pending.

## Lifecycle Under Test

```text
Server/ReqInbound validates x-routecodex-session-id control header
  -> typed failure session scope
  -> Runtime binds Provider availability to session
  -> Target reads current-session availability
  -> Provider attempt succeeds or fails
  -> Error01-05 produces session-bound recovery witness
  -> HealthStore records current-session failure/success
  -> ActionGate records/waits/admits current-session action
  -> Target-local reselect stays inside captured optional+default plan
  -> exhausted plan may atomically revive the same in-plan provider once
  -> success clears current session only
  -> failed revive preserves original cooldown deadline
  -> Error06 projects only after target/default/revive policy is exhausted
```

Global provider facts (`configured_disabled`, `health_disabled`, quota, concurrency) remain outside
the session failure state and continue to block every session when applicable.

## White-Box Matrix

### Provider Health owner

Positive:

- Three failures in session A produce A-only cooldown at the configured threshold/deadline.
- Session B remains available for the same provider runtime identity.
- A success clears only A failure/cooldown/revive-cycle state.
- An affirmative healthy sibling record allows one atomic revive for A.
- Failed revive preserves the original `cooldown_until_ms`; expiry restores ordinary selection.
- Success, expiry and idle cleanup remove bounded session state.

Negative:

- A1+B2 failures never combine into three failures.
- B success cannot clear A.
- Missing sibling record, expired sibling record, sibling cooldown, other server, other routing group,
  other auth alias, other model or other provider cannot authorize revive.
- Two concurrent callers cannot consume two revive tokens for one cooldown deadline.
- Failed revive cannot write `now_ms + cooldown_ms`, send before the original deadline or loop.
- Missing/empty session scope cannot read or write a legacy provider-global failure key.

### Provider Action Gate owner

Positive:

- Same-session failure generations retain isolated/medium/sustained delay behavior.
- Same-session recovery witness admits the exact generation and provider action.
- Same-session success releases matching waiters and clears matching state.

Negative:

- Session A failure/waiter/permit/generation/terminal commit does not affect session B with otherwise
  identical server, group, provider and error family.
- B success does not release or reset A.
- Wrong-session recovery witness is rejected; it cannot be rebound to the active lane.
- Abandon/terminal operations never iterate across sessions.

### Error05 witness

Positive:

- Builder and serialization preserve non-empty `session_id` through retry, reselect and terminal
  admission paths.

Negative:

- Empty session is rejected.
- A witness cannot be consumed by a B-scoped gate.
- Error06 projection does not add, infer or rewrite session identity.

## Module Black-Box Matrix

Each entry must cover JSON and SSE where the protocol supports both.

| Runtime entry | Success evidence | Failure evidence | Post-commit evidence |
| --- | --- | --- | --- |
| Responses Direct | A success clears A only | A failures cool A; B still sends | stream failure records A only |
| Responses Relay | A/B isolation and in-plan reselect | codec/transport errors use A scope | provider event EOF/error records A only |
| OpenAI Chat Relay | A/B isolation | transport/codec failure uses A scope | SSE failure records A only |
| Anthropic Relay | A/B isolation | transport/codec failure uses A scope | SSE failure records A only |
| Gemini Relay | A/B isolation | transport/codec failure uses A scope | SSE failure records A only |

Request-local ProviderReqCompat failure remains request-local and does not create HealthStore or
ActionGate session state. Client disconnect remains health-neutral.

## Project Black-Box Matrix

1. Missing existing request session ID at each supported HTTP entry returns an explicit client-input
   Error01-06 response before route/provider send. Body metadata, `request_id` and
   conversation ID do not substitute.
2. Same listener, same provider, two explicit sessions: A reaches three failures and cools; B still
   reaches provider and succeeds.
3. B success does not change A health/action diagnostics.
4. A captured optional+default plan exhausts; a healthy B record for an A-plan provider grants one
   A revive without another VR hit.
5. Failed A revive produces no second send before the original deadline and does not extend it.
6. At original deadline, A returns to normal candidate evaluation.
7. Global configured-disable/quota/concurrency still blocks both A and B.
8. Provider request/response captures, attempts, failure event and console all identify the same
   session without placing internal scope in provider/client normal payload.

## Architecture Red Fixtures

Red fixtures must fail when any of these is reintroduced:

- Health failure/cooldown key without server, routing group or session.
- ActionGate provider scope/key or Error05 witness without session.
- Runtime entry/call site invoking health/action/recovery without typed session scope.
- Session extracted from generic client headers, body metadata, continuation, console,
  MetadataCenter, request ID or conversation ID.
- Virtual Router health import, Target health mutation, second VR hit or selection-plan rebuild.
- Revive provider absent from current captured plan.
- Missing sibling record treated as healthy.
- Failed revive replaces original deadline.
- TS business implementation, persistent cooldown or Error06-to-health reverse dependency.
- New verifier absent from `package.json`, CI or the V3 architecture umbrella.

## Required Verification Stack

Source gates:

- Provider health unit tests and concurrency tests.
- Provider action gate contract tests.
- Error chain/recovery witness tests.
- Target/runtime Direct and all Relay protocol integration tests.
- Server multi-listener blackbox tests.
- Session-cooldown source verifier plus red fixtures.
- V3 resource/function/mainline/manifest/wiki gates.
- Rust fmt, clippy, workspace tests and V3 CLI build.

Runtime gates:

- Install V3 from the verified source and prove installed hash/version alignment.
- Run the configured aggregate restart once, then verify every member health endpoint.
- Replay controlled real HTTP samples for A/B isolation, one revive, failed-revive deadline and
  deadline-expiry re-entry.
- Inspect canonical samples/logs by port/request ID; test assertions alone are insufficient.
- Run Codex review only after runtime evidence. Any subsequent code/test/build/runtime-config change
  invalidates the review and requires affected verification plus review again.

## Known Gaps At Design Time

- Current `V3ProviderHealthStore` failure maps are provider-global.
- Current `V3ProviderActionGate` lanes and `V3Error05RecoveryAdmissionWitness` lack session.
- Current Direct raw request and Relay runtime inputs do not consistently carry a validated failure
  session scope.
- Current implementation has no affirmative sibling-health registry or atomic revive token.
- No current gate proves failed revive preserves the original cooldown deadline.
- No install/restart/live evidence exists for this contract.
