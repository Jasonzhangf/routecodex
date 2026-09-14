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
`5d6357ab501f4e2ab84a87edf8fcd90e14fedec2` and post-commit timestamps.

## Unchanged boundary

Install, production restart, merge, and push are not authorized and have not
been performed. Source, test, gate, and review evidence do not upgrade to
install, restart, or live replay evidence.
