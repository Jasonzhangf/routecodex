# V3 H4 Remote Continuation Contract/Store Codec Test Design

## Scope

feature_id:v3.remote_continuation_contract_store owns a Rust-only source module for remote provider
continuation locator, scope key, provider/model/auth pin, expiry, commit, load, release, and lossless
locator-only codec.

This slice is deliberately not connected to hub_v1.rs, Server endpoints, Relay restore or
materialization, local continuation, Provider transport, or live runtime.

## Resource and lifecycle

The resource is v3.continuation.remote_binding. The source-only H4 lifecycle is:

~~~text
V3RemoteContinuationCommitInput
  -> V3RemoteContinuationStore::commit
  -> immutable V3RemoteContinuationLocator
  -> encode/decode without semantic mutation
  -> V3RemoteContinuationStore::load with exact scope and pin
  -> V3RemoteContinuationStore::release
~~~

The eventual Hub lifecycle remains pending:

~~~text
V3HubRespContinuation04Committed
  -> remote binding commit
  -> immutable store interval
  -> V3HubReqContinuation03Classified
  -> pinned V3HubReqTarget06Resolved
~~~

H4 does not insert a Hub node or perform those pending calls.

## Node contracts

### Commit

- Input: direct-owner locator with Responses entry, endpoint, session, conversation, port, routing
  group, provider/model/auth pin, capability revision, commit time, and expiry.
- Output: one immutable locator keyed by remote response ID.
- Error: non-direct owner, non-Responses entry, or invalid expiry fails explicitly.
- Forbidden: local Chat Process context, history, tool state, provider payload, client payload.

### Codec

- Input/output: the locator contract only.
- Normal: decode(encode(locator)) == locator.
- Error: malformed JSON or any unknown field fails explicitly.
- Forbidden: cleanup, repair, owner inference, history/tool/context materialization.

### Load

- Input: explicit remote response ID, continuationOwner=direct, Responses entry/endpoint,
  session/conversation, port/group, exact provider/model/auth pin, provider availability, and time.
- Output: a borrowed immutable locator.
- Error: missing, wrong entry, wrong owner, scope mismatch, pin mismatch, expiry, or unavailable
  provider fails explicitly.
- Forbidden: cross-provider reselection and RouteCodex-local fallback.

### Release

- Input: exact remote response ID.
- Output: whether that locator existed and was removed.
- Forbidden: broad store clearing or local continuation mutation.

## White-box matrix

Positive:

- same Responses entry and endpoint;
- direct owner;
- same session/conversation and port/group;
- same provider/model/auth pin;
- available provider before expiry;
- codec round trip preserves exact locator.

Negative:

- chat or messages entry hits a Responses locator;
- relay owner hits a direct locator;
- same session with different port or group;
- different endpoint, session, or conversation;
- provider, model, or auth pin mismatch;
- expired locator;
- provider unavailable;
- duplicate remote response ID overwrite attempt;
- invalid expiry at commit;
- unknown local_context, history, or tool_state codec field;
- released or missing locator.

## Module black-box

v3/crates/routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs imports only the public
Runtime contract surface. It proves commit/load/codec/release behavior without reaching hub_v1.rs,
Server, Provider, Relay, or local continuation.

## Project black-box impact

There is no live project black-box in H4 because the goal explicitly forbids Hub/Server wiring and
live replay. Project gates only prove that the new module preserves V3 module boundaries, Rust-only
ownership, resource-map isolation, formatting, and workspace compatibility.

## Required gates

- npm run test:v3-h4-remote-continuation
- npm run verify:v3-module-boundaries
- npm run verify:v3-rust-only
- npm run verify:v3-resource-map
- npm run verify:v3-architecture-docs
- npm run verify:v3-cargo-fmt
- npm run test:v3-workspace
- git diff --check

## Known gaps and completion wording

Pending: Hub Resp04 commit wiring, Hub Req03 load/classification wiring, pinned Target resolution,
Server endpoint integration, local continuation, Relay materialization, controlled-upstream replay,
global install, restart, and production replacement.

Allowed completion wording:

> H4 remote continuation contract/store codec pre-module is implemented and verified.
