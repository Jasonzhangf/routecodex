# rustification-governance state

kill_switch: inactive
mode: L1 report-only
last_run_id: 2026-07-05T00:00:00+08:00

## Current Baseline

- Loop initialized as report-only.
- No scheduler configured.
- No unattended action allowed.
- No code/config edits allowed from L1 runs.
- Baseline commit for this bootstrap: `c66511f`.
- Current worktree contains unrelated dirty runtime/WebUI/test/memory files; L1
  may report them as collision context but must not stage, reset, checkout, or
  delete them.

## Current Classification Terms

- `rust_ssot`
- `native_shell_ok`
- `ts_io_shell_ok`
- `ts_semantic_debt`

## Watchlist

- `hub_pipeline_semantics`: Hub request/response Chat Process, tool governance,
  servertool followup, continuation save/restore, and history/reasoning policy.
- `virtual_router_semantics`: Virtual Router route selection, forwarder
  behavior, provider failure/reroute policy, and no provider-specific payload
  repair in Hub/VR.
- `server_io_boundary`: Express handlers, Responses handler, SSE writer,
  MetadataCenter attach/release, process lifecycle, and client frame IO.
- `provider_transport_boundary`: provider SDK/fetch transport, auth headers,
  provider wire codecs, streaming parser, and transport error capture.

## L2 Gate Matrix

Canonical matrix: `docs/loops/rustification/gate-matrix.md`.

Allowed `watchlist_id` values:

- `hub_pipeline_semantics`
- `virtual_router_semantics`
- `server_io_boundary`
- `provider_transport_boundary`

## L1 Run Procedure

1. Confirm kill switch is inactive.
2. Read `LOOP.md`, this file, `loop-constraints.md`, `loop-budget.md`, and the
   tail of `loop-run-log.md`.
3. Inspect canonical inputs only.
4. Classify findings as `rust_ssot`, `native_shell_ok`, `ts_io_shell_ok`, or
   `ts_semantic_debt`.
5. Emit report items with owner/gate references where available.
6. Append one JSON object to `loop-run-log.md`.

## Promotion Criteria

L2 remains blocked until at least one L1 report identifies a concrete item with:

- One `watchlist_id` from `gate-matrix.md`.
- Unique owner in `function-map.yml`.
- Adjacent edge in `mainline-call-map.yml` when runtime path is affected.
- Required gates in `verification-map.yml`.
- Small owner-scoped diff proposal.
- Independent checker available.

L3 remains blocked until multiple L2 runs prove low false-positive rate, budget
compliance, and independent checker reliability.
