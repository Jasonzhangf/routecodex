# REQ02 Mixed Responses History Test Result - 2026-10-03

## Scope

- Added only `v3/crates/routecodex-v3-server/tests/req02_mixed_responses_history.rs`.
- Public entry: `execute_v3_operation_runner_request_capture_client_json` ->
  `execute_v3_operation_runner_request_normalize_losslessly` with a fresh
  `V3RequestContextHandle` and `RequestInvocationContext` per test.
- No product, configuration, existing frozen test, or other file was modified.
- No commit, push, install, or restart was performed.

## Command

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_mixed_responses_history -- --nocapture
```

## Result

- Exit code: `101`
- Test result: `1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out`
- Tree HEAD: `688f7a1c6a15ecf45dfee12cc430148ae3c03898`
- `origin/main` read from this tree: `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`
- Test file SHA-256:
  `685f8fbeec139fbecbc5e6d41448a36b571471555f4bb0a5af2a91ebe6d69265`
- Permanent raw log:
  `docs/goals/req02-mixed-responses-history-20261003.log`
- Raw log SHA-256:
  `5930ab6a5cd171c4582f73edad5e329665fedb86d5840fa6d57dd40d1cf49165`

## Original Failures

```text
thread 'responses_messages_call_plus_input_output_preserve_complete_typed_history' panicked at crates/routecodex-v3-server/tests/req02_mixed_responses_history.rs:100:5:
assertion `left == right` failed
  left: 1
 right: 2

thread 'responses_messages_result_plus_duplicate_input_output_keep_two_histories' panicked at crates/routecodex-v3-server/tests/req02_mixed_responses_history.rs:186:5:
assertion `left == right` failed
  left: 1
 right: 2
```

The matching `input: "hi"` plus `messages` user-history case passed. The
call/result cases remain RED in this tree: canonical `messages` contains one
entry where two call/result histories are required.
