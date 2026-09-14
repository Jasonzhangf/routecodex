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

## Unchanged boundary

Install, production restart, merge, and push are not authorized and have not
been performed. Source, test, gate, and review evidence do not upgrade to
install, restart, or live replay evidence.
