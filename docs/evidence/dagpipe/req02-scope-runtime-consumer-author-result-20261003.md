# REQ02 Real Runtime Consumer Lifecycle Regression Result

Run date: 2026-10-02 (America/Los_Angeles)

## Scope

- Goal: add public Runtime/Server consumer regressions for real request-scope
  resource lifecycle and record the actual candidate behavior.
- Worktree:
  `/Volumes/Intel/playground/routecodex/req02-scope-consumer-regressions-20261003`
- Branch: `codex/req02-scope-consumer-regressions-20261003`
- HEAD: `688f7a1c6a15ecf45dfee12cc430148ae3c03898`
- Source goal snapshot:
  `/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002/docs/goals/req02-scope-consumer-regressions-worker-20261003.md`
- Source snapshot was read only. No product source was changed.
- No Collab registration, no worker launch, no install, no restart, no 4444
  access, no commit, no merge, and no push were performed.

The test file is:

`v3/crates/routecodex-v3-server/tests/req02_scope_runtime_consumer.rs`

The test enters only through these public Runtime entries:

- `execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target`
- `execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state`

The test uses a real local Axum HTTP upstream. It observes scope state through
the public `request_context().original_pair()` operation. It never takes or
drops a finalizer guard manually. Each case retains a public control clone as
an observer so release cannot be manufactured by dropping every control.

## Gate Separation

### Compile gate

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer --no-run
```

Log:

`docs/goals/req02-scope-runtime-consumer-20261003.compile.log`

Raw exit code: `0`

The compile gate finished successfully. Compile success is separate from the
behavior result below.

### Behavior gate

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer -- --nocapture
```

Log:

`docs/goals/req02-scope-runtime-consumer-20261003.log`

Raw exit code: `101`

Result: `2 passed; 3 failed; 0 ignored; 0 measured`.

The failures are behavior failures after the test compiled.

## Case Results

### 1. Relay SSE EOF

Test ID: `req02_relay_sse_releases_on_eof_with_observer_control_alive`

Real entry:
`execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state`

Real upstream:
The local HTTP peer was called once and returned SSE `200` containing
`response.output_text.delta` followed by `response.completed`.

Observed:

- The public Relay output returned `status = 200`.
- Before draining the SSE body, the observer clone saw the scope as `Active`.
- After draining the SSE body to EOF, the observer clone still saw the scope as
  `Active`.

Expected contract result: `Released`.

Conclusion: RED. The real Relay SSE consumer path does not release the request
scope at EOF while an observer control clone remains.

Log evidence:

- `test req02_relay_sse_releases_on_eof_with_observer_control_alive ... FAILED`
- panic at `req02_scope_runtime_consumer.rs:439`
- `left: Active`
- `right: Released`

### 2. Relay cancellation

Test ID: `req02_relay_cancel_releases_with_observer_control_alive`

Real entry:
`execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state`

Real upstream:
The runtime reached the local HTTP upstream before cancellation. The upstream
request was deliberately left pending.

Observed:

- The real Runtime task was aborted and joined as cancelled.
- The observer control clone remained alive.
- After the cancelled Runtime future was dropped, the observer still saw the
  scope as `Active`.

Expected contract result: `Released`.

Conclusion: RED. Cancellation of the real Runtime future does not release the
request scope while an observer control clone remains.

Log evidence:

- `test req02_relay_cancel_releases_with_observer_control_alive ... FAILED`
- panic at `req02_scope_runtime_consumer.rs:482`
- `left: Active`
- `right: Released`

### 3. Direct JSON success

Test ID: `req02_direct_json_success_releases_when_public_output_drops`

Real entry:
`execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target`

Real upstream:
The local HTTP peer returned JSON `200` with a completed Responses payload.

Observed:

- The public Direct output returned `status = 200`.
- The public output carried `request_finalizer = Some(...)`.
- The observer saw `Active` while the public output owned the finalizer.
- Dropping the consumed public output changed the observer to `Released`.

Conclusion: GREEN. The Direct JSON success path releases at public output drop
without manually taking or dropping the guard.

Log evidence:

- `test req02_direct_json_success_releases_when_public_output_drops ... ok`

### 4. Direct HTTP error

Test ID: `req02_direct_error_releases_when_public_output_drops`

Real entry:
`execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target`

Real upstream:
The local HTTP peer returned JSON `400` with an upstream error body.

Observed:

- The public Direct output projected `status = 502`.
- The output retained `terminal_disposition = Some(ExternalHttp(400))`.
- The output carried `request_finalizer = None`.
- Dropping the consumed public output left the observer scope as `Active`.

Expected contract result: preserve the eligible upstream `400` and release the
request scope when the public error output is consumed or dropped.

Conclusion: RED. The real Direct error path both loses the upstream status at
the client projection and does not release the request scope while an observer
control clone remains.

Log evidence:

- `test req02_direct_error_releases_when_public_output_drops ... FAILED`
- panic at `req02_scope_runtime_consumer.rs:571`
- `left: (502, Active)`
- `right: (400, Released)`

### 5. Relay-to-Direct handoff identity

Test ID: `req02_relay_to_direct_handoff_preserves_same_scope`

Real entry:
`execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state`

Fixture:
The manifest declares a Relay-first Anthropic provider and a Direct-second
Responses provider. The Relay provider points at a closed local port, producing
a real transport failure. A real local HTTP Direct upstream is declared for the
fallback target, but the Relay entry returns the public handoff before sending
the Direct target.

Observed:

- The public Relay output exposed `protocol_direct_handoff = Some(...)`.
- `observer.request_context().same_scope(handoff.request_execution_control.request_context())`
  was true.
- The observer scope remained `Active` at the handoff boundary.

Conclusion: GREEN for the public Relay-to-Direct handoff identity. The same
request context is carried into the handoff object and is not rebuilt.

Log evidence:

- `test req02_relay_to_direct_handoff_preserves_same_scope ... ok`

## Summary

Passed:

- `req02_direct_json_success_releases_when_public_output_drops`
- `req02_relay_to_direct_handoff_preserves_same_scope`

Failed:

- `req02_relay_sse_releases_on_eof_with_observer_control_alive`
- `req02_relay_cancel_releases_with_observer_control_alive`
- `req02_direct_error_releases_when_public_output_drops`

The result is behavior RED for the current candidate. The compile gate is
separately GREEN.

## Hash Evidence

Source goal snapshot and task inputs:

```text
bbc9ff7b5a3cfd760bfd3bb62c84999753780d93d359be8e467c685fb2b5a8fc  docs/goals/req02-scope-consumer-regressions-worker-20261003.md
2c155501cbea253616bd52bcff21fc226db64af39e9aa4c979ee6cd10545affa  v3/crates/routecodex-v3-server/tests/req02_scope_runtime_consumer.rs
707231368b51e79ef9eb43b6641d3ac116cc67b5239fb3f9bf8f86d44bf56127  v3/crates/routecodex-v3-runtime/src/kernel/direct_kernel_entrypoints.rs
8875cf878ae70b3e96f42ff0dbe51452dab21a1c274e5afa2d54a21e759b3c92  v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs
553e93429ec7eb311607508a957c2016c0ce4d0a6285d6e513fd71abf2e80119  v3/crates/routecodex-v3-runtime/src/execution_control.rs
bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
```

Logs:

```text
fc14ffba55b3edd1256cc302c56ec93f010aba90f11dd445f397e3b231d029f3  docs/goals/req02-scope-runtime-consumer-20261003.log
fdac6d2e52e864ae83f72a27b31804c5d5367c81f093ac8c27faff67863f9b52  docs/goals/req02-scope-runtime-consumer-20261003.compile.log
```

## Boundary Check

`git diff --check` exited `0`.

No product source, other tests, profiles, maps, graphs, or other worktrees were
modified by this task. The only task-owned files are the public consumer test,
the compile log, the behavior log, and this result document.
