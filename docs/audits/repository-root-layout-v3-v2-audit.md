# Repository Root Layout Audit: V3/V2 and Generated State

Date: 2026-08-04
Scope: repository root layout, V3/V2 ownership, memory documents, generated artifacts, and protocol samples.

## Executive decision

The repository must remain a multi-root repository. Moving every source directory into `v3/` would violate current ownership and build boundaries. `v3/` owns the V3 Rust workspace and protocol semantics; `sharedmodule/` owns shared Rust/NAPI resources; `src/` remains the Node/TS server and CLI shell until each module has an owner-backed retirement decision.

`memory/` is process memory, not canonical product documentation. `docs/` is reserved for reviewed design, architecture, audit, goal, and verification documents. `artifacts/` is generated packaging output, not source code.

## Root classification

| Root | Classification | Decision |
| --- | --- | --- |
| `v3/` | V3 Rust workspace and runtime semantics | Keep as V3 source root |
| `sharedmodule/` | Shared Rust/NAPI/core resources consumed by V3 and the Node shell | Keep outside `v3/`; do not duplicate |
| `src/` | Node/TS server, CLI, adapters, IO, and compatibility shell | Keep until per-module owner audit proves retirement |
| `scripts/` | Build, install, verification, generation, replay, and maintenance tools | Keep as tooling root |
| `tests/` | Unit, integration, architecture, and red-fixture tests | Keep as test root; classify by owner |
| `webui/` | Retired V2 admin/config editor | Remove from source and build |
| `config/` | Configuration authoring, schema, and module declarations | Keep as configuration root |
| `configsamples/` | Retired V2 init/config examples | Remove from source and build |
| `samples/` | Retired V2 mock-provider recordings and golden fixtures | Remove from source and build |
| `docs/` | Canonical human-readable architecture and design | Keep as formal documentation root |
| `deprecated/v2/` | Retired V2 archive | Keep read-only; no runtime imports |
| `artifacts/` | Generated package/build output | Keep directory policy, remove stale outputs |
| `dist/` | Build output | Generated; never source |
| `node_modules/` | Dependency installation | Generated; never source |
| `.agent-collab/`, `.agent-state/` | Collaboration and local agent state | Operational state; never move into source or docs |
| `MEMORY.md`, `memory/`, `note.md`, `CACHE.md` | Long-term facts, process memory, workbench, and short cache | Keep lifecycle-separated; do not merge into `docs/` |

## Evidence

### V3 and shared runtime boundaries

- `package.json` production entry is `dist/index.js`; the CLI points to `dist/bin/rccv3` and development still starts from `src/index.ts`.
- `v3/Cargo.toml` is the V3 Rust workspace.
- `scripts/pack-mode.mjs`, `scripts/install-global.sh`, NAPI helpers, and architecture gates consume `sharedmodule/llmswitch-core` directly.
- Therefore `src/` and `sharedmodule/` are not removable or movable by directory name alone.

### Memory boundary

`docs/agent-routing/40-task-memory-routing.md` defines `MEMORY.md`, `memory/`, `note.md`, and `CACHE.md` as separate lifecycles. Process memory may be promoted into formal docs only after review; moving the whole directory would make historical/debug notes look like active contracts.

### Packaging artifacts

`artifacts/pack/` was approved by `docs/goals/root-generated-artifacts-governance-plan.md` and is written by the pack/install scripts. The five local packages `routecodex-0.90.3972.tgz` through `routecodex-0.90.3979.tgz` were ignored, untracked, and older than the current package version `0.90.4114`. They were removed as reproducible stale output on 2026-08-04. `artifacts/` is now empty and still passes the filesystem governance gate.

### Sample boundary and current failure

The repository `samples/` tree was consumed only by retired TS mock/replay tooling. V3 live evidence remains under `~/.rcc/codex-samples` and is not part of this repository deletion.

The first sample registry audit found exactly three entries because the request body `reqId` did not match the registry entry:


Jason confirmed these three providers are retired. Their registry entries and sample directories were physically removed on 2026-08-04. The stale test assertion that required the retired `tab.key1.gpt-5.1` sample was removed as well.

The former `samples/mock-provider/openai-responses/unknown` subtree was retired with the V2 mock provider; no V3 source imports it.

## Required actions

### Completed

- Remove stale ignored package tarballs under `artifacts/pack/`.
- Verify `node scripts/architecture/verify-repository-filesystem-governance.mjs` passes.
- Preserve the unrelated dirty file `docs/architecture/manifests/error.provider_action_gate.mainline.yml`.

### Immediate next actions

1. Keep the filesystem gate red-locked against reintroducing `samples/`, `configsamples/`, or `webui/`.
2. Treat `~/.rcc/codex-samples` as the separate V3 runtime evidence surface.

### V2/V3 layout work

1. Audit `src/` by function-map owner and import graph; migrate only proven retired V2 modules to `deprecated/v2/`.
2. Audit `sharedmodule/` crate-by-crate; do not copy shared crates into `v3/`.
3. Classify `scripts/` and `tests/` by active V3, shared runtime, compatibility, and retired V2 ownership.
4. Promote durable conclusions from `memory/` into `MEMORY.md` or `docs/`; delete only proven duplicate/dead notes.
5. Keep generated roots (`artifacts/`, `dist/`, `node_modules/`, local state) outside source and documentation roots, with CI filesystem gates.

## Target layout

```text
v3/                 V3 Rust workspace and semantic runtime
sharedmodule/       shared Rust/NAPI/core resources
src/                Node/TS shell, CLI, adapters, and IO
scripts/            build/install/gate/replay tooling
tests/              tests and architecture gates
config/             configuration authoring and schemas
configsamples/      retired; absent
samples/            retired; absent
docs/               reviewed canonical documentation
deprecated/v2/      retired V2 archive
artifacts/pack/     temporary packaging output, ignored
dist/               generated build output, ignored
```

No whole-directory move into `v3/` is approved by this audit. All future moves or deletions require a unique owner, consumer check, and post-change gate evidence.
