# runtime-lifecycle-release-watch gate matrix

This file is the L2 approval matrix for `runtime-lifecycle-release-watch`.
It turns a report-only finding into an assisted, owner-scoped action only when
the owner, mainline edge, tests, blackbox replay, and checker evidence are all
known.

L2 remains disabled by default in `STATE.md`. A human-approved L2 run may use
only one matrix row and one owner path.

## Global L2 Entry Gate

Every L2 run must satisfy all items below before editing:

| Gate | Required evidence |
| --- | --- |
| State | `STATE.md` has `kill_switch: inactive`, and human approval explicitly enables this L2 item. |
| Scope | One `watchlist_id` from this matrix, one `item_id`, one owner feature, and one owner path. |
| Owner | `docs/architecture/function-map.yml` resolves the unique `feature_id`, allowed paths, forbidden paths, and required tests. |
| Mainline | `docs/architecture/mainline-call-map.yml` resolves the adjacent `runtime.lifecycle.mainline` edge when runtime behavior is affected. |
| Verification | `docs/architecture/verification-map.yml` resolves unit/contract/integration/smoke/build gates. |
| Checker | A separate verifier pass or separate worker is identified before approval. |
| Worktree | `git status --short` is reviewed; unrelated dirty files are not staged, reset, checked out, or deleted. |
| Safety | No auth, secrets, provider account, payment, production config, migration, broad cleanup, broad kill, fallback, disabled test, or weakened assertion. |

## Matrix

### `release_install_sync`

Purpose: prove source, package metadata, release snapshot, installed shims, and
live runtime version all describe the same build before any release completion
claim.

| Layer | Required gates |
| --- | --- |
| Owner | `scripts/install-release.sh`, `scripts/install-release-snapshot.mjs`, `scripts/verify-rcc-release-install.mjs`, `package.json`, `package-lock.json`, `src/build-info.ts`. |
| Feature map | Build wiring gate plus affected runtime lifecycle feature if start/restart behavior changes. |
| Mainline | `runtime.lifecycle.mainline` only when install adoption writes stop-intent or starts/restarts a managed process. |
| Whitebox | `npm run verify:function-map-build-wiring`; version sync check for `package.json`, lock root, lock package root, and `src/build-info.ts`; focused test for any touched script/helper. |
| Blackbox | `npm run install:release` with explicit `ROUTECODEX_INSTALL_VERIFY_PORT=<port>`; `routecodex --version`; `rcc --version`; `/health.version === package.json.version` on the verification port and every configured sibling port affected by restart. |
| Quality | Prove build/pack scripts do not mutate global install; release verifier uses temp `--prefix`; no repo path leaks in packed packages; no symlinked `rcc-llmswitch-core`; no stale live version accepted. |
| Evidence | run log must include source version, CLI versions, install/current release path, health version per port, and live probe command/result. |
| Escalate | Any version mismatch, wrong runtime root, install script hang, health mismatch, or required blackbox unavailable. |

### `runtime_lifecycle`

Purpose: prove start/stop/restart/status lifecycle behavior without trusting
stale pid files or broad process kill commands.

| Layer | Required gates |
| --- | --- |
| Owner | `runtime.lifecycle.pid_cache`, `runtime.lifecycle.stop_intent`, or `runtime.lifecycle.instance_registry`. |
| Mainline | `runtime.lifecycle.mainline` edges `rtl-01`, `rtl-02`, `rtl-03`, `rtl-04`, `rtl-07`, `rtl-08`, `rtl-09`, `rtl-10`, `rtl-11`, `rtl-12` as applicable. |
| Whitebox | `npm run verify:runtime-lifecycle-pid-rebase`; focused Jest for touched owner: `tests/utils/server-runtime-pid.spec.ts`, `tests/utils/daemon-stop-intent.spec.ts`, `tests/utils/runtime-instance-registry.spec.ts`, `tests/cli/start-command.spec.ts`, `tests/cli/stop-command.spec.ts`, `tests/cli/restart-command.spec.ts`. |
| Blackbox | Managed `rcc start --snap`, `rcc stop --port <port>`, or `rcc restart --port <port>` only with explicit human approval; then `/health`, expected port-group behavior, and process lifecycle log evidence. Explicit `rcc start --restart --port <port>` is a guard/fail-fast test when a runtime already exists, not a stop/restart blackbox. |
| Quality | No `pkill`, `killall`, `kill $(...)`, `xargs kill`, broad checkout/reset, stale pid truth, root `server-*.pid`, root `daemon-stop-*.json`, or top-level host reuse for explicit multi-port targets. |
| Evidence | run log must include command, target port(s), expected and observed port group, health result, relevant `~/.rcc/logs/process-lifecycle.jsonl` summary, and whether pids were only hints. |
| Escalate | Any focused lifecycle Jest failure, port conflict, unmanaged listener, group expansion ambiguity, host/probe mismatch, or no checker. |

### `verification_gate_mapping`

Purpose: keep architecture maps and generated review surfaces aligned before a
loop action changes runtime behavior.

| Layer | Required gates |
| --- | --- |
| Owner | `docs/architecture/function-map.yml`, `docs/architecture/mainline-call-map.yml`, `docs/architecture/verification-map.yml`, generated wiki/manifest only when source map changed. |
| Mainline | Affected chain must be queryable by `chain_id` and edge id; `runtime.lifecycle.mainline` is required for lifecycle changes. |
| Whitebox | `npm run verify:function-map-compile-gate`; `npm run verify:architecture-mainline-call-map`; relevant wiki/manifest sync gate if maps changed. |
| Blackbox | Not required for documentation-only map repair. Required when the mapped change affects start/stop/restart/install/live runtime behavior. |
| Quality | No invented symbols, no `binding pending` claimed as anchored, no ownerless required gate, no generated artifact drift, no duplicate owner for the same lifecycle truth. |
| Evidence | run log must include `feature_id`, owner module, allowed path, forbidden path, mainline edge id, and exact required gates. |
| Escalate | Owner cannot be found in one or two map queries, required gates are absent, or generated review surfaces are stale. |

### `webui_config_editor`

Purpose: rebuild the WebUI as an online `config.toml` editor without moving
provider, routing, or forwarder truth out of their existing owners.

| Layer | Required gates |
| --- | --- |
| Owner | New WebUI surface owner must be mapped before implementation; config reads/writes must stay under `config.user_config_codec`, `config.user_config_write_surface`, `config.provider_config_codec`, and `config.provider_config_write_surface`; `fwd.*` selection truth remains `vr.provider_forwarder_runtime`. |
| Mainline | Documentation-only L2 may use `not_applicable`; implementation L2 must bind the WebUI API edge to shared config writer/codec owners and must not claim Rust VR selection edges as WebUI-owned. |
| Whitebox | `npm run test:webui`; `npm run verify:config-ssot`; `npm run verify:function-map-compile-gate`; focused tests for any touched WebUI/admin API/config writer file. |
| Blackbox | Browser/API smoke against a test config: read existing providers, render one provider card per provider, backup/restore one provider, render one tab per configured port, create a new port tab, select providers from existing provider IDs, edit a `fwd.*` aggregation with `priority`/`weighted`/`roundrobin`, validate/save config, reload and prove semantic equivalence. |
| Quality | No provider secret exposure, no raw TOML stringify outside shared writer, no WebUI-owned routing/forwarder selection policy, no legacy stats/control/restart surface retained unless explicitly re-approved, no tests that keep removed WebUI functions as required behavior. |
| Evidence | run log must include WebUI feature id, owner files, config writer/codec owners, `fwd` owner, old WebUI functions removed or intentionally retained, whitebox gates, blackbox smoke target, and residual risks. |
| Escalate | Any target owner file has unrelated dirty edits, feature map/mainline/verification rows are missing, blackbox config save cannot run safely, provider backup/restore semantics are ambiguous, or implementation would touch secrets/live production config. |

### `worker_collision`

Purpose: protect multi-worker worktrees while lifecycle/release fixes are in
progress.

| Layer | Required gates |
| --- | --- |
| Owner | No runtime owner unless the collision blocks a specific matrix row. |
| Mainline | Not applicable unless the collision changes runtime lifecycle files. |
| Whitebox | `git status --short --branch`; `git diff --name-only`; focused diff review for target files only. |
| Blackbox | Not required unless the collision involved installed runtime or live process changes. |
| Quality | Never reset, checkout, broad restore, broad delete, or stage unrelated files. L2 may stage only files in the approved owner scope. |
| Evidence | run log must list target files, unrelated dirty files left untouched, staged files, and commit hash if a commit was created. |
| Escalate | Target files contain unrelated edits, ownership is unclear, or preserving another worker's change makes the fix impossible. |

## L2 Run Log Required Fields

Each L2 JSONL entry in `loop-run-log.md` must include enough text in existing
fields to reconstruct:

- `watchlist_id`
- `item_id`
- `owner_feature_id`
- `mainline_edge` or `not_applicable`
- `owner_path`
- `whitebox_gates`
- `blackbox_gates`
- `checker`
- `evidence_paths`
- `residual_risk`

If these fields are missing, the entry can record `outcome: "fix-proposed"` but
must not be treated as approved.

## Completion Rule

L2 is complete only when:

1. The approved owner-scoped diff is committed or explicitly left uncommitted by
   Jason.
2. Required whitebox gates pass.
3. Required blackbox/live gates pass or are explicitly marked unavailable with
   escalation.
4. The checker records approval evidence.
5. `loop-run-log.md` has one JSONL entry with the required fields above.
