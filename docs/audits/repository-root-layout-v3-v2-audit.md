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
| `webui/` | Independent frontend | Keep outside V3 runtime |
| `config/` | Configuration authoring, schema, and module declarations | Keep as configuration root |
| `configsamples/` | Configuration examples and fixtures | Keep; review secrets and consumers |
| `samples/` | Mock-provider recordings, golden fixtures, and replay inputs | Keep; enforce sample contract and lifecycle |
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

`samples/mock-provider` is consumed by install scripts, mock-provider replay scripts, provider compatibility tests, and golden-cycle tests. It cannot be moved into `v3/` or deleted as generic clutter.

The current sample registry audit fails for exactly three entries because the request body `reqId` does not match the registry entry:

- `openai-responses/iflow.2-173.glm-4.7/.../001`
- `openai-responses/crs.key1.gpt-5.1/.../004`
- `openai-responses/tab.key1.gpt-5.1/.../001`

The largest subtree is `samples/mock-provider/openai-responses/unknown`, about 861 MiB and 3,906 files. It is tracked and therefore requires a sample-level retention decision, not filesystem deletion by size alone.

## Required actions

### Completed

- Remove stale ignored package tarballs under `artifacts/pack/`.
- Verify `node scripts/architecture/verify-repository-filesystem-governance.mjs` passes.
- Preserve the unrelated dirty file `docs/architecture/manifests/error.provider_action_gate.mainline.yml`.

### Immediate next actions

1. Repair or explicitly retire the three invalid mock-provider registry entries. Do not rewrite request semantics; fix only the unique sample/registry owner after confirming the intended `reqId`.
2. Audit the 861 MiB `openai-responses/unknown` subtree for duplicate, replay-required, and accidental capture samples. Retain only entries required by registered tests or golden coverage.
3. Run mock-provider regression and compatibility tests after sample changes.

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
configsamples/      configuration examples
samples/            registered protocol and provider fixtures
docs/               reviewed canonical documentation
deprecated/v2/      retired V2 archive
artifacts/pack/     temporary packaging output, ignored
dist/               generated build output, ignored
```

No whole-directory move into `v3/` is approved by this audit. All future moves or deletions require a unique owner, consumer check, and post-change gate evidence.
