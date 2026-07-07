# rustification-governance state

kill_switch: inactive
mode: L1 report-only
last_run_id: 2026-07-06T13:16:52+08:00-config-materialization-rust-closeout

## Current Baseline

- Loop initialized as report-only.
- No scheduler configured.
- No unattended action allowed.
- No code/config edits allowed from L1 runs.
- Baseline commit for this bootstrap: `c66511f`.
- Current worktree contains unrelated dirty runtime/WebUI/test/memory files; L1
  may report them as collision context but must not stage, reset, checkout, or
  delete them.
- Latest source/doc-only L1/config closeout: `npm run verify:llmswitch-rustification-audit`
  reports `prodTsFileCount=159`, `prodTsLocTotal=28837`,
  `nonNativeFileCount=35`, `nonNativeLocTotal=4743`; current Hub/VR semantic
  watchlist has no open `ts_semantic_debt` from that list.
- MemPalace artifact exclusion gate: `npm run verify:mempalace-scan-artifacts`
  reports `artifactHits=0`; representative generated/local examples under
  `dist/`, package `dist/`, Rust `target/`, `node_modules/`, `coverage/`,
  `.local-index/`, and `.mempalace/` are ignored. No root `mempalace.yaml` is
  present.
- Closeout-level gates are green on the current state:
  `cargo test -p router-hotpath-napi --lib`, `verify:llmswitch-rustification-audit`,
  `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`,
  `verify:responses-history-protocol-contract`, `build:base`, and
  `verify:architecture-ci`.
- Minimal TS surface is now machine-locked by
  `docs/loops/rustification/minimal-ts-surface.json` and
  `npm run verify:llmswitch-minimal-ts-surface`. Every current non-native
  production TS file must have a classification, owner, minimum TS role,
  forbidden semantics, and a hard cannot-shrink-further reason.
- The dead `conversion/hub/response/response-runtime.ts` compatibility barrel
  has been physically deleted after source-only reference proof. Tests/scripts
  must import the real native wrapper
  `conversion/hub/response/response-runtime-anthropic.js` directly.
- Root package export of `virtual-router-contracts.ts` is type-only
  (`export type *`) because that file declares only TS contracts and must not be
  treated as a runtime VR module.
- Upper production layers must not import `virtual-router-contracts.ts`
  directly. Hub/Host/Server code must consume VR contract types through the
  adjacent native facade that owns the call boundary, such as
  `native-virtual-router-runtime.ts`,
  `native-virtual-router-bootstrap-config.ts`, or
  `native-provider-runtime-ingress.ts`. The residue audit locks this boundary.
- Managed runtime/live proof is current:
  `routecodex --version`, `~/.rcc/install/current/package.json`, and repo
  `package.json` all report `0.90.3603`; `routecodex restart --port 5555`
  followed by `/health` on `5555` and `5520` returns `version=0.90.3603`, and
  same-entry live replay evidence is recorded in
  `/tmp/config-materialization-rust-live-5555.json`.

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
3. Build the candidate list from `git ls-files`, then apply the source/doc
   allowlist and generated-artifact denylist from `loop-constraints.md`.
   MemoryPalace and generated outputs are not valid L1 search evidence.
4. Inspect canonical inputs only after the source/doc-only filter is active.
5. Classify findings as `rust_ssot`, `native_shell_ok`, `ts_io_shell_ok`, or
   `ts_semantic_debt`.
   Current non-native TS residues must also match
   `docs/loops/rustification/minimal-ts-surface.json`; unclassified or
   over-broad residues are gate failures.
6. Emit report items with owner/gate references where available.
7. Append one JSON object to `loop-run-log.md`.

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
