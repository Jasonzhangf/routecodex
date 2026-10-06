# REQ02 lifecycle module-size split result (2026-10-03)

Status: `SLICE_COMPLETE`

## Scope

- Continued the existing REQ02 identity lifecycle slice without restoring old main content.
- Moved complete items only. No wrapper, forwarding call, retry path, compression, or comment-only line reduction was added.
- Parent-owned maps, profiles, graphs, main, install, restart, Collab, goal, commit, merge, and push were untouched.

## Red evidence

- `npm run verify:v3-file-size` exit `1` before the split.
- Log: `docs/goals/req02-identity-plumbing-20261003-logs/req02-lifecycle-size-red-file-size.log`
- SHA-256: `d0263415df027bfef9351df9fbcf1ec4d04e07c449eb64708ed5d793a51689d0`
- Baseline consumer behavior was already green before the split (15 PASS); only file size was red.
- Log: `docs/goals/req02-identity-plumbing-20261003-logs/req02-lifecycle-size-baseline-consumers.log`
- SHA-256: `730f960a795e1923992e117aa1ffb3684faf733e2c714dcfe47ec8533a3bcdd9`

## Moves

- `kernel.rs::finish_direct_request_scope` moved intact to `kernel/direct_request_scope.rs`; the original site now has one `include!` at the same position.
- `openai_chat_relay_runtime.rs::openai_chat_provider_http_failure` moved intact to `openai_chat_relay_failure_output.rs` as `pub(super)` and is imported by the original parent scope.
- `relay_runtime_core.rs::execute_v3_relay_runtime_core` moved intact to `relay_runtime_core/request_scope.rs`; the original site now has one `include!` at the same position.
- `responses_relay_runtime_tests.rs::openai_chat_provider_usage_normalizes_to_hub_canonical_token_names` moved intact to existing `responses_relay_runtime_tests_extra.rs`.

## Final line counts

```text
1476 v3/crates/routecodex-v3-runtime/src/kernel.rs
1574 v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs
1488 v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs
1465 v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests.rs
```

## Green evidence

```text
npm run verify:v3-file-size
exit 0
```

Log: `docs/goals/req02-identity-plumbing-20261003-logs/req02-lifecycle-size-green-file-size.log`

SHA-256: `85fa8a1108656dbd689e45c8555b7c1a722e8b7621d222f65b954ed9e9aff7bb`

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer --test req02_shared_relay_scope --test req02_direct_scope_edges --test req02_protocol_relay_consumers --no-fail-fast -- --nocapture
exit 0
15 PASS
```

Log: `docs/goals/req02-identity-plumbing-20261003-logs/req02-lifecycle-size-green-consumers.log`

SHA-256: `ab00d7875cd56025587be5e697e86c47a8539bce760916848d212a912d3b09dd`

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib -- --nocapture
exit 0
1136 passed; 0 failed; 1 ignored
```

Log: `docs/goals/req02-identity-plumbing-20261003-logs/req02-lifecycle-size-runtime-lib.log`

SHA-256: `ed5cec5662c93e478eb612a9ba817ba1a9d5e4bff4965046e654a10ea18c6d6a`

`rustfmt +stable --edition 2021 --check` on all changed Rust files: exit `0`.

`git diff --check` on all changed Rust files: exit `0`.

## Source hashes

```text
87fbaa4c4d969cbd4bd5bd01e29fe2b70800185fe4393acf681bad60ebf81d59  v3/crates/routecodex-v3-runtime/src/kernel.rs
91cbe74f2fffc9ed672f5d27c87b5909cbded1589912864f980ae8b8078978df  v3/crates/routecodex-v3-runtime/src/kernel/direct_request_scope.rs
d60d82abaa103549434b3b2192b01c5bbecde49c52eb84097400ecedb2ef5336  v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs
5e52d4113d64a5ae78b80bbb50d986884261e39d06f872913c066e7567386e4b  v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_failure_output.rs
a9b5bf0c735d6b6c3dc67b7c4a9c14c7dfdb0baa53380dbf76fa39ccb60bd377  v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs
90b4bfa1a88d78ad9fff191a3e2ce4a11791ec2c57c838bbfd86a34e4b3cbb6b  v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core/request_scope.rs
6a97a459afb061ff49c16f114387728c90c785ee47899c3a711f4ae94c83c7dd  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests.rs
620b3fb994ae8d4074e64739bed2e56a386ac235558f4d2c6c576ad4bfb095b1  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_tests_extra.rs
```

## Remaining boundary

- This receipt proves the source relocation, size gate, public scope consumers, and runtime development regression.
- It does not claim install, restart, live replay, review, merge, push, or post-merge runtime acceptance.
