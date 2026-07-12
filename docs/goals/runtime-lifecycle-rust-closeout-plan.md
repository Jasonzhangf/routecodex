# Runtime Lifecycle Rust Closeout Plan

## Goal

Converge `runtime.lifecycle.*` so Rust owns lifecycle decisions and record plans, while TypeScript remains only the host shell for CLI parsing, OS process/signal execution, HTTP calls, filesystem IO, and release install wiring.

The target lifecycle is `runtime.lifecycle.mainline`, covering:

- `runtime.lifecycle.pid_cache`
- `runtime.lifecycle.stop_intent`
- `runtime.lifecycle.instance_registry`
- `runtime.lifecycle.restart_command`
- `runtime.lifecycle.start_command`
- adjacent `server.http_runtime_lifecycle` shell checks where needed

This task is a runtime refactor, not a map-only update. Completion requires source changes, tests, build/install evidence, and live restart proof.

## Acceptance Criteria

1. Rust/NAPI exposes one owner-specific lifecycle module for decisions and record plans.
2. TS no longer owns lifecycle semantics such as restart transport choice, start-restart takeover refusal, PID cache validity, stop-intent TTL/reap policy, or instance status transition rules.
3. TS callers execute only explicit Rust plans:
   - write/read/unlink files
   - call `/daemon/restart-process`
   - send explicit `SIGUSR2` to an already resolved target PID
   - spawn/start server only when Rust plan says the target is stopped/free
4. `rcc restart --port <port>` restarts inside the existing managed session and does not stop the original server by takeover.
5. Default `rcc start` and `rcc start --restart --port <port>` refuse before stop-intent, shutdown, or port takeover when a live runtime/listener exists; only explicit `--exclusive` remains a destructive takeover path.
6. Legacy root runtime files remain non-authoritative and do not re-enter decision logic.

## Scope

In scope:

- Rust lifecycle plan functions under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`.
- Owner-specific TS host under `src/modules/llmswitch/bridge/`, for example `runtime-lifecycle-host.ts`.
- Existing TS shells:
  - `src/utils/server-runtime-pid.ts`
  - `src/utils/server-runtime-stop-intent.ts`
  - `src/utils/runtime-instance-registry.ts`
  - `src/cli/commands/restart.ts`
  - `src/cli/commands/start.ts`
  - `src/server/runtime/http-server/http-server-lifecycle.ts`
  - `src/server/runtime/http-server/daemon-admin/restart-handler.ts`
  - `scripts/install-release.sh`
- Maps/gates/docs only where changed symbols or owners require updates.

Out of scope:

- Provider routing, Hub Pipeline payload semantics, WebUI redesign, SSE projection semantics, and error reroute policy.
- Broad runtime rewrite in TS.
- Any fallback path where TS repeats Rust decisions.
- Process cleanup by broad kill commands.

## Design Principles

1. Decision owner is Rust; execution owner is TS.
2. PID is a transient cache, never runtime truth.
3. Runtime truth is `/health` + listener identity + instance registry.
4. Restart is an in-session request to the existing process/supervisor.
5. Start is launch only; it is not a restart transport.
6. Fail fast on conflict, stale state, missing target, invalid plan, and version mismatch.
7. No fallback, no silent repair, no hidden takeover.

## Technical Plan

### Rust owner

Create or extend an owner-specific Rust module with JSON entrypoints for:

- `plan_runtime_pid_cache_write`
- `plan_runtime_pid_cache_read_result`
- `plan_runtime_stop_intent_write`
- `plan_runtime_stop_intent_consume`
- `plan_runtime_instance_write`
- `plan_runtime_instance_status_update`
- `plan_runtime_restart_request`
- `plan_runtime_start_restart_takeover_guard`

The Rust return shape must be an explicit plan, not an implicit boolean. Suggested plan types:

- `RuntimeLifecycleDecision01Input`
- `RuntimeLifecycleDecision02ObservedState`
- `RuntimeLifecycleDecision03Plan`
- `RuntimeLifecycleRecord04Projection`

Plan outputs must include:

- action kind
- target port/host
- required IO operation
- expected preconditions
- visible failure reason
- resource ids touched

### TS host shell

Add a narrow host wrapper, for example:

- `src/modules/llmswitch/bridge/runtime-lifecycle-host.ts`

The host may call `native-exports.ts`, but non-bridge runtime files must import only this owner-specific host. Do not expand broad `native-exports` callers.

### TS collapse

Collapse current TS lifecycle files by role:

- `server-runtime-pid.ts`: path/file IO shell around Rust PID plan.
- `server-runtime-stop-intent.ts`: path/file IO shell around Rust stop-intent plan.
- `runtime-instance-registry.ts`: path/file IO shell around Rust instance record plan.
- `restart.ts`: CLI parsing + HTTP/SIGUSR2 execution shell around Rust restart decision.
- `start.ts`: launch shell + Rust takeover guard; default start is launch-only and must not become a restart transport.
- `install-release.sh`: live runtime exists -> global installed `rcc restart`; stopped target -> `rcc start --no-restart`; version mismatch -> visible failure.

Delete any TS helper that becomes zero-ref after the host split. Do not keep "just in case" wrappers.

## File Checklist

Likely source files:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*runtime_lifecycle*`
- `src/modules/llmswitch/bridge/native-exports.ts`
- `src/modules/llmswitch/bridge/runtime-lifecycle-host.ts`
- `src/utils/server-runtime-pid.ts`
- `src/utils/server-runtime-stop-intent.ts`
- `src/utils/daemon-stop-intent.ts`
- `src/utils/runtime-instance-registry.ts`
- `src/cli/commands/restart.ts`
- `src/cli/commands/start.ts`
- `src/server/runtime/http-server/daemon-admin/restart-handler.ts`
- `scripts/install-release.sh`

Likely test/gate files:

- `tests/utils/server-runtime-pid.spec.ts`
- `tests/utils/daemon-stop-intent.spec.ts`
- `tests/utils/runtime-instance-registry.spec.ts`
- `tests/cli/restart-command.spec.ts`
- `tests/cli/restart-command.probe-host.spec.ts`
- `tests/cli/start-command.spec.ts`
- `tests/scripts/install-release-dependencies.spec.ts`
- `tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts`
- `scripts/architecture/verify-runtime-lifecycle-pid-rebase.mjs`
- `scripts/architecture/verify-runtime-lifecycle-loop-gate-matrix.mjs`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/resource-operation-map.yml`
- `docs/architecture/wiki/runtime-lifecycle-call-graph.md`

## Verification Matrix

Red tests first:

- Default start and `start --restart` with existing runtime/listener must fail before stop-intent and shutdown.
- restart must not spawn `start --restart`.
- PID cache mismatch must not become runtime truth.
- stale stop-intent must be reaped, not consumed as current truth.
- instance status update must not be written by unrelated request/provider routes.

Focused tests:

- `tests/utils/server-runtime-pid.spec.ts`
- `tests/utils/daemon-stop-intent.spec.ts`
- `tests/utils/runtime-instance-registry.spec.ts`
- `tests/cli/restart-command.spec.ts`
- `tests/cli/restart-command.probe-host.spec.ts`
- `tests/cli/start-command.spec.ts`
- `tests/scripts/install-release-dependencies.spec.ts`

Architecture/resource gates:

- `npm run verify:resource-operation-map`
- `npm run verify:runtime-lifecycle-pid-rebase`
- `npm run verify:runtime-lifecycle-loop-gate-matrix`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `node scripts/ci/llmswitch-rustification-audit.mjs --json`
- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`

Build/install/live:

- `npm run build:native-hotpath`
- `npm run build:base`
- `npm run install:release`
- `routecodex --version`
- `rcc --version`
- `cat ~/.rcc/install/current/package.json`
- target ports `/health` and `/health.version`
- `routecodex restart --port <port>` using global install only
- process lifecycle log check proving original managed session/supervisor handled restart

## Implementation Steps

1. Re-read the current lifecycle maps and source anchors before editing:
   - `docs/design/server-runtime-lifecycle-ssot.md`
   - `docs/architecture/function-map.yml`
   - `docs/architecture/mainline-call-map.yml`
   - `docs/architecture/verification-map.yml`
   - `docs/architecture/resource-operation-map.yml`
2. Add red tests for the exact TS-owned semantics being moved.
3. Add Rust lifecycle plan entrypoints and direct Rust/NAPI tests.
4. Add the narrow TS host and route TS lifecycle callers through it.
5. Collapse TS semantic branches into plan execution only.
6. Delete obsolete zero-ref wrappers/helpers.
7. Update function map, mainline map, verification map, resource bindings, and wiki if symbols or owner paths change.
8. Run focused tests and architecture gates.
9. Build native hotpath and base package.
10. Install globally and verify versions match command entry, install/current, and live `/health.version`.
11. Restart a live managed port with global `routecodex restart --port <port>` and prove the original session/supervisor restarted the child instead of stopping/replacing it.
12. Record the reusable lesson in project memory/skill if a new lifecycle rule or anti-pattern is found.

## Risks

- Accidentally moving OS process execution into Rust instead of keeping Rust as decision owner and TS as IO executor.
- Preserving a TS fallback branch after Rust plan wiring.
- Treating unit/build evidence as live restart proof.
- Reusing repo-local `node dist/...` or `rcc start` as runtime validation.
- Breaking install-release by reintroducing `start --restart` takeover.

## Definition of Done

- Runtime lifecycle decisions are Rust-owned and exposed through an owner-specific host.
- TS lifecycle files are execution shells only.
- Broad `native-exports` is not imported by lifecycle callers outside `src/modules/llmswitch/bridge`.
- Red/green tests, resource/function/mainline gates, native/base builds, global install, and live in-session restart proof all pass.
- No fallback, no silent failure, no broad kill, no unverified completion claim.
