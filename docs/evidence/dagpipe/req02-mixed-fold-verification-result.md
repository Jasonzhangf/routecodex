# REQ02 mixed fold verification result

Status: test/gate slice complete. One product behavior remains RED in the frozen
snapshot. This result does not claim REQ02 delivery.

## Scope

- Working tree: `/Volumes/Intel/playground/routecodex/req02-mixed-fold-tests-20261003`
- Frozen base: `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`
- Public entry: `capture_client_json -> normalize_losslessly -> original_pair`
- Added: `v3/crates/routecodex-v3-server/tests/req02_mixed_history_preservation.rs`
- The required six fold negative cases were already present in the frozen
  working-tree version of `v3/scripts/tests/v3-operation-runner-red-fixtures.mjs`;
  this slice verified them without weakening or duplicating them.
- `v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs` was not
  changed because every required negative fixture produced a non-zero verifier
  exit and the expected diagnostic.

## Public behavior tests

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable \
  -p routecodex-v3-server --test req02_mixed_history_preservation -- --nocapture
```

Result: exit `101`; 4 passed, 1 failed.

Passed:

- distinct complete opaque outputs with the same call ID remain two messages
- different unknown values across two sources remain two messages and preserve
  both original values
- partial non-tool overlap across `messages` and `input` remains four messages
- one primary tool result plus two equivalent secondary results remains two
  messages with all three source associations

Expected product RED:

- `repeated_tool_results_within_secondary_source_preserve_occurrences`
- Two repeated `function_call_output` items in `input`, with the same call ID
  and output, currently normalize to one canonical message.
- Required behavior is two canonical occurrences because repeated entries
  within one source are not globally deduplicated.

Raw evidence:

- `.execution/req02-mixed-history-preservation-test.log`
- `.execution/req02-mixed-history-preservation-test.exit`

## Gates and checks

`npm run verify:v3-operation-runner-dagpipe`: exit `0`; required graphs `1`,
deferred graphs present `2`, operator-version checks passed.

`npm run test:v3-operation-runner-red-fixtures`: exit `0`; these negative cases
failed as expected:

- `unknown-fold-operator`
- `unknown-fold-source`
- `unknown-fold-policy`
- `duplicate-fold-owner`
- `duplicate-fold-source-order`
- `duplicate-fold-finalizer`

`node --check` passed for both modified JavaScript paths in the frozen snapshot.
`rustfmt --edition 2021 --check` passed for the new Rust test. `git diff --check`
passed for the tracked scripts. `git diff --no-index --check /dev/null <new
test>` returned `1` only because the new file differs from `/dev/null`; it
produced no whitespace diagnostic.

Raw evidence:

- `.execution/req02-verify-v3-operation-runner-dagpipe.log`
- `.execution/req02-verify-v3-operation-runner-dagpipe.exit`
- `.execution/req02-v3-operation-runner-red-fixtures.log`
- `.execution/req02-v3-operation-runner-red-fixtures.exit`
- `.execution/req02-node-check-red-fixtures.log`
- `.execution/req02-node-check-red-fixtures.exit`
- `.execution/req02-node-check-dagpipe-verifier.log`
- `.execution/req02-node-check-dagpipe-verifier.exit`
- `.execution/req02-rustfmt-check.log`
- `.execution/req02-rustfmt-check.exit`
- `.execution/req02-diff-check-tracked.log`
- `.execution/req02-diff-check-tracked.exit`
- `.execution/req02-diff-check-new-test.log`
- `.execution/req02-diff-check-new-test.exit`

## File hashes

```text
e192b66668c82915accea2194816a5a0c45e20736f058a2d8f9e14de2d0e52c3  v3/crates/routecodex-v3-server/tests/req02_mixed_history_preservation.rs
8b679e90865e8d19792aace8124979f64435e2935b88c1bfddf48df70790658d  v3/scripts/tests/v3-operation-runner-red-fixtures.mjs
c96751c5b98e3db65bef30372315a3f49af771eb3b98ea63a2c333d57a74d30b  v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs
```

## Boundary

This result covers only public request-normalization tests and the existing
static/red-fixture gates. It does not include product implementation changes,
install, restart, live replay, review, commit, merge, push, or REQ02 delivery
acceptance.
