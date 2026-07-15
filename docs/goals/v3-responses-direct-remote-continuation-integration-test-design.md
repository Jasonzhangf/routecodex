# V3 Responses Direct Remote Continuation Integration Test Design

## Lifecycle

~~~text
turn 1 Responses request
  -> Virtual Router once
  -> V3HubReqTarget06Resolved routed target
  -> provider function_call response
  -> V3HubRespContinuation04Committed remote locator
  -> immutable locator interval
turn 2 function_call_output + previous_response_id
  -> V3HubReqContinuation03Classified direct remote locator
  -> V3HubReqTarget06Resolved exact provider/model/auth pin
  -> same provider terminal response
  -> release locator
~~~

Req03 performs only owner/entry/scope/expiry/capability classification. Req06 alone resolves and
validates the exact provider/model/auth pin. A remote turn never enters Relay/local materialization,
Virtual Router, or target-local reselection.

## Scope truth

Every locator binds endpoint, direct owner, session, conversation, listener port, routing group,
provider, canonical model, auth alias, capability revision, commit time, and expiry. Missing or
conflicting truth is an Error01-06 failure. Provider/auth/control truth is side-channel only.

## State matrix

| State | Expected action |
| --- | --- |
| pending function call | Resp04 commits immutable remote locator |
| still running with pending tool | keep locator; do not project terminal success |
| terminal success | release matching locator after client semantic projection is determined |
| terminal failure | Error01-06; release only the matching locator |
| already terminal continuation | reject before provider send |
| missing/expired/scope mismatch/owner mismatch | reject at Req03 |
| pin/capability/provider availability mismatch | reject at Req06 |
| duplicate commit | fail at Resp04; never overwrite |

## Positive gates

- JSON and SSE controlled upstream: function_call -> Resp04 commit -> function_call_output with
  previous_response_id -> Req03 load -> Req06 exact pin -> terminal success.
- First turn contains one Virtual Router hit; continuation turn contains zero Router nodes and no
  target-local reselection.
- Provider request preserves previous_response_id and tool output while excluding provider/auth,
  route, locator, Debug, and continuation-control fields.

## Negative gates

- chat/messages entry, Relay owner, missing locator, duplicate commit;
- endpoint/session/conversation/port/group mismatch;
- provider/model/auth/capability mismatch, expiry, unavailable provider;
- still-running, already-terminal, and terminal provider failure;
- Error01-06 polarity and provider/client normal-payload isolation.

## Red baseline

Before implementation, H4 store/codec tests pass while `v3.continuation.remote_binding` remains
`binding_pending`, the Direct kernel has no Resp04 commit/Req03 load/Req06 pin symbols, and two
independent turns each hit Virtual Router. That exact mismatch is the required red evidence.

## Required verification

- focused Rust state/contract tests and JSON/SSE controlled replay;
- remote integration source verifier plus positive/negative mutation fixtures;
- P6 freeze/equivalence and Error01-06 regression;
- architecture/resource/module/Rust-only/fmt/clippy/workspace gates;
- current 5555 same-entry two-turn request replay without configuration, credential, or ownership
  mutation.

## Completion boundary

Completion requires real Resp04/Req03/Req06 source bindings and both controlled and current-5555
two-turn evidence. Unit-only or store-only evidence is insufficient.
