# REQ02 nested child declaration kind presence correction result

Status: fixed and verified for the SDK public normalization behavior covered by this task.

## Scope and owner

- Base main: `75cab8267`.
- Task worktree:
  `/Volumes/Intel/playground/routecodex/req02-nested-declarations-20261003`.
- Feature owner: `v3.unified_operation_runner_design`.
- Unique implementation point:
  `push_openai_like_child_declaration` in
  `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`.
- The namespace traversal still calls `push_openai_like_child_declaration` once
  per direct child. The child helper now reads the child's explicit `type` and
  creates a typed declaration only for explicit `function` or `custom`.
- The child helper continues to use `openai_like_tool_identity` only for the
  original `name`, preserving the existing nested-function/custom name
  association without adding a second name scan or a protocol/model branch.
- Missing `type`, `type: null`, and unknown `type` values remain untyped and
  stay in the original canonical tools list and the namespace container's
  opaque record.
- No existing test assertion or unknown-type business payload was changed.

## First divergence and red evidence

Before the helper change, `openai_like_tool_identity` defaulted a missing or
non-string `type` to `function` in
`v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`.

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_nested_declarations -- --nocapture
```

- Exit: `101`.
- Result: `2 passed; 1 failed`.
- First divergence:
  `missing, null, or unknown child type must not create a typed declaration at request.tools[0].tools[2]`.
- Log:
  `.execution/req02_nested_kind_presence.red.log`
- Log SHA256:
  `fd4768600c6b992a78e9aff4b6a1b9a84415c88940bd205a230b45467cbb5a24`.

## New public regression

The new test is:

```text
responses_namespace_children_require_explicit_known_type_and_preserve_name_presence
```

It enters through the public capture and lossless-normalization entry functions
and covers, across namespace containers and their `tools` arrays:

- explicit `function`;
- explicit `custom`;
- an object with no `type` but with a `name`;
- an object with `type: null`;
- an object with another unknown `type`;
- namespace containers whose `name` is absent, explicit `null`, and a string.

The test asserts that:

- the canonical `tools` value remains exactly equal to the original value;
- each namespace container's opaque record preserves the exact original object;
- child namespace presence distinguishes absent from explicit `null` and string;
- typed child declarations exist only for explicit `function` and `custom`;
- missing, null, and unknown child types do not create a typed declaration;
- the public `ToolDeclarationReference` is destructured without `..`, proving
  its control surface is identity-only and retains no schema or parameter
  payload.

## Implementation hashes

| Artifact | SHA256 |
| --- | --- |
| `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs` | `21f604d44055ec688e9944d95ea380faaf77709af9b68269e5fdd76f26316834` |
| `v3/crates/routecodex-v3-server/tests/req02_nested_declarations.rs` | `02e8f29c13288e16a71f609bb2894f8a34647d4ee9adce4a7f4fb1940d528219` |
| `docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml` | `3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417` |

## Verification

Each command was run separately with output redirected to its own task-local
`.execution` log. The reported exit codes are the command exit codes observed
by the task shell.

| Command | Exit | Result | Log SHA256 |
| --- | ---: | --- | --- |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_nested_declarations -- --nocapture` | 0 | 3 passed / 0 failed | `b17cab1b4e9bee309baa0a157baf461e46a3670e9a8ccd860abf958c8a600703` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture` | 0 | 4 passed / 0 failed | `459018d26306226d7dd6ef09091ef868e76064c94c6978c2c7532ec7ec3f1886` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_namespace_presence -- --nocapture` | 0 | 2 passed / 0 failed | `2d1f28302982838f12298739c672e12b20445f80dafe0ad63db34cf1b4dfb7fe` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture` | 0 | 5 passed / 0 failed | `8816a46c67c3be16b8889148f147f70a34d891771781c6c49e6305dfcf5d78ee` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture` | 0 | 51 passed / 0 failed; 1085 filtered | `4333424fd51ede47476ce2fc0119ef734be135f7a31e8908c5bef8be24d11095` |

`git diff --check` was run separately and exited `0`.

## Evidence boundary

This result proves only the public SDK normalization behavior exercised through
the public runtime entry functions in the tests. It does not claim HTTP/WS
delivery, installed runtime behavior, provider calls, actual tool execution, or
any node-level delivery. No install, restart, commit, merge, push, or review was
performed.
