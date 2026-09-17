# RCC Internal Hooks Sidecar Integration Review Record

Branch: `codex/rcc-internal-hooks-sidecar-main-0914`
Worktree: `/Users/fanzhang/Documents/github/routecodex/playground/rcc-internal-hooks-sidecar-main-0914`
Base: `origin/main` `3fe9790007f7d2abfe044dd7a466c258847c53f4`

## Round 1: commit `cd2736364`, task `rcc-internal-hooks-sidecar-integration-0914-r1`

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-hooks/src/appserver.rs:790`:
  `read_server_frame` trusted the advertised WebSocket payload length and
  allocated `vec![0_u8; len]` before any validation, so a peer on the local App
  Server socket could force an unbounded allocation.

Fix: `NATIVE_MAX_FRAME_PAYLOAD = 8 MiB` is checked before the allocation for
both the 7-bit/extended and 64-bit length paths; over-limit frames return
`AppServerError::Transport`.

Red evidence (guard neutralized with `if false`):

```text
exit 1  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks --lib appserver::tests::oversized
          test appserver::tests::oversized_advertised_native_frame_is_rejected_before_allocation
          has been running for over 60 seconds
          process didn't exit successfully (signal: 15, SIGTERM)
          (the unguarded parser attempted the advertised huge allocation)
```

Green evidence: `appserver::tests` 17 pass, including
`oversized_advertised_native_frame_is_rejected_before_allocation` and
`in_limit_native_frame_is_accepted`.

## Round 2: commit `f919d1bbf`, task `rcc-internal-hooks-sidecar-integration-0914-r2`

Verdict: `fail / code_failure`, two P1.

- P1 `v3/crates/routecodex-v3-hooks/src/control.rs:446`: `Shutdown` made
  `serve_forever` return while the bound Unix socket stayed on disk, so the
  next `ControlServer::new` on the same path hit `AddrInUse` until an external
  cleanup removed it.

Fix: `ControlServer` keeps its bound `socket_path` and removes it after the
accept/timer loop exits; `NotFound` is treated as success. The regression test
asserts the path is gone after a graceful shutdown and rebinds without any
test-side unlink.

Red evidence (cleanup neutralized with `if false`):

```text
exit 1  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks --lib control_server_serves
          panicked at crates/routecodex-v3-hooks/src/control.rs:703:
          shutdown must remove the owned control socket
```

- P1 `docs/architecture/v3-verification-map.yml:31`: the declared
  `required_gates` and `live_required` had no retained receipts in the
  candidate.

Fix: `docs/design/rcc-internal-hooks-sidecar-contract.md` now carries the
integration gate receipts with timestamps, and this file records the review
rounds. The `live_required` items remain open and are restated in the contract
as an explicit highest-layer capability gap rather than being claimed.

## Round 3: commit `dd0b9cb29`, task `rcc-internal-hooks-sidecar-integration-0914-r3`

Verdict: `fail / code_failure`, three P1.

- P1 `v3/crates/routecodex-v3-hooks/src/control.rs:418`: shutdown removed the
  control socket pathname without verifying the inode it owned, so a foreign
  replacement socket on the same pathname could be deleted.

Fix: `ControlServer` records the bound socket identity (`dev`, `ino`,
`is_socket`) at bind time and `serve_forever` unlinks the path only when the
current path still matches that identity. A replacement socket survives
shutdown.

Red evidence (identity guard neutralized):

```text
exit 1  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks --lib control_server_shutdown_never
          panicked at crates/routecodex-v3-hooks/src/control.rs:809:
          replacement must survive: Os { code: 2, kind: NotFound, ... }
```

- P1 `docs/design/rcc-internal-hooks-sidecar-contract.md:445`: the committed
  contract did not close the declared real installed-binary sidecar failure
  injection.

Fix: the live failure injection was run with the actual `rccv3` entrypoint,
  an isolated config, and a real installed `rccv3-hooksd` path that exits
  before readiness. The server stayed `running` and status reported
  `hooks_unavailable:crashed`.

Evidence:

```text
command  ROUTECODEX_HOOKS_INSTALL_RECORD=$ROOT/install.json \
           v3/target/debug/rccv3 start --config $ROOT/config.v3.toml --snap
status   rccv3 status --config $ROOT/config.v3.toml
detail   hooks sidecar unavailable: hooks_unavailable:crashed:
         managed lifecycle validation failed: hooks sidecar exited before readiness
state    running
health   started listeners on 127.0.0.1:45464/45465/45466
```

- P1 `docs/design/rcc-internal-hooks-sidecar-contract.md:413`: the gate
  receipts predated the final commit and did not bind to the exact reviewed
  candidate.

Fix: all affected gates were re-run against the exact post-commit candidate
and the contract receipt section now carries the candidate code commit
`7f327065368ed55cfc710aa9e5fbd7e589fccd5b` and post-commit timestamps.

## Round 13: merged candidate `1b408a085`, task `rcc-internal-hooks-sidecar-main-0914-r13`

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-hooks/src/appserver.rs:580`: the native transport
  treated any non-empty `backwardsCursor`/`nextCursor` from
  `thread/items/list` or `thread/turns/list` as proof that the target read the
  reply. A pagination cursor is not a read receipt, so a normal history page
  containing an assistant reply could be promoted from `replied` to `read`.

Fix: removed the pagination cursor from `NativeBaselineSnapshot` and from
`correlate_delivery_evidence`. Receipt plus correlated assistant reply now
stops at `replied`; `cursor` and `read_item_id` remain unset until an explicit
native read observation exists. Added the regression
`delivery_evidence_does_not_promote_pagination_cursor_to_read`, which feeds a
page containing a receipt, same-turn reply, and `backwardsCursor` and asserts
the result remains `replied`.

Verification after the fix:

```text
CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
  61 lib + 3 binary_handler_config + 1 binary_readiness + 6 native_delivery_replay pass
```

The prior P1 is fixed but this merge candidate requires a new independent
review after the fix commit.

## Round 14: fix candidate `ef5fc0503`, task `rcc-internal-hooks-sidecar-main-0914-r14`

Verdict: `fail / code_failure`, one P1.

- P1 `docs/design/rcc-internal-hooks-sidecar-contract.md:406`: the integration
  gate receipts still named source candidate `d59e6f6be` and claimed later
  commits were documentation-only. The reviewed source fix in `ef5fc0503`
  changed native App Server correlation, so those receipts did not prove the
  current candidate had passed the required gates.

Fix: the contract now binds the receipts to source candidate `ef5fc0503`,
tree `573d8c3f9a793409f94152ce3896a968ae8f21ea`, and base
`c37a3946a`. Subsequent branch commits are limited to documentation or the
version-only merge from current `origin/main`, and the hooks source subtree
receipt is proven unchanged with:

```text
git diff --exit-code ef5fc0503 -- \
  v3/crates/routecodex-v3-hooks \
  v3/crates/routecodex-v3-lifecycle \
  v3/scripts/install-cli.mjs \
  v3/scripts/copy-cli-bin.mjs \
  v3/scripts/pack-release.mjs
```

The prior P1 requires a new independent review of the updated candidate.

## Round 15: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r15`

Scope: hooks become optional at every lifecycle boundary. Scope covers
asynchronous sidecar supervision, bounded stop, degraded stop/restart
completion, reap/forced-stop non-blocking behavior, bounded status `flock`,
and the tests that pin each boundary.

Verdict: `fail / code_failure`, one P1.

- P1 `docs/design/rcc-internal-hooks-sidecar-contract.md:410`: the integration
  receipts were still bound to source candidate `ef5fc0503` while the current
  uncommitted scope changes runtime lifecycle source, so the receipts could be
  read as current-candidate evidence.

Fix: the receipt section now names the uncommitted scope explicitly
(`HEAD:d9b78d0378...`, HEAD tree `7bfc322a05...`, lifecycle source diff object
`5d1b5a012d...`), records the current gate results (lifecycle 59 pass, CLI
managed lifecycle 21 pass, hooks 61+3+1+6 pass, distribution 6 pass,
`verify:v3-file-size`, `verify:v3-architecture-ci` 39/39), and demotes the
earlier installed-binary failure injection to historical evidence bound to
`ef5fc0503`.

Verification after the fix:

```text
exit 0  npm run verify:v3-architecture-docs   docs 26; resources 178; edges 449
exit 0  npm run verify:v3-resource-map
exit 0  npm run verify:v3-mainline-caller-flow
exit 0  git diff --check
```

## Round 16: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r16`

Scope: managed control-plane failures must not bypass hooks cleanup, malformed
or stuck control clients must not hang the managed runtime, and the file-size
gate must stay green after the P1 fix.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/lib.rs`: fatal control-loop exits
  after hooks supervisor spawn returned directly through `?` or `return Err`,
  bypassing hooks cleanup and leaving a possible sidecar process record/group.

Fix: fatal listener/read/signal/internal errors after supervisor spawn now go
through `control_plane::fail_managed_runtime_with_hooks_cleanup`. The helper
shuts down the server handle with a bounded 2s timeout, stops the hooks
supervisor through the existing bounded stop path, writes a `Failed` status
with the primary runtime error plus hooks cleanup detail, and never lets a
status-write failure replace the primary error. Control input is bounded:
malformed JSON returns a non-accepted `Running` response and keeps the loop
alive, `read_line` is bounded by `CONTROL_TIMEOUT`, and control response write
errors are logged and continue instead of killing the managed runtime.

Added tests:

```text
routecodex-v3-lifecycle --lib
  fatal_runtime_failure_stops_supervisor_and_preserves_primary_error
routecodex-v3-cli --test managed_lifecycle
  malformed_control_json_does_not_stop_managed_runtime_or_escape_hooks_cleanup
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo check --locked -p routecodex-v3-lifecycle
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        60 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  git diff --check
```

## Round 17: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r17`

Scope: bounded supervisor stop timeout must not orphan an owned hooks process
group or leave a permanently live process record.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs`: the supervisor
  timeout path aborted the task and lost the Tokio `Child` handles. The
  sidecar wrapper and anchor were spawned without `kill_on_drop`, so a process
  group that did not finish within the stop window could remain alive while the
  persisted process record was preserved; later startup would degrade without a
  recovery path.

Fix: keep the supervisor task from being the only owner of both Child handles;
the timeout path now performs a bounded synchronous cleanup from the persisted,
identity-checked record before returning. It refuses to signal a PGID that no
longer matches the recorded leader, SIGKILLs only the validated process group,
waits for the group to disappear, and removes the process record. Both Child
spawn sites also set `kill_on_drop(true)` so aborted or dropped startup paths
do not silently release process handles.

Added test:

```text
routecodex-v3-lifecycle --lib
  supervisor_timeout_force_reaps_owned_group_and_record
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo check --locked -p routecodex-v3-lifecycle
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        61 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  git diff --check
```

## Round 18: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r18`

Scope: confirm the `v3.managed_server_lifecycle` owner's declared
`required_gates` have current receipts for the reviewed candidate.

Verdict: `fail / code_failure`, one P1.

- P1 `docs/architecture/v3-function-map.yml:215`: the reviewer's read-only
  sandbox could not open `v3/target/debug/.cargo-build-lock`, so it observed no
  successful receipts for the owner's declared lifecycle gates and treated the
  missing current evidence as blocking.

Fix: the integration gate receipt section now records the owner's declared
`required_gates` explicitly for this candidate:
`verify:v3-managed-server-lifecycle`, 69 red fixtures,
`test:v3-managed-server-lifecycle` (22 pass), `verify:v3-architecture-docs`,
`verify:v3-resource-map`, `verify:v3-module-boundaries`,
`verify:v3-rust-only`, `verify:function-map-compile-gate`,
`verify:v3-cargo-fmt`, and scoped lifecycle Clippy. `verify:v3-clippy` still
exits 1 on pre-existing failures in untouched `routecodex-v3-route-classifier`
and `routecodex-v3-config`; the changed lifecycle crate is warnings-only with
0 errors.

The review sandbox is read-only and cannot execute Cargo build locks; gate
execution must run in the writable integration worktree, whose receipts are
recorded in `docs/design/rcc-internal-hooks-sidecar-contract.md`.

## Round 19: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r19`

Scope: the stop path must preserve `hooks-sidecar.pid` whenever hooks cleanup
cannot be confirmed, so a live or unverifiable owned process group is never
orphaned from its persisted identity.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/control_plane.rs`: the reviewer
  read `shutdown_managed_runtime` as removing `hooks-sidecar.pid`
  unconditionally after recording a degraded hooks cleanup detail, which would
  let a live or unverifiable owned process group lose the record later startup
  and reap use to detect or safely recover it.

Fix: the stop path now states the invariant directly, removing
`hooks-sidecar.pid` only when `hooks_sidecar.stop()` returns `Ok`; any stop
error keeps the record and is written as the `Stopped` status detail.
`restart_managed_runtime_in_place` already had the same conditional shape, and
`cleanup_forced_stopped_runtime_state` already removes the record only when
`hooks_sidecar_cleanup_incomplete_detail` is `None`. The regression is pinned
by `failed_hooks_stop_completes_main_lifecycle_and_reports_degraded_cleanup`,
which asserts the record still exists after a failed stop while the main
lifecycle reaches `Stopped` and clears `pid.cache`, `control.json`, and the
managed socket.

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        61 pass
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  cargo fmt --manifest-path v3/Cargo.toml --all -- --check
exit 0  git diff --check
```

## Round 20: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r20`

Scope: forced cleanup of a dead hooks process group must not delete the
persisted record while leaving an owned socket behind, and legacy-supervisor
codexapp socket cleanup must survive the supervisor task being gone.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar/process.rs`: the
  already-dead fast path in `force_terminate_sidecar_by_record` deleted
  `hooks-sidecar.pid` without first removing the identity-checked
  `hooks-sidecar.sock`, so a sidecar that exited before the forced stop could
  leave the control socket behind with no record left to verify it. The same
  function also had no access to the legacy-supervisor `CodexAppSocketCleanup`
  once the supervisor task was aborted or timed out, because that cleanup
  metadata existed only in memory.

Fix: `finish_forced_sidecar_cleanup` now removes the internal control socket
through its recorded identity and then consumes the persisted
`codexapp_socket_cleanup` before deleting the process record, on both the
already-dead fast path and the post-SIGKILL path. The legacy supervisor path
persists `CodexAppSocketCleanup` (path, install root, pre-start identity,
startup identity) into `V3HooksSidecarProcessRecord` after readiness, and the
startup stale-record path runs the persisted cleanup before removing the stale
record. Cleanup remains identity-checked, so a replacement or foreign socket
is never unlinked.

Added tests:

```text
routecodex-v3-lifecycle --lib
  forced_cleanup_removes_dead_group_control_socket_and_record
  forced_cleanup_uses_persisted_legacy_codexapp_socket_cleanup
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo check --locked -p routecodex-v3-lifecycle
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        63 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  npm run verify:v3-managed-server-lifecycle
exit 0  npm run test:v3-managed-server-lifecycle-red-fixtures
        69 fixtures
exit 0  npm run test:v3-managed-server-lifecycle
        22 pass
exit 0  npm run verify:v3-architecture-docs
exit 0  npm run verify:v3-resource-map
exit 0  npm run verify:v3-module-boundaries
exit 0  npm run verify:v3-rust-only
exit 0  npm run verify:function-map-compile-gate
exit 0  npm run verify:v3-cargo-fmt
exit 0  git diff --check
```

## Round 21: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r21`

Scope: the readiness-to-record-update window must not let the bounded stop path
delete an identity-less process record while an owned `hooks-sidecar.sock`
remains, and a later lifecycle start must not inherit that socket.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs:610`: the process
  record is first persisted with `control_socket_identity: None`, and the
  internal-hooksd identity is written only after readiness. If
  `V3HooksSidecarSupervisor::stop` timed out inside that window,
  `force_terminate_sidecar_by_record` could delete the record with no identity
  available to remove the control socket, while the detached startup task
  could still win the readiness race and proceed.

Fix: `finish_forced_sidecar_cleanup` now retains the process record when the
control-socket identity is not yet persisted and an owned
`hooks-sidecar.sock` still exists, instead of deleting the record and
orphaning an unverifiable socket. The startup path now re-checks the
supervisor stop flag immediately after readiness, so a stop-requested startup
falls through to the in-memory failure cleanup rather than adopting the
sidecar or rewriting the record. The startup stale-record path removes a
leftover control socket after the recorded process group is confirmed dead:
by recorded identity when present, otherwise only after verifying the path is
still a socket, since the new sidecar has not been spawned yet.

Added tests:

```text
routecodex-v3-lifecycle --lib
  forced_cleanup_retains_record_until_control_socket_identity_is_persisted
  stale_record_without_control_socket_identity_is_reaped_before_internal_start
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        65 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  git diff --check
```

## Round 22: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r22`

Scope: persisted identity checks must only authorize removal of sockets, not
regular files at a socket path.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar/process.rs:20`:
  `remove_file_if_identity_matches` removed the path whenever the recorded
  `CodexAppSocketIdentity` matched, but it did not require the recorded and
  current identities to be sockets. A persisted record with `is_socket: false`
  whose device/inode matched could therefore authorize deletion of a regular
  file at `hooks-sidecar.sock` from the forced-cleanup or stale-record path.

Fix: the helper now returns without removal unless the recorded identity is a
socket, and also requires the current path identity to be a socket before the
metadata comparison. Non-socket entries are left untouched.

Added test:

```text
routecodex-v3-lifecycle --lib
  persisted_non_socket_identity_never_authorizes_file_removal
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        66 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  git diff --check
```

## Round 23: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r23`

Scope: failed-startup cleanup must preserve non-socket replacements at the
control-socket path when no socket identity was captured.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs:971`:
  `finish_sidecar_start_failure` used `remove_file_if_present` when
  `control_socket_identity` was `None`. That can occur when the path did not
  exist at identity capture time, and a regular file or symlink created
  afterward could then be deleted during failed startup. The same
  unconditional `None` cleanup also existed in `V3HooksSidecarProcess::stop`.

Fix: both cleanup paths now use `remove_control_socket_if_present`, which only
unlinks a current filesystem entry that is verified as a socket. Regular files
and symlinks at the path are preserved.

Added test:

```text
routecodex-v3-lifecycle --lib
  control_socket_cleanup_without_identity_never_deletes_regular_file
```

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        67 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-managed-server-lifecycle
exit 0  npm run test:v3-managed-server-lifecycle-red-fixtures
        69 fixtures
exit 0  npm run verify:v3-architecture-docs
exit 0  npm run verify:v3-resource-map
exit 0  npm run verify:v3-module-boundaries
exit 0  npm run verify:v3-rust-only
exit 0  npm run verify:function-map-compile-gate
exit 0  npm run verify:v3-cargo-fmt
exit 0  git diff --check
```

## Round 24: uncommitted optional-lifecycle candidate, task `rcc-internal-hooks-sidecar-main-0914-r24`

Scope: the bounded-stop timeout path must not report successful hooks cleanup
when forced cleanup preserved the persisted process record, because the main
stop path could then delete that record unconditionally and lose the identity
needed for a later safe cleanup.

Verdict: `fail / code_failure`, one P1.

- P1 `v3/crates/routecodex-v3-lifecycle/src/hooks_sidecar.rs:176` and
  `v3/crates/routecodex-v3-lifecycle/src/control_plane.rs:129`: forced cleanup
  could return `RecordPreserved` after the supervisor timeout, but the stop
  path still returned `Ok`; `shutdown_managed_runtime` then removed
  `hooks-sidecar.pid` unconditionally. A preserved record could therefore be
  deleted while its owned control socket or process-group identity was still
  needed for cleanup.

Fix: `force_terminate_sidecar_by_record` now returns an explicit
`ForcedSidecarCleanup::{RecordRemoved, RecordPreserved}` result.
`V3HooksSidecarSupervisor::stop` maps `RecordPreserved` to a degraded
validation error, and `shutdown_managed_runtime` no longer removes the hooks
process record; `cleanup_forced_stopped_runtime_state` removes it only when
`hooks_sidecar_cleanup_incomplete_detail` is `None`. The main stop lifecycle
still completes with `Stopped` and a degraded detail, so a hooks cleanup
problem cannot block or hang the RouteCodex service.

Verification after the fix:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib -- --test-threads=1
        67 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
        --test managed_lifecycle -- --test-threads=1
        22 pass
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
        61 lib + 3 binary_handler_config + 1 binary_readiness
        + 6 native_delivery_replay pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
        6 pass
exit 0  npm run verify:v3-file-size
        limit=1500; files=274
exit 0  npm run verify:v3-architecture-ci
        39/39 sub-gates green
exit 0  npm run verify:v3-managed-server-lifecycle
exit 0  npm run test:v3-managed-server-lifecycle-red-fixtures
        69 fixtures
exit 0  npm run verify:v3-architecture-docs
exit 0  npm run verify:v3-resource-map
exit 0  npm run verify:v3-module-boundaries
exit 0  npm run verify:v3-rust-only
exit 0  npm run verify:function-map-compile-gate
exit 0  npm run verify:v3-cargo-fmt
exit 0  git diff --check
```

The lifecycle source diff object for this candidate is
`b9be7fc050425b9b35459d30eb8576daf101225a`.

## Round 25: rebuilt candidate `d38ff088c`, task `rcc-internal-hooks-rebuild-0916-review`

Verdict: `fail / code_failure`, one P1.

- P1 `docs/architecture/v3-function-map.yml:65`: the feature declares
  `live_required` same-entry replay, but the rebuilt candidate had no
  commit-bound live replay receipt or explicit highest-layer capability gap.

Fix: `docs/design/rcc-internal-hooks-sidecar-contract.md` now binds the
rebuilt candidate, tree, base, binary hash, App Server socket, and live
observations. The receipt records:

- Desktop `idle_only` deferred and `working_allowed` accepted with the exact
  `thread already has an active or pending turn` start error; no delivery,
  reply, or read is claimed for that active target.
- TUI A -> TUI B `accepted -> delivered -> replied` with native message ids,
  plus the target pane marker and reply as corroboration.
- The exact history-read capability errors and the remaining `read` gap; no
  cursor, pane text, or reply id is promoted to a native read receipt.

The receipt is bound to source candidate `d38ff088c`. Any follow-up commit is
documentation-only and must leave the hooks, lifecycle, and release source
paths unchanged; the contract includes the exact `git diff --exit-code`
verification command.

## Unchanged boundary

Install, production restart, merge, and push are not authorized and have not
been performed. Source, test, gate, and review evidence do not upgrade to
install, restart, or live replay evidence.
