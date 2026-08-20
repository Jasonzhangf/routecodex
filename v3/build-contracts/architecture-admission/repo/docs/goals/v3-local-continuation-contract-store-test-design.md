# V3 Local Continuation Contract / Store / Codec Test Design

Feature: `v3.local_continuation_contract_store`

## Boundary

This slice is an isolated Rust contract/store/codec. It is not wired to Hub v1, Server, Relay
transport, P6, provider runtime, or `~/.rcc`. It creates no fallback and makes no continuation E2E
claim.

The only semantic creation/restoration APIs are:

```text
V3LocalContinuationResp04SaveInput
  -> V3LocalContinuationStore::commit_at_resp04
  -> lossless immutable record / codec / scope validation / expiry / release
  -> V3LocalContinuationStore::restore_at_req04
  -> V3LocalContinuationReq04Restored
```

The store never accepts Debug/snapshot truth, remote owner facts, provider/model/auth pins, or a
generic payload repair callback.

## Lifecycle matrix

| Outcome | Resp04 behavior | Req04 behavior |
| --- | --- | --- |
| success terminal | typed `NotStored(Success)` | not found |
| failure terminal | typed `NotStored(Failure)`; never projected as success | not found |
| non-terminal | exactly one immutable local context record | same-scope local owner restores exactly |
| already-terminal | typed `NotStored(AlreadyTerminal)`; cannot revive or overwrite | existing truth unchanged |

## Positive tests

- non-terminal context moves into Resp04 commit and restores at Req04 with byte/semantic equality;
- lossless codec round-trip returns the identical typed record;
- context remains stored until explicit release;
- terminal success/failure/already-terminal outcomes are explicit non-save results.

## Negative tests

- entry endpoint, session, conversation, port, or routing group mismatch;
- expired record;
- malformed/unknown/missing codec fields;
- duplicate context ID commit;
- remote/direct owner attempts to restore local truth;
- invalid expiry;
- Debug/snapshot/provider-pin fields injected into encoded records;
- generic `save`/`restore` APIs or save/restore boundary renames introduced by mutation.

## Required gates

- focused Rust contract tests;
- source verifier and mutation red fixtures;
- `npm run verify:v3-module-boundaries`;
- `npm run verify:v3-rust-only`;
- `npm run verify:v3-cargo-fmt`;
- `npm run verify:v3-clippy`;
- full V3 workspace tests;
- `git diff --check`.

## Completion limit

Passing these gates proves only the isolated local continuation contract/store/codec and its typed
Resp04/Req04 boundary; it does not prove live Relay. Hub hook registration, persistence transport,
continuation E2E,
Server cutover, P6 deletion, install, restart, and production replacement remain unproven.
