# runtime-lifecycle-release-watch state

kill_switch: inactive
mode: L1 report-only
last_run_id: 2026-07-04T00:00:00+08:00

## Current Baseline

- Loop initialized as report-only.
- No scheduler configured.
- No unattended action allowed.
- No code/config edits allowed from L1 runs.

## Watchlist

- `release_install_sync`: package version, build info, tarball, and installed
  global `rcc`/`routecodex` must match before any runtime completion claim.
- `runtime_lifecycle`: start/stop/restart behavior, port-group takeover, daemon
  supervisor, stop-intent, PID registry, and health.
- `verification_gate_mapping`: every actionable finding must map to function
  map, mainline call map, and verification map before L2.
- `webui_config_editor`: WebUI config editor work must preserve config codec,
  config writer, provider config writer, and Rust forwarder ownership before
  implementation.
- `worker_collision`: unrelated dirty files must remain untouched; loop reports
  collisions but does not stage, reset, checkout, or delete.

## L2 Gate Matrix

Canonical matrix: `docs/loops/runtime-lifecycle/gate-matrix.md`.

Allowed `watchlist_id` values:

- `release_install_sync`
- `runtime_lifecycle`
- `verification_gate_mapping`
- `webui_config_editor`
- `worker_collision`

## L1 Run Procedure

1. Confirm kill switch is inactive.
2. Read `LOOP.md`, this file, `loop-constraints.md`, `loop-budget.md`, and the
   tail of `loop-run-log.md`.
3. Inspect canonical inputs only.
4. Emit report items with owner/gate references where available.
5. Append one JSON object to `loop-run-log.md`.

## Promotion Criteria

L2 remains blocked until at least one L1 report identifies a concrete item with:

- One `watchlist_id` from `gate-matrix.md`.
- Unique owner in `function-map.yml`.
- Adjacent edge in `mainline-call-map.yml` when runtime path is affected.
- Required gates in `verification-map.yml`.
- Small owner-scoped diff proposal.
- Independent checker available.

L3 remains blocked until multiple L2 runs prove low false-positive rate and
budget compliance.
