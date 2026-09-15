# RCC Internal Hooks Sidecar Goal Plan

## Objective

Complete the optional in-RCC hooks sidecar as the production owner for
session-to-session message forwarding, timers, and mounted hooks. The sidecar
must be independently installable and startable, must use only the Codex
default TUI/Desktop App Server, and must degrade the hooks capability without
blocking RouteCodex server startup.

This is not a request to restore the removed Stopless business runtime.
Stopless behavior is expressed through the sidecar hook boundary.

## Worktree And Baseline

- Worktree:
  `/Users/fanzhang/Documents/github/routecodex/playground/rcc-internal-hooks-sidecar-0913`
- Branch: `codex/rcc-internal-hooks-sidecar-0913`
- Baseline: rebased onto `origin/main: 7818243a8` (original base `63ccc7902`
  was stale and carried a runtime gate violation that `origin/main` had already
  removed).
- Current state: implementation is committed on the branch. Preserve it; do not
  reset, restore, or replace the worktree.
- Governing contract:
  `docs/design/rcc-internal-hooks-sidecar-contract.md`
- Owning crates:
  `v3/crates/routecodex-v3-hooks`,
  `v3/crates/routecodex-v3-lifecycle`

## Required Architecture

```text
RCC managed lifecycle
  -> optional rccv3-hooksd start
  -> typed readiness or hooks_unavailable:<reason>
  -> RouteCodex server remains independent

Codex default TUI/Desktop App Server
  -> native session status and message transport
  -> rccv3-hooksd control socket

rccv3-hooksd
  -> message receive/forward
  -> timer registration and due-fire delivery
  -> mounted hook dispatch
  -> typed delivery evidence
```

The sidecar owns protocol adaptation and orchestration. It does not own
provider routing, request/response payload semantics, or Stopless business
policy. Do not create a private App Server, daemon, session, or alternate
transport when a native Codex App Server interface exists.

## Hard Constraints

- Use only the Codex default TUI/Desktop App Server.
- tmux may host TUI processes, but it is not a message channel. Sending,
  status reads, and continuation reads use the App Server control socket only.
- Do not make hooks readiness a prerequisite for RouteCodex startup.
- Hooks are optional at every lifecycle boundary. Missing, invalid, crashing,
  timing-out, stale, identity-mismatched, or cleanup-failing hooks must leave
  the main RouteCodex start, stop, restart, reap, and forced-stop paths
  bounded and usable. Cleanup uncertainty is reported as degraded detail and
  preserves the owned hooks record when its process group cannot be confirmed
  dead; it must not hold a lifecycle operation open indefinitely.
- A stale, invalid, or identity-mismatched hooks process record must degrade to
  `hooks_unavailable:<reason>` at every lifecycle boundary; it must never abort
  startup, reap, restart, or forced stop. The strict identity probe still
  refuses to signal a foreign process group.
- A sidecar failure must be explicit and typed. Do not silently succeed.
- Queue acceptance is not delivery, execution, reply, or read.
- Preserve source, target, session, message, and delivery identities.
- Do not use fallback, silent stripping, inferred control state, or fake
  success. Control truth belongs in typed control resources or the error chain.
- Do not use broad process termination. Use explicit PID- or service-scoped
  lifecycle operations only.
- Do not modify the dirty root, main, another worktree, or unrelated runtime
  code.
- No `--no-verify` and no bypass of repository hooks.

## Current Gaps

1. Mounted handlers are loaded from `--handlers-config` and persisted
   `SidecarPersistentState.handlers`; tests cover NoOp, Command, and the
   external Stopless example handler.
2. Desktop native App Server has been probed successfully with a real loaded
   thread and `SessionStatus` read. Same-session receipt, execution, reply, and
   read evidence is covered by the mock protocol replay, and TUI/TUI live
   replay reached `replied`; live Desktop reply/read is not closed because the
   default Desktop App Server rejects `list_turns`-style history reads.
3. The TUI App Server socket is currently absent. Missing TUI is recorded as
   fail-closed evidence, not replaced by a self-hosted server.
4. Failure behavior for unknown/disconnected sessions, working plus
   `idle_only`, send timeout/uncertainty, duplicate events, and sidecar restart
   has unit coverage. Live replay for those cases remains unverified.
5. The acceptance matrix and goal evidence must reflect actual source, test,
   build, install, and live layers separately. Live layer is the remaining
   gap.

## Execution Order

1. Inspect the existing worktree and preserve all current changes. Re-read the
   project `AGENTS.md`, `docs/design/rcc-internal-hooks-sidecar-contract.md`,
   and the relevant V3 maps before editing.
2. Establish the red test for the unmounted-handler fail-closed contract.
   Then make the smallest change in the owning hooks crate.
3. Run focused hooks tests, lifecycle tests, formatting, and Clippy. Record the
   first failing command verbatim before changing code.
4. Implement the smallest installable handler-loading/startup path required
   for `rccv3-hooksd`. Keep it in the sidecar owner; do not add a second
   runtime or business hook implementation.
5. Probe the real default Desktop App Server and TUI App Server with
   `rccv3-hooksd --once --probe-appserver <socket>`. A missing socket is a
   fail-closed result, not a reason to self-host.
6. Run same-entry replay with two distinct live sessions. Prove the full
   lifecycle rather than stopping at queue acceptance:

   ```text
   source event
     -> sidecar receives
     -> target selected
     -> native send accepted
     -> target receipt/delivery observed
     -> target execution observed when available
     -> target reply observed
     -> read/continuation evidence observed
   ```

   Run the replay for TUI/TUI and TUI/Desktop when both real sockets are
   available. If an endpoint is unavailable, report the exact missing socket
   and keep the corresponding live claim unverified.
7. Exercise the failure matrix: missing socket, unknown/disconnected session,
   working plus `idle_only`, send timeout/uncertain, duplicate event, and
   sidecar restart. Each case must assert the typed outcome and the absence
   of false success.
8. Update the contract and acceptance matrix with exact evidence, including
   commands, timestamps, socket paths, session/thread IDs, cursor/read item
   IDs, test counts, and known environment limitations.
9. Run the mapped V3 gates and the repository architecture gate. Distinguish
   pre-existing failures from regressions. Do not edit unrelated code to make
   a gate green.
10. Review the final diff using the project-selected reviewer. Only a clean
    review permits a commit.
11. Create the implementation commit on
    `codex/rcc-internal-hooks-sidecar-0913`. Push, merge, production rebuild,
    and production restart require explicit user authorization for this
    goal; do not infer them from a local test pass.

## Acceptance Criteria

The goal is complete only when all applicable items below are evidenced:

- `rccv3-hooksd` is buildable, installable, and can be started as an optional
  sidecar without blocking the RouteCodex managed server.
- Readiness and failure are typed:
  `hooks_unavailable:missing`, `hooks_unavailable:timeout`,
  `hooks_unavailable:invalid_readiness`, `hooks_unavailable:crashed`.
- A mounted hook receives an event and its result is sent through the same
  message gate as ordinary forwarding.
- An unmounted handler fails closed; registration alone never creates a
  silent no-op success.
- Scheduled messages are owned by the daemon and are delivered back to the
  registrant through that same send gate.
- Native App Server status perception and send paths use the default
  Codex TUI/Desktop transport.
- A real same-entry replay proves the accepted/delivered/executed/replied/read
  progression, or explicitly records the highest evidence layer reached.
- The failure matrix is tested with positive and negative assertions.
- Focused hooks and lifecycle tests pass; formatting and Clippy pass.
- Mapped V3 gates pass, with unrelated pre-existing failures reported
  separately and not hidden.
- The final diff changes only the sidecar, lifecycle integration, its contract,
  and its verification surfaces.
- Review is PASS before commit.

## Required Evidence Report

Final report must separate these layers:

```text
source changed
red test observed
targeted tests green
lifecycle tests green
architecture gates green
build green
install green
Desktop probe result
TUI probe result
live same-entry replay result
review verdict
commit SHA
push/merge/restart state
remaining risks
```

Do not collapse a lower layer into a later claim. In particular, a mock
transport test is not live TUI/Desktop delivery evidence, and a queued message
is not a reply.
