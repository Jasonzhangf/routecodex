# Chat controlled fixture author acceptance

Scope: test-only change in `openai_chat_relay_controlled.rs`. No runtime,
transport, provider health, protocol projection, or live configuration change.

## Candidate

- Base HEAD: `6b3e7a5d8a1b5df8821447faaa081b50b402437d`.
- Fresh origin/main: `459004b113d31f79d818992509c1a1fb17639b66`.
- Tested source blob: `a571de1a9fd0e4a9beca6f707eb673aac7eab802`.
- Worktree: `/Volumes/Intel/playground/routecodex/chat-controlled-order-20261006-r162`.

## Observed failures and owner

The controlled upstream deliberately returns HTTP 429. The first failure cools
its exact provider/auth/model identity. The previous fixture then expected a
second provider capture from the same cooled identity. Its unlisted-model
success case also ran after that failure against the cooled default target.

Host run r161 with the earlier SSE identity split passed the SSE capture phase,
then failed the unlisted-model request with `IncompleteMessage`. This is a
fixture dependency error. It does not authorize changing provider health or
adding same-request recovery.

The fixture now declares a separate SSE provider identity and auth key. It
checks that identity in both SSE captures. The complete unlisted-model success
case runs while the default identity is healthy, before either intentional
provider failure. Its response, wire model, and default auth are asserted.

All original JSON/SSE success assertions, provider-error transport breaks,
control-plane isolation, and unlisted-model routing assertions remain. Both
upstream and aggregate shut down. Both fixture credential environment variables
are removed. There is no sleep, disabled health, relaxed assertion, or product
fallback.

## Author validation

Real public HTTP entry and controlled upstream:

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs \
  -p routecodex-v3-server --test openai_chat_relay_controlled \
  -- --test-threads=1 --nocapture
```

Host r164: exit 0; 1 passed, 0 failed. This executes the real
`/v1/chat/completions` JSON and SSE boundary, captures provider requests, checks
terminal buffering, and checks failure/isolation transport behavior.

Other checks: `cargo fmt --manifest-path v3/Cargo.toml -p
routecodex-v3-server -- --check`, `git diff --check`; both exit 0. Test file has
449 lines.

Evidence root:
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/`.
RED: `chat-controlled-fixture-r156/host-full-suite-r161.log` and `.exit`.
GREEN: `chat-controlled-order-r162/host-full-green-r164.log` and `.exit`.

The r162 GCM worker claimed a patch, but the actual source tree remained clean.
The parent preserved its records, terminated only its explicit child PID, and
implemented this scoped fix with `apply_patch`. Its compile of unchanged source
is not acceptance evidence. The host GREEN above binds the actual parent patch.

## Remaining delivery

Independent architecture review, normal hook commit and push, combination with
the current REQ02 candidate and latest main, CI and integration remain required.
This test-only delta requires no binary install or runtime restart by itself.
