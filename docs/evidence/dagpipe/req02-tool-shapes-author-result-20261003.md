# REQ02 Real Tool Shape Public Consumer Result

Date: 2026-10-02

Worktree: `/Volumes/Intel/playground/routecodex/req02-tool-public-cases-20261003`

Base: `fresh origin/main 75cab8267`, with the parent candidate changes already present.

## Scope

Added one public consumer test file:

- `v3/crates/routecodex-v3-server/tests/req02_tool_shapes.rs`

The test consumes only the exported capture entry, exported normalize entry, and
the public typed inverse/history structs. It does not call private helpers, use
mocks, or assert on source strings. It covers:

1. Responses `gpt-5.5` flat custom `apply_patch` with a complete multiline
   patch string and tail sentinel, plus `custom_tool_call_output` pairing.
2. Responses `gpt-5.5` flat `exec_command` function declaration with complete
   long `cmd`/`workdir` strings, exact argument-string equality, and output
   pairing by `call_id`.
3. Responses `gpt-5.5` flat MCP declaration with nested business arguments and
   result values, namespace/name/type, and history references.
4. Responses `gpt-5.6-sol` real namespace declarations containing both
   `function` and `custom` children. Two namespaces each contain same-named
   tools with different schemas; the test asserts typed identity and opaque
   declaration records for the namespace and nested children, plus history
   pairing.

The model ids are input data only. No model call or provider request was made.

## Source And Input Hashes

```text
07c345119b9ab867897629dbd9af5d2c7a39c8cfbaa63bc468a3fc1467eaac50  v3/crates/routecodex-v3-server/tests/req02_tool_shapes.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
d4e6365c265793468fde1f17409e87aa84e9597fd78fbbdfef5cad290386ec8f  docs/architecture/dagpipe/v3.operation_runner.request.graph.json
78ac0e793a7ad3907944bc94feb832306c92a0af1fe5725c2705d1c381241b7d  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs
bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
```

## Exact Test Command And Result

Command:

```bash
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture
```

Raw log: `.execution/req02-tool-shapes-cargo-test.log`

Exit: `101`

Result:

```text
test result: FAILED. 1 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s
```

Log hash:

```text
f34cebd14e9e0ddc4f537b45d47ed5e3553bca866ea2c9cbf60250a46452b27b  .execution/req02-tool-shapes-cargo-test.log
```

## Behavior Findings

### PASS: flat MCP identity and nested values

`responses_gpt_5_5_flat_mcp_preserves_nested_business_values_and_history_identity`
passed. Its declaration, namespace, exact argument string, JSON result value,
and history pairing remained observable through the public typed references.

### FAIL: flat declarations synthesize a null namespace

First failing test:
`responses_gpt_5_5_flat_custom_apply_patch_preserves_raw_multiline_input_and_pairs_output`

- Input: a Responses `gpt-5.5` tool with no `namespace` key.
- Expected: the public typed declaration namespace is absent (`None`).
- Actual: `Some(Null)`.
- Earliest divergence: the typed inverse declaration for `request.tools[0]`
  exposes `Some(Value::Null)` instead of an absent namespace.

The same divergence is the first failure in
`responses_gpt_5_5_flat_exec_command_preserves_exact_long_arguments_and_result_pairing`.
Both tests reach their non-namespace expectations successfully, including raw
string preservation and call/output pairing, before this assertion.

### FAIL: nested namespace child declarations are absent

First failing test:
`responses_gpt_5_6_namespace_mixed_tools_preserve_nested_identity_schema_and_history`

- Input: Responses `gpt-5.6-sol` `type: namespace` declarations with nested
  `function` and `custom` children.
- Expected: `request.tools[0].tools[0]` is locatable through a public typed
  declaration reference and its opaque declaration record preserves the exact
  nested schema.
- Actual: no typed declaration exists for
  `request.tools[0].tools[0]`.
- Earliest divergence: normalization emits the top-level namespace declaration,
  but does not emit typed declarations for nested namespace tools.

## Diff Check

```text
git diff --check -> exit 0
```

## Boundary

This run proves only the public capture-to-normalize SDK slice for the supplied
JSON inputs. It does not prove real HTTP or WebSocket transport, actual tool
execution, provider calls, or delivery of the parent candidate.

Disposition for this narrow task: `FAIL` for the requested behavior acceptance.
The test remains unmodified from the failing expectations above; no product,
profile, map, or graph file was changed.
