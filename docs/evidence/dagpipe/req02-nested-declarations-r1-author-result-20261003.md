# REQ02 namespace sub-tool declaration result

Status: fixed and verified for the SDK public normalization behavior covered by this task.

## Scope and owner

- Feature owner: `v3.unified_operation_runner_design`.
- Unique implementation point: `tool_declaration_transform` in
  `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`.
- The existing `process_openai_like_tool` traversal now records direct
  `function`/`custom` children of a `type=namespace` container before the
  original declaration list is emitted unchanged.
- Child namespace is taken only from the standard namespace container `name`.
  No model-name, tool-name, schema-content, or provider-payload inference was
  added.
- Unknown children and unknown container/child siblings remain in the original
  business list and opaque records; they are not promoted into typed identity.

## First divergence and red evidence

- Parent-provided red command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture
```

- Red result before this edit: exit 101, 3 passed / 1 failed.
- Failure:

```text
missing typed declaration for `request.tools[0].tools[0]`
```

- Red log:
  `/tmp/req02_tool_shapes.red.log`
- First divergence: `process_openai_like_tool` called
  `push_tool_declaration` once for the outer `namespace` item and did not walk
  its direct `tools` array.

## Change

- File:
  `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`
- SHA256:
  `5b475a19cfd56c765e535fab5a0e79f6a718480bf895d877130959eff3065a87`
- New public black-box test:
  `v3/crates/routecodex-v3-server/tests/req02_nested_declarations.rs`
- Test SHA256:
  `ff6c838781a31a3e7772ef82208a083d924ee1b15b3a83feab2d93205fc2d4d2`
- Read-only profile dependency SHA256:
  `3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417`

The patch keeps the outer namespace record, adds typed declarations for direct
known `function`/`custom` children at `request.tools[i].tools[j]`, and leaves
the canonical `tools` value equal to the original business list.

## Verification

Each command was run separately with output redirected to its own log; the
reported exit code is the command's real exit code.

| Command | Exit | Result | Log SHA256 |
| --- | ---: | --- | --- |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture` | 0 | 4 passed / 0 failed | `43b1c6391dfaca3779e6b365c2ba307ce54b3049287460f5b36df6697f14ce88` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_nested_declarations -- --nocapture` | 0 | 2 passed / 0 failed | `aa37510b905df839ac55dad869583794177fe94f6b8637ad70aa5c3cddb09f22` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_namespace_presence -- --nocapture` | 0 | 2 passed / 0 failed | `c9e881a4d77f53174ed64217a6b6fc1c3f9f95d206d141591b39bf89378aad33` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture` | 0 | 5 passed / 0 failed | `59a3733e3cd4d25587b167065bb286f2688a3195d576e535e7c77dc25b65aa65` |
| `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture` | 0 | 51 passed / 0 failed | `326d2527fab859f12b7afa7c525d191db924b4455fbe6b88d8624f1976df4098` |

The new public test covers:

- two namespace containers with same-named `function` and `custom` children,
  distinct schemas, and distinct opaque values;
- complete function arguments and custom free-text input with result pairing;
- unknown sibling and unknown child preservation; and
- explicit namespace association from the standard container.

## Evidence boundary

This result proves only the SDK public normalization behavior exercised through
the two public runtime entry functions in the tests. It does not claim HTTP/WS
delivery, installed runtime behavior, provider calls, or actual tool
execution. No install, restart, commit, merge, push, or review was performed.
