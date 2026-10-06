# REQ02 Shared Relay Consumer Scope Regression Result

Run date: 2026-10-03 (America/Los_Angeles)

## Scope

- Goal: add three OpenAI Chat shared Relay consumer regressions and record
  the real Runtime and HTTP-upstream behavior for the current snapshot.
- Worktree:
  `/Volumes/Intel/playground/routecodex/req02-scope-consumer-regressions-20261003`
- Branch: `codex/req02-scope-consumer-regressions-20261003`
- HEAD: `688f7a1c6a15ecf45dfee12cc430148ae3c03898`
- New test:
  `v3/crates/routecodex-v3-server/tests/req02_shared_relay_scope.rs`
- Product source, maps, graphs, profiles, the existing five-test file, the
  active config, port 4444, and other worktrees were read only.
- No commit, merge, push, install, restart, architecture review, Collab
  registration, or subagent was performed.

The real public Runtime entry is:

```text
execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control(
    manifest,
    input,
    provider_health,
    V3HubExecutionMode::Relay,
    request_execution_control,
)
```

The control is created through public `V3RequestExecutionControl::new(...)`.
The tests retain a normal observer clone and use only
`request_context().original_pair()` to observe Active or Released. No test
takes, drops, or finalizes a guard directly.

The manifest declares `endpoints = ["openai_chat"]`,
`entry_protocol = "openai_chat"`, and explicit `V3HubExecutionMode::Relay`.
The client payload is a real OpenAI Chat request with `messages`. The local
Axum peer is reached through the default Runtime transport and returns valid
Responses JSON or SSE terminal payloads. Each peer is shut down through its
own graceful-shutdown sender.

## Gate Separation

### Compile gate

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_shared_relay_scope --no-run
```

Log:

`docs/goals/req02-shared-relay-scope-logs/req02-shared-relay-scope-20261003.compile.log`

Raw exit code: `0`

The compile gate completed without fixture or type errors. Compile success is
separate from the behavior result below.

### Behavior gate

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_shared_relay_scope -- --nocapture
```

Log:

`docs/goals/req02-shared-relay-scope-logs/req02-shared-relay-scope-20261003.log`

Raw exit code: `101`

Result: `0 passed; 3 failed; 0 ignored; 0 measured`.

All three failures occur after the client response and lifecycle observations,
at the contract assertion that the scope must be `Released`. No fixture,
compile, upstream, or client-projection assertion failed first.

## Case Results

### 1. OpenAI Chat shared Relay SSE

Test ID:
`req02_shared_relay_openai_chat_sse_scope_active_until_eof_then_released`

Real entry:
`execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control`

Real upstream:
The local peer was called once and returned SSE `200` with
`response.output_text.delta` followed by `response.completed`.

Observed:

- Initial observer scope: `Active`.
- Public output returned `status = 200`.
- Before draining the SSE body, observer scope: `Active`.
- Client SSE contained valid `chat.completion.chunk` frames, the expected
  provider text, `finish_reason = "stop"`, and exactly one `data: [DONE]`.
- After draining to EOF while the stream object and observer clone remained
  alive, observer scope: `Active`.

Expected contract result: `Released`.

Conclusion: `RED`. The real OpenAI Chat shared Relay SSE consumer does not
release the request scope at EOF while an observer control clone remains.

Log evidence:

- `test req02_shared_relay_openai_chat_sse_scope_active_until_eof_then_released ... FAILED`
- Panic at `req02_shared_relay_scope.rs:295`
- `left: Active`
- `right: Released`

### 2. OpenAI Chat shared Relay cancellation

Test ID:
`req02_shared_relay_openai_chat_cancel_releases_with_observer_control_alive`

Real entry:
`execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control`

Real upstream:
The runtime reached the local HTTP peer before cancellation. The upstream
request was deliberately left pending until after the cancelled task was
joined.

Observed:

- The real Runtime future was aborted.
- The joined task error was `is_cancelled() == true`.
- The observer control clone remained alive.
- After cancellation completed, observer scope: `Active`.

Expected contract result: `Released`.

Conclusion: `RED`. Cancelling the real OpenAI Chat shared Relay Runtime future
does not release the request scope while an observer control clone remains.

Log evidence:

- `test req02_shared_relay_openai_chat_cancel_releases_with_observer_control_alive ... FAILED`
- Panic at `req02_shared_relay_scope.rs:350`
- `left: Active`
- `right: Released`

### 3. OpenAI Chat shared Relay JSON

Test ID:
`req02_shared_relay_openai_chat_json_scope_active_until_output_drop_then_released`

Real entry:
`execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control`

Real upstream:
The local peer was called once and returned JSON `200` with a completed
Responses payload.

Observed:

- Initial observer scope: `Active`.
- Public output returned `status = 200`.
- Client JSON contained the expected `choices[0].message.content`.
- Client JSON preserved `usage.total_tokens = 5`.
- After the public output returned, observer scope: `Active`.
- After consuming and dropping the public output while the observer clone
  remained alive, observer scope: `Active`.

Expected contract result: `Released`.

Conclusion: `RED`. Dropping the consumed public OpenAI Chat shared Relay JSON
output does not release the request scope while an observer control clone
remains.

Log evidence:

- `test req02_shared_relay_openai_chat_json_scope_active_until_output_drop_then_released ... FAILED`
- Panic at `req02_shared_relay_scope.rs:406`
- `left: Active`
- `right: Released`

## Boundary And Non-Goals

- This is a test-author task result, not a REQ02 fix or delivery.
- Gemini and Anthropic shared Relay consumer boundaries were not covered by
  this test file.
- No product source, existing five-test assertion, map, graph, profile,
  active config, or 4444 runtime was changed.
- The existing five-test file remained read-only and its SHA256 still matches
  the contract value.
- `git diff --check` exited `0`.

## Hash Evidence

Goal and source/test/profile inputs:

```text
b75e655110da8b37a2530fb29da2931a0f393db2d3bafeae74e8f1492e6a0fd3  docs/goals/req02-shared-relay-scope-worker-20261003.md
db8e027ff2c1e355f6ab238780197c41b62070ff2ee75414f328d5c701261730  v3/crates/routecodex-v3-server/tests/req02_scope_runtime_consumer.rs
45c88528ff13d0427e32b3a7c3ad86218e8d701ef20694e6d1aae20df9420c84  v3/crates/routecodex-v3-server/tests/req02_shared_relay_scope.rs
32d57697ce1ba3ec263c9b87a4acc0ea9149a0bb398e4c8f3ee1feb29c4a601f  v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs
a8bdbe938649bc1dc4bfddfd8bc3ca03d48553f3497e102da610dafb8e169309  v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs
553e93429ec7eb311607508a957c2016c0ce4d0a6285d6e513fd71abf2e80119  v3/crates/routecodex-v3-runtime/src/execution_control.rs
bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35  v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
e05a43e9943292b68c37528402773ac77bd12e0d0380bae8801b959b4250758b  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_profiles.rs
d4e6365c265793468fde1f17409e87aa84e9597fd78fbbdfef5cad290386ec8f  docs/architecture/dagpipe/v3.operation_runner.request.graph.json
```

Logs:

```text
d6570e4cec83a5a41ee9675241fb8487a835a3e2433b97f47d658728f952849b  docs/goals/req02-shared-relay-scope-logs/req02-shared-relay-scope-20261003.compile.log
5c295d60370c23d4716aec37c6d8c5e064259e7941e95d124d10531d459dfb66  docs/goals/req02-shared-relay-scope-logs/req02-shared-relay-scope-20261003.log
```
