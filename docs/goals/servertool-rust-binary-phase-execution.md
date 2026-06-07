# Servertool Rust Binary Phase Execution

## Objective

Build servertool as a Rust-owned subsystem with an independent Rust binary, while preserving the transparent client/model contract:

- client sees `exec_command` call/result paired with `exec_command`.
- model sees original servertool call/result paired with original servertool name.
- the only conversion point is Rust `HubReqChatProcess03Governed`.
- stopless schema guidance is injected by Rust on every client exec result re-entry.

## Authoritative Inputs

- `docs/goals/servertool-outcome-contract-rustification-plan.md`
- `docs/design/servertool-outcome-contract.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `docs/agent-routing/30-servertool-lifecycle-routing.md`
- `docs/goals/server-module-architecture-closeout-plan.md` only for boundary alignment, not as implementation owner.

## Phase A: Rust Binary Skeleton

Create `sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/` as an independent binary crate.

Required behavior:

- `cargo build -p servertool-cli` succeeds independently.
- `cargo test -p servertool-cli` succeeds independently.
- binary command shape: `routecodex-servertool run <toolName> --input-json <json> [--flow <flowId>] [--repeat-count N --max-repeats N]`.
- supported first tool: `stop_message_auto`.
- output JSON is produced by Rust core, not TS.

Verification:

- `cargo test -p servertool-cli`
- spawn binary blackbox test for `stop_message_auto` happy path.
- blackbox red test for missing `flowId` / missing `continuationPrompt` / invalid json fail-fast.

## Phase B: Rust Core Outcome Contract

Move outcome planning into Rust:

- `ClientExecCliProjection`: stop_message_auto / review / servertool_fixture.
- `BackendRouteReenter`: web_search / vision_auto.
- `ServerIoInternal`: memory_cache_auto.

Required Rust types/builders:

- `ServertoolClientExecCliProjection01Planned`
- `ServertoolBackendRouteHint01Planned`
- `ServertoolServerIoInternal01Observed`
- `build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03`
- `build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03`
- `build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03`

Verification:

- Rust unit tests for classification.
- red tests rejecting `web_search` / `vision_auto` client-visible `exec_command` projection.
- red tests rejecting `fake_exec` and old restoration markers.

## Phase C: Req Chatprocess Tool Name Projection

Implement Rust `req_chatprocess 03` conversion:

- capture paired client `exec_command` result.
- validate call_id/tool_call_id pairing.
- convert to model-side original servertool result.
- release the client exec history slot.
- fail-fast on ambiguous or duplicate projection.

Verification:

- client response snapshot contains `exec_command` only.
- provider outbound snapshot contains original servertool tool result only.
- provider outbound snapshot does not contain stopless `exec_command` result.

## Phase D: Stopless Schema Closed Loop

Rust injects schema guidance on every CLI result re-entry.

Required fields:

- current goal
- done steps
- completion / blocked status
- evidence
- issue cause
- excluded factors
- diagnostic order
- next_step / next_suggested_path
- learned
- `stopreason` JSON schema
- repeatCount / maxRepeats

Verification:

- N-round schema closed-loop test.
- missing schema and invalid schema budget tests.
- budget exhausted tombstone test: default snapshot must not revive automatically.

## Phase E: TS Physical Deletion

After Rust tests and blackbox pass:

- delete TS fallback branches.
- delete TS servertool business handler paths.
- delete TS CLI implementation once `routecodex-servertool` parity is proven.
- keep only thin spawn/parse/write wrappers where absolutely required by client execution.

Verification:

- `npm run verify:servertool-rust-only`
- `npm run verify:architecture-ci`
- `cargo test -p servertool-core`
- `cargo test -p stop-message-core`
- `cargo test -p servertool-cli`
- servertool blackbox red/regression suite.

## Hard Guards

- No TS fallback.
- No fake_exec.
- No provider-specific Hub patch.
- No metadata/internal carrier leakage to provider body or client body.
- No rebuilding servertool followup from current chatprocess payload; use entry snapshot only.
- No broad kill commands.

## Phase D-Extra: needs_user_input Gate（已完成）

模型在回复中输出 `needs_user_input: true` + `next_step` 填写问题内容，Rust gate 判定为简单询问，允许停止，不计入连续 stop 预算。

规则（Rust 内部，不暴露给模型）：
- `needs_user_input=true` + `next_step` 非空 → AllowStop，不计 budget
- `needs_user_input=true` + `next_step` 为空 → Followup，要求补问题
- `needs_user_input` 不增加 stopMessageUsed
- 模型只看到 `needs_user_input` 字段名和 `true/false`，不知道内部 stopreason=3 判断标准

实现位置：
- `stop-message-core/src/lib.rs`：`StopSchemaParsed.needs_user_input` + gate 逻辑 + `STOP_SCHEMA_JSON_EXAMPLE` 更新
- `servertool-core/src/cli_contract.rs`：`required_fields` 包含 `needs_user_input`

测试覆盖：
- `needs_user_input_with_next_step_allows_stop_without_budget` — AllowStop + 不计 budget
- `needs_user_input_without_next_step_fails` — Followup 要求补问题
- `needs_user_input_does_not_increase_budget` — 不增加 stopMessageUsed
- `needs_user_input_not_exposed_to_model` — schema example 含字段但不含 stopreason=3
