# REQ02 Tool Call Namespace Presence Author Evidence

## Scope

- Added `v3/crates/routecodex-v3-server/tests/req02_tool_call_namespace_presence.rs`.
- Read-only frozen sources under test:
  - `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`
  - `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_records.rs`
  - `v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs`
- No product code, existing test, gate, install, restart, commit, merge, or push changes were made.

## Public Consumer Cases

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_call_namespace_presence -- --nocapture
```

Result: exit `0`.

Raw log: `.execution/namespace-r16-test.log` (`80638` bytes).

Observed test result:

```text
running 4 tests
test openai_chat_explicit_null_tool_call_namespace_remains_null ... ok
test openai_chat_absent_tool_call_namespace_remains_absent ... ok
test responses_explicit_null_tool_call_namespace_remains_null ... ok
test responses_absent_tool_call_namespace_remains_absent ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Each public consumer uses:

```text
capture_client_json -> normalize_losslessly -> original_pair
```

Coverage:

- `openai-chat` with `messages[0].tool_calls[0].namespace` absent.
- `openai-chat` with `messages[0].tool_calls[0].namespace` explicit `null`.
- `responses` with `messages[0].tool_calls[0].namespace` absent.
- `responses` with `messages[0].tool_calls[0].namespace` explicit `null`.
- Every case carries both a `custom` call and a `function` call.
- Canonical history preserves the difference between a missing `namespace` key and an explicit `null` value.
- Typed original history namespace is `None` for absent and `Some(Value::Null)` for explicit null.
- `call_id`, original tool name, and the complete free-text `exec` input or `apply_patch` arguments, including the trailing sentinel, are asserted byte-for-byte.

## Formatting

Command:

```text
rustfmt --edition 2021 --check v3/crates/routecodex-v3-server/tests/req02_tool_call_namespace_presence.rs
```

Result: exit `0`.

Raw log: `.execution/namespace-r16-rustfmt.log` (`0` bytes).

## SHA256

```text
a05663f7f30438e9fbe485962d89e3b27e96150bac732097ae12fa8c814de4ac  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs
1c1f46167a4f2c6602ef36efed5947560fa7bc7c38c201077ce47457f2b96c3d  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_records.rs
b1fce25bd34f8a047df6cbe00520837bcd6e1bb51672dffbb99523a383bae7ba  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
210a7e7b9fed942d51500c00829f38b37a2ab47c0a8fb82e10cca28ea66c72d2  v3/crates/routecodex-v3-server/tests/req02_tool_call_namespace_presence.rs
```

## Exit Files

- `.execution/namespace-r16-test.exit`: `0`
- `.execution/namespace-r16-rustfmt.exit`: `0`
