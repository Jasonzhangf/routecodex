# Servertool Rustification Implementation Plan

## 1. Goal And Acceptance

Goal: make servertool governance, outcome planning, CLI contract, stopless loop policy, backend-route hints, and persisted state lookup Rust-owned; TypeScript remains only a thin bridge for JSON IO, native loading, process spawning, file/network transport, and test harnesses.

Acceptance:

- `stop_message_auto` migrated path is planned by Rust as client-visible `exec_command` CLI projection.
- `web_search` / `vision_auto` are planned by Rust as backend-route reenter hints, never as client-visible CLI projection.
- `memory_cache_auto` is planned by Rust as server-IO-internal, never as client-visible CLI projection.
- Rust owns stopless schema guidance, repeat budget, lifecycle guard, CLI result validation, and persisted stop-message lookup policy.
- TS business files under `sharedmodule/llmswitch-core/src/servertool/` are either physically deleted or reduced to documented thin shells.
- No old restoration markers, ticket files, private followup/reenter path, or TS fallback semantics remain for migrated servertools.
- Required gates pass, and any remaining TS shell is covered by a rust-only/static audit gate.

## 2. Authoritative Inputs

Use these documents as the source set:

- `docs/agent-routing/30-servertool-lifecycle-routing.md`
- `docs/design/servertool-cli-projection-migration.md`
- `docs/design/servertool-cli-lifecycle.md`
- `docs/goals/servertool-cli-projection-phase1-plan.md`
- `docs/goals/servertool-rust-binary-phase-execution.md`
- `docs/goals/servertool-rust-only-fallback-ssot-audit-plan.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `AGENTS.md`

Conflict resolution:

- For migrated CLI projection paths, `docs/design/servertool-cli-projection-migration.md` and `docs/design/servertool-cli-lifecycle.md` supersede older private followup/reenter topology language in `docs/design/servertool-rust-only-architecture.md`.
- `servertool-rust-only-architecture.md` remains useful for layering and Rust-only ownership goals, but migrated `stop_message_auto` must not reenter Hub Pipeline through private server-side followup.

## 3. Scope

In scope:

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/`
- Servertool-specific Rust exports and native bridge contracts when coordination allows.
- `sharedmodule/llmswitch-core/src/servertool/` TS shrink/deletion after Rust truth exists.
- Servertool tests under `tests/servertool/`, `tests/cli/`, `tests/sharedmodule/`, and blackbox handler tests.
- Verification scripts such as `scripts/verify-servertool-rust-only.mjs`.

Out of scope:

- Virtual Router rustification.
- Hub Pipeline broad migration not directly needed by servertool contract wiring.
- Provider runtime protocol changes.
- Direct passthrough behavior changes.
- `apply_patch` migration into servertool.
- Reintroducing old restoration files, hidden tickets, old CLI handles, or model tool identity restoration.

Concurrency boundary:

- While other workers are editing VR / Hub Pipeline, the first servertool slice should avoid `router-hotpath-napi/src/lib.rs`, `src/native/router-hotpath/native-router-hotpath-required-exports.ts`, and VR paths unless explicitly coordinated.
- Low-conflict first slices should stay in `servertool-core`, `servertool-cli`, docs, and servertool-specific tests.

## 4. Current Picture

Rust already exists:

- `servertool-core/src/outcome_contract.rs` classifies `stop_message_auto` / `servertool_fixture`, `web_search` / `vision_auto`, and `memory_cache_auto`.
- `servertool-core/src/cli_contract.rs` builds stopless CLI output and validates client exec output.
- `servertool-cli/src/main.rs` exposes `routecodex-servertool run <toolName> --input-json <json>`.
- `servertool-cli/tests/cli_blackbox.rs` covers stopless happy path and unsupported `web_search`.

TS still owns too much runtime behavior:

- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.ts`
- backend-route blocks, stop-message blocks, registry, skeleton config, pending/session/state files.
- handler files such as `handlers/stop-message-auto.ts`, `handlers/web-search.ts`, `handlers/vision.ts`, `handlers/fixture.ts`, and stop-message-auto submodules.

The migration is therefore not complete until Rust owns the planning contracts and TS leftovers are either deleted or mechanically proved to be IO shells.

## 5. Target Contract

Servertool outcome chain:

```text
HubRespChatProcess03Governed
  -> ServertoolOutcome01Classified
  -> one of:
       ServertoolClientExecCliProjection01Planned
       ServertoolBackendRouteHint01Planned
       ServertoolServerIoInternal01Observed
  -> HubRespOutbound04ClientSemantic
```

Client CLI lifecycle for migrated tools:

```text
model response
  -> Rust servertool projection
  -> client-visible exec_command:
       routecodex servertool run <toolName> --input-json '<json>'
  -> client submits ordinary exec_command result
  -> normal request chain
```

Rules:

- `stop_message_auto` and `servertool_fixture` may project to client `exec_command`.
- `web_search` and `vision_auto` must not project to client `exec_command`.
- `memory_cache_auto` must not project to client `exec_command`.
- `fake_exec`, `--ticket`, `stcli_`, `rcc_cli_`, `old_cli_`, and `old_cli_result_` are forbidden.
- CLI stdout is ordinary client tool output, not internal servertool metadata.
- TS must not restore servertool identity from CLI results.

## 6. Implementation Phases

### Phase 0: Contract Freeze And Red Gates

Tasks:

- Add or update static audit coverage for old restoration markers, migrated-path `reenterPipeline` / `providerInvoker`, unsupported CLI projection, and TS servertool semantic ownership.
- Extend `npm run verify:servertool-rust-only` so it distinguishes allowed thin shells from forbidden semantic TS files.
- Add feature-to-test mapping for servertool migration in the verification script or a nearby documented registry.

Primary files:

- `scripts/verify-servertool-rust-only.mjs`
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`
- `tests/servertool/servertool-cli-result-restore.spec.ts`
- `docs/goals/servertool-rustification-implementation-plan.md`

Verification:

- `npm run verify:servertool-rust-only`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts --runInBand --forceExit`

### Phase 1: Rust Outcome Contract Closeout

Tasks:

- Add typed Rust structs:
  - `ServertoolClientExecCliProjection01Planned`
  - `ServertoolBackendRouteHint01Planned`
  - `ServertoolServerIoInternal01Observed`
  - `ServertoolHubRespChatProcess03Input`
- Add builders:
  - `build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03`
  - `build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03`
  - `build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03`
- Fail fast for unknown tools, wrong outcome requests, `fake_exec`, and denied old markers.
- Keep this slice inside `servertool-core` where possible to avoid concurrent VR/Hub edits.

Primary files:

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`
- Optional new module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_builders.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`

Verification:

- `cargo test -p servertool-core`
- `cargo test -p servertool-cli`

### Phase 2: Rust CLI Contract Completion

Tasks:

- Make `servertool_fixture` executable by `routecodex-servertool`, or explicitly remove it from client-exec classification until executable parity exists.
- Lock `stop_message_auto` CLI output shape to `docs/design/servertool-cli-lifecycle.md`.
- Reject non-object `--input-json`, unsupported names, invalid `flowId`, invalid repeat budget, and all old restoration markers.
- Ensure CLI output contains no internal metadata, `__rt`, snapshot/debug carrier, ticket, or restoration handle.

Primary files:

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/src/main.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/tests/cli_blackbox.rs`
- `tests/cli/servertool-command.spec.ts`

Verification:

- `cargo test -p servertool-core`
- `cargo test -p servertool-cli`
- `npm run jest:run -- --runTestsByPath tests/cli/servertool-command.spec.ts --runInBand --forceExit`

### Phase 3: Stopless State And Persisted Lookup Rust Ownership

Tasks:

- Implement Rust-owned persisted lookup planning for stop-message snapshot/tombstone policy.
- Add contract such as `planStopMessagePersistedLookupJson`.
- TS must pass record/runtime metadata and consume candidate keys returned by Rust; TS must not sort or synthesize fallback sticky keys.
- Move or prove Rust ownership of stopless repeat budget, needs-user-input gate, schema validation, tombstone policy, and session scope policy.

Primary files:

- Rust target: `router-hotpath-napi` servertool/chat-process module or a servertool-specific native crate export, depending on current native bridge design.
- TS bridge: `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- TS removal/reduction: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` and `handlers/stop-message-auto/*`

Verification:

- Rust unit tests for lookup ordering and tombstone/snapshot shared policy.
- Existing stop-message suites:
  - `tests/servertool/stop-message-native-decision.spec.ts`
  - `tests/servertool/stop-message-auto.config-precedence.spec.ts`
  - `tests/servertool/stopmessage-session-scope.spec.ts`
  - `tests/sharedmodule/stop-message-state-sync.spec.ts`
- `npm run verify:servertool-rust-only`

### Phase 4: Response Projection Wiring

Tasks:

- Wire Rust `ServertoolClientExecCliProjection01Planned` into servertool response projection.
- Ensure migrated `stop_message_auto` and `servertool_fixture` emit reasoning + `exec_command` only.
- Ensure migrated paths cannot call old private server-side handler execution, `reenterPipeline`, `providerInvoker`, or restoration.
- Preserve SSE for streaming requests.

Primary files:

- `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`
- `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
- related native bridge exports after coordination with Hub/VR workers.

Verification:

- `tests/servertool/servertool-cli-projection.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/servertool/stopless-direct-mode-guard.spec.ts`
- `npx tsc --noEmit --pretty false`

### Phase 5: Backend Route Outcome Rust Ownership

Tasks:

- Move backend-route eligibility, route hints, shape guard, flow policy, origin delta, and finalization decisions to Rust-owned contract blocks.
- TS backend-route files may only perform IO/reenter transport from a Rust plan.
- `web_search` and `vision_auto` must remain backend route hints, not client CLI projections.

Primary files:

- Rust: `servertool-core` backend-route contract modules, with NAPI export when coordinated.
- TS shrink/deletion candidates:
  - `backend-route-*.ts`
  - `handlers/web-search.ts`
  - `handlers/vision.ts`
  - `handlers/vision-eligibility.ts`

Verification:

- `tests/servertool/server-side-web-search.spec.ts`
- `tests/servertool/vision-flow.spec.ts`
- `tests/servertool/servertool-mixed-tools.spec.ts`
- Backend-route static audit in `verify:servertool-rust-only`.

### Phase 6: TS Physical Deletion And Thin-Shell Lock

Tasks:

- Delete TS semantic owners after Rust ownership and tests are green.
- Keep only native bridge, JSON parse/stringify guards, spawn shell, file/network IO adapters, and non-semantic observability.
- Remove `.bak`, legacy docs, old restoration tests, and stale generated residues when proven untracked/ignored.
- Add gate patterns that fail if deleted TS semantic names are restored.

Primary files:

- `sharedmodule/llmswitch-core/src/servertool/**`
- `scripts/verify-servertool-rust-only.mjs`
- servertool docs and test maps.

Verification:

- `npm run verify:servertool-rust-only`
- `npm run verify:architecture-ci`
- `npx tsc --noEmit --pretty false`
- `cargo test -p servertool-core`
- `cargo test -p servertool-cli`
- focused servertool Jest suites.

### Phase 7: Online Closeout

Tasks:

- Build/install the native binary and package after code gates pass.
- Exercise `stop_message_auto` through the real client-visible `exec_command` path on a local RouteCodex port.
- Capture samples proving client response sees `exec_command`, CLI stdout is ordinary tool output, and provider outbound does not contain old restoration markers or internal metadata.

Verification:

- `npm run build:min`
- `npm run install:global`
- `routecodex --version && rcc --version`
- Local health check for the target port.
- Inspect `~/.rcc/codex-samples/**` for client-response/provider-request evidence.

## 7. Risk And Controls

- Risk: TS and Rust both own the same semantic branch.
  Control: add red gates before switching and physically delete TS semantic branch after Rust truth is proven.
- Risk: migrated CLI path accidentally reenters private server-side followup.
  Control: static gate plus blackbox assertion for client-visible `exec_command`.
- Risk: old restoration markers return through tests or helper names.
  Control: deny `--ticket`, `stcli_`, `rcc_cli_`, `old_cli_`, `old_cli_result_` in Rust and TS gates.
- Risk: concurrent VR/Hub Pipeline work causes merge conflicts.
  Control: first close servertool-core/servertool-cli slices; delay NAPI export and Hub bridge wiring until coordination.
- Risk: docs still describe old private followup topology.
  Control: explicitly treat CLI lifecycle docs as truth for migrated paths and update old docs during closeout.

## 8. Definition Of Done

Done means all of the following are true:

- Rust contract builders are the only servertool outcome truth.
- `routecodex-servertool` executes supported migrated tools and fails fast for unsupported tools.
- Migrated `stop_message_auto` does not use private followup/reenter.
- `web_search` / `vision_auto` cannot become client exec projections.
- Stopless state, schema, budget, and persisted lookup policy are Rust-owned.
- TS semantic servertool modules are deleted or reduced to audited thin shells.
- Static gates prevent TS semantic resurrection.
- Rust tests, TS tests, architecture gates, and online sample checks pass with evidence.

## 9. Current Execution Handoff (2026-06-08)

This section is the current execution entrypoint. Do not restart from Phase 0 unless a new audit proves the earlier slices were reverted.

Evidence observed in the current worktree:

- `servertool-core` already contains Rust-owned outcome, CLI, stop gateway, loop guard, counter, tool name projection, and persisted lookup modules.
- `servertool-cli` already exposes blackbox-covered command execution for migrated servertool CLI projection.
- `router-hotpath-napi/src/chat_servertool_orchestration.rs` currently delegates persisted lookup planning to `servertool_core::persisted_lookup`.
- `scripts/verify-servertool-rust-only.mjs` already has gates for persisted lookup ownership and several TS semantic resurrection patterns.
- TS servertool source still contains many semantic owner candidates under `sharedmodule/llmswitch-core/src/servertool/**`, especially backend-route blocks, stop-message-auto submodules, orchestration policy blocks, registry, pre-command hooks, and server-side tool execution.

Current verified status:

- Stopless persisted-state focused validation is green in the current dirty worktree:
  - `tests/servertool/stopmessage-session-scope.spec.ts`
  - `tests/servertool/stop-message-native-decision.spec.ts`
  - `tests/servertool/stop-message-auto.config-precedence.spec.ts`
  - `tests/sharedmodule/stop-message-state-sync.spec.ts`
- `servertool-core` now owns backend-route outcome policy contract through `backend_route_contract.rs`.
- `router-hotpath-napi` exports `planServertoolBackendRoutePolicyJson`, and the TS native wrapper exposes `planServertoolBackendRoutePolicyWithNative`.
- Runtime shells for `web_search` and `vision_auto` now consume Rust backend-route plans; focused backend-route behavior suites are green:
  - `tests/servertool/server-side-web-search.spec.ts`
  - `tests/servertool/vision-flow.spec.ts`
  - `tests/servertool/servertool-mixed-tools.spec.ts`

Next execution order:

1. Collapse or physically delete TS backend-route semantic owners after Rust plan ownership is wired and green:
   - `backend-route-flow-policy.ts`
   - `backend-route-shape-guard.ts`
   - `backend-route-origin-delta.ts`
   - `backend-route-finalize-block.ts`
   - related web_search / vision semantic helper blocks.
2. Re-run servertool Rust-only gates and Rust core tests:
   - `cargo test -p servertool-core`
   - `cargo test -p servertool-cli`
   - `cargo test -p router-hotpath-napi test_plan_stop_message_persisted_lookup_json_uses_servertool_core_contract --lib -- --nocapture`
   - `cargo test -p router-hotpath-napi plans_backend_route_policy_via_servertool_core_bridge --lib -- --nocapture`
   - `npm run jest:run -- --runTestsByPath tests/servertool/server-side-web-search.spec.ts tests/servertool/vision-flow.spec.ts tests/servertool/servertool-mixed-tools.spec.ts --runInBand --forceExit`
   - `npm run verify:servertool-rust-only`
   - `npx tsc --noEmit --pretty false`
3. Tighten `verify:servertool-rust-only` so any restored TS backend-route/stopless semantic owner fails the gate.
4. Finish with build/install and real sample validation only after code gates pass.

Coordination boundary:

- Other workers may be editing Virtual Router and Hub Pipeline. Prefer `servertool-core`, `servertool-cli`, `scripts/verify-servertool-rust-only.mjs`, and servertool-specific TS shells/tests first.
- Avoid broad changes to `router-hotpath-napi/src/lib.rs`, Virtual Router modules, and Hub Pipeline modules unless the current servertool slice cannot be proven without that export or contract.
