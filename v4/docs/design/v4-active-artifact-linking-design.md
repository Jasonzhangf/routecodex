# V4 Active-Only Artifact Linking — Fix/Design Report

Design ID: `V4-ACTIVE-LINK-001`
Status: `approved` — Jason approved the design via 继续执行 on 2026-08-15; formal implementation complete.
Date: 2026-08-15
Plan: `docs/goals/v4-active-artifact-linking-plan.md`
Goal: Active-only artifact linking Phase 1, BaseNode first consumer (`routecodex-v4-edge`).

## 1. Facts baseline (evidence table)

Source of truth: `v4/.appsdk/project.json`, `v4/.appsdk/maps/*.json`, freeze/promotion/review/evidence records, `v4/active/lib/*/artifact.json`, workspace Cargo manifests.

| module | stage | source owner | Active version | artifact_hash | public_api_hash | source commit | deps (artifact hashes) | current Cargo path edges | regression gate |
|---|---|---|---|---|---|---|---|---|---|
| routecodex-v4-governance | source_implemented | routecodex-v4-governance | none | - | - | - | - | none | v4-governance-regression |
| routecodex-v4-base-node | frozen | routecodex-v4-base-node | active-v1 | 036daf4575cf…e4c4 | 95f9248e05…f490f8 | fac43e278 | - | consumed by edge/control/error/config | v4_base_node_l0_regression (12) |
| routecodex-v4-edge | frozen | routecodex-v4-edge | active-v1 | 1f800dc905…3af | ecb7cdb676…4269 | 8eac65195 | base-node 036daf45… | edge -> base-node (Cargo path) | v4_edge_l1_regression (11) |
| routecodex-v4-control | frozen | routecodex-v4-control | active-v1 | fc1510781b…1cc4 | f9d2b698a3…e2ee3 | 0c7be8d5c | base-node 036daf45… | control -> base-node (Cargo path) | v4_control_l2_regression (15) |
| routecodex-v4-error | frozen | routecodex-v4-error | active-v2 | 23e7b9950e…5bb1 | 161e6ca746…eac6f | dc52f4772 | base-node 036daf45… | error -> base-node (Cargo path) | v4_error_l2_regression (23) |
| routecodex-v4-config | source_implemented | routecodex-v4-config | none | - | - | - | base-node, edge | config -> base-node, config -> edge (Cargo path) | v4_config_l2_regression (15) |

Cargo consumer edges (from `v4/.appsdk/maps/mainline-call-map.json`, all `status: active`):

| caller | callee | manifest/symbol edge | owner |
|---|---|---|---|
| routecodex-v4-edge | routecodex-v4-base-node | `crates/routecodex-v4-edge/Cargo.toml` (path) + symbols NodeIdentity, NodeRef::from_identity | cargo::dependency / routecodex-v4-edge::validate_edge |
| routecodex-v4-control | routecodex-v4-base-node | `crates/routecodex-v4-control/Cargo.toml` (path) + symbol Scope | cargo::dependency / routecodex-v4-control::metadata_center |
| routecodex-v4-error | routecodex-v4-base-node | `crates/routecodex-v4-error/Cargo.toml` (path) + error-chain symbols | cargo::dependency / routecodex-v4-error::error_chain |
| routecodex-v4-config | routecodex-v4-base-node / routecodex-v4-edge | `crates/routecodex-v4-config/Cargo.toml` (path) + config_node / validate_edges | cargo::dependency / routecodex-v4-config::config_node |

## 2. Unique owner determination

- Active artifact producer/verifier (existing, unchanged): `appsdk` CLI — `appsdk::compiler` (compile-module), `appsdk::publisher` (publish-active), `appsdk::freezer`, `appsdk::verifier`. Freeze is the only producer of publishable Active artifacts.
- V4 build/link owner (new, single): `routecodex-v4-build-link` — a new V4-owned, mutable Rust build-tool crate (`v4/crates/routecodex-v4-build-link`). It is the only resolver and the only link-surface owner. Rationale: implementing the resolver inside the global appsdk binary would require a new appsdk release, which is explicitly out of scope ("重新设计 Global AppSDK release…"). A V4-owned tool crate is in scope ("typed resolver、build/link integration") and is itself a mutable, source-owned module until its own freeze.
- Consumers, Cargo manifests, build scripts, tests and CI must not implement equivalent discovery; all Active selection/validation goes through `routecodex-v4-build-link`.
- New resource/function/mainline/gate registrations (阶段 C): `v4.build.link_surface` resource (owner `routecodex-v4-build-link`), functions `resolve_active_artifact` / `emit_link_flags`, mainline edges `consumer -> active_resolver -> active artifact`, verification gates `v4_active_resolution_positive`, `v4_frozen_source_edge_forbidden`.

## 3. Typed contracts (proposal)

```text
ActiveArtifactIdentity {
  module_id: string
  active_version: string            // e.g. active-v1
  target_triple: string             // e.g. aarch64-apple-darwin
  artifact_hash: sha256             // artifact.json artifact_hash (whole artifact dir)
  public_api_hash: sha256           // recorded contract field (see gap note)
  source_commit: string             // freeze-record source_commit_or_tag
  dependency_closure: [ActiveArtifactDependency]
}

ActiveArtifactDependency {
  module_id: string
  active_version: string
  target_triple: string
  artifact_hash: sha256
  public_api_hash: sha256
  source_commit: string
}

ActiveArtifactManifest {            // compiled deterministic index
  schema_version: int
  project_id: string
  built_at_commit: string
  rustc_version: string
  host_triple: string
  entries: [ActiveArtifactIdentity]
  manifest_hash: sha256             // canonical serialization
}

ActiveArtifactResolution {
  identity: ActiveArtifactIdentity
  manifest_hash: sha256
  artifact_root: path               // inside active/lib/<module>/<version>
  rlib_paths: [path]
  dependency_resolutions: [ActiveArtifactResolution]  // recursive closure
  link_flags: [string]              // --extern <crate>=<rlib> per resolved dep
}

Error chain (typed, fail-fast, no fallback):
  ActiveLinkErr01IdentityMissing
  ActiveLinkErr02ManifestInvalid
  ActiveLinkErr03ArtifactMissing
  ActiveLinkErr04ArtifactHashMismatch
  ActiveLinkErr05PublicApiHashMismatch
  ActiveLinkErr06TargetMismatch
  ActiveLinkErr07DependencyClosureMismatch
  ActiveLinkErr08SourcePathForbidden
  ActiveLinkErr09SymlinkOrPathEscape
  ActiveLinkErr10StaleOrMissingRecord
  ActiveLinkErr11ActiveWriteForbidden
  ActiveLinkErr12LinkFailed
  ActiveLinkErr13RustcMismatch
```

## 4. Storage layout

- Immutable Active (existing, unchanged): `v4/active/lib/<module>/<active_version>/{artifact.json, lib/<artifact>}` plus `current.json`.
- Compiled deterministic index (new, resolver-generated, gitignored): `v4/build-control/active-index.json`. Not under `.appsdk/**` (protected), `generated/**` (compiler output only), `protected/**`, or `playground/**`. Derived solely from immutable Active artifacts + freeze/promotion/review records + `rustc -vV`; regenerated by `routecodex-v4-build-link`; gate re-derives and compares manifest_hash.
- Consumer path: no source directories under consumer path; no `.rs` wrappers; the link surface is resolver-emitted `rustc --extern` flags only.
- Target triple binding: existing frozen artifacts have no `target_triple` field; the index binds `rustc -vV` host triple deterministically for existing versions and records that future freezes must store target explicitly.

## 5. Experiment evidence (阶段 B, Playground only)

`v4/playground/experiments/active-link-base-node-v1/evidence.md`

- Positive: `rustc --extern routecodex_v4_base_node=<active rlib>` compiled a consumer and its black-box test against the public API without reading frozen source (`POSITIVE_LIB_OK`, 1 test passed).
- Negative: Cargo path dependency on the rlib-only Active directory fails (`failed to read …/active-v1/Cargo.toml`). rlib is not a Cargo-native distribution surface.
- Conclusion: the resolver/link integration must be a single resolver-owned `rustc --extern` link surface (e.g. `routecodex-v4-build-link`), not per-manifest Cargo path rewrites.
- Gaps recorded: `target_triple` absent in artifact.json; `public_api_hash` is artifact-entry derived, not an API-surface extraction.

## 6. BaseNode first consumer migration path (routecodex-v4-edge)

1. Register `routecodex-v4-build-link` owner + maps + gates (阶段 C start).
2. Implement index generation + typed resolver + link flag emitter in the single owner.
3. Red tests first (see failure matrix), then remove `routecodex-v4-base-node = { path = … }` from `crates/routecodex-v4-edge/Cargo.toml`.
4. Build/test edge exclusively through the resolver-emitted link surface.
5. Verify edge artifact byte-identity: if the rebuilt edge rlib is byte-identical to `active-v1` (same rustc flags/env), keep the frozen artifact and record hash evidence; if bytes differ, a deliberate re-freeze cycle (evidence -> review -> promotion -> freeze) is required with Jason-approved reason. BaseNode artifact is never rebuilt or modified.
6. Afterwards migrate control/error, then config, one dependency layer at a time with separate evidence/review checkpoints.

## 7. Validation order (before compile/link)

identity (module_id + active_version) -> manifest valid + manifest_hash -> artifact exists -> artifact hash -> public API hash -> source commit vs freeze record -> target triple -> dependency closure (recursive) -> symlink/path-escape check -> stale/missing record check -> Active write-protection check -> emit link flags.

## 8. Failure matrix (red tests, pre-implementation)

| condition | expected fail-fast |
|---|---|
| Cargo path edge to frozen source | ActiveLinkErr08SourcePathForbidden (architecture gate + resolver rejects) |
| missing Active artifact | ActiveLinkErr03ArtifactMissing |
| artifact hash mismatch | ActiveLinkErr04ArtifactHashMismatch |
| public API hash mismatch | ActiveLinkErr05PublicApiHashMismatch |
| target triple/platform mismatch | ActiveLinkErr06TargetMismatch |
| dependency artifact hash/version swap | ActiveLinkErr07DependencyClosureMismatch |
| symlink / path traversal | ActiveLinkErr09SymlinkOrPathEscape |
| stale/absent freeze/review/evidence record | ActiveLinkErr10StaleOrMissingRecord |
| consumer reads Playground/Protected/Generated | ActiveLinkErr08SourcePathForbidden |
| write/symlink attempt on Active or manifest | ActiveLinkErr11ActiveWriteForbidden |
| producer rustc release recorded at freeze differs from current rustc | ActiveLinkErr13RustcMismatch |

## 9. Positive/negative verification plan

- Positive: `routecodex-v4-build-link` resolves exact identity; edge builds and `l1_edge` tests pass from Active surface only; public API black-box suite passes.
- Negative: every failure-matrix row above is a red test first; architecture gate detects unregistered/duplicate resolver edges; old Cargo path edge cannot build.
- Project: `cargo fmt --all -- --check`, `cargo test --workspace`, `cargo build --release --workspace` (via resolver entrypoint for frozen consumers), `appsdk verify v4`, all module regression commands, Active/Protected/record graph hash audit.
- Runtime: this phase is build-governance only; no V3/V4 runtime code is touched, so no global install/restart/health applies; evidence is the actual build consumer path (edge build/test through Active surface). This will be restated at delivery with the exact commands.

## 10. Risks and open decisions

1. rlib metadata compatibility across rustc versions is not a stable distribution contract; the resolver verifies `rustc -vV` (host triple + release) and fails on recorded producer mismatch (no auto-rebuild). Existing frozen artifacts predate a producer `rustc_version` record, so they stay bound by artifact hash + host triple; future freezes must record `rustc_version` in the freeze record, after which the resolver enforces equality fail-fast (`ActiveLinkErr13RustcMismatch`). If evidence later shows rlib is unusable as a cross-workspace link contract, stop and redesign artifact format; never fall back to source.
2. Existing frozen artifacts lack `target_triple`; Phase 1 binds host triple in the index. Future freezes must record target explicitly (appsdk api/artifact contract extension, out of Phase 1 scope unless approved).
3. `public_api_hash` is artifact-entry derived today; Phase 1 verifies the recorded contract field and records an api-extractor upgrade as a future-freeze item.
4. Edge is already frozen; migrating its build path may change its artifact bytes, requiring a deliberate re-freeze. This is an explicit approval decision.
5. Workspace gates `v4_cargo_workspace_build` and module regression commands will be amended to the resolver entrypoint; gate wiring and CI must be updated in the same change set.
6. Frozen Edge lifecycle records (`v4/.appsdk/project.json` build/regression for `routecodex-v4-edge`) stay historical: appsdk rejects compile-module for frozen modules and the frozen generated module-artifact is immutable, so rewriting them would require a re-freeze. The active Edge regression gate is the resolver entrypoint (`v4_edge_l1_regression`, CI `test-consumer`); the frozen record is deliberately not touched.

## 11. Explicitly not done (no fallback)

- No source fallback, auto-rebuild, dual resolver, dual link path, compatibility shim, re-export wrapper crates, or global RUSTFLAGS hack.
- No modification to Global AppSDK release, Bundle, sdk.lock, or admission gate.
- No modification to V3 runtime/provider/pipeline/payload semantics; no Protected/Generated/Playground consumption; no Active writes.
- No re-freeze without Jason-approved reason and a full lifecycle cycle.

## 12. Stop condition

Design ID `V4-ACTIVE-LINK-001` is approved and Phase 1 implementation (resolver + edge first consumer + gate/CI amendment) is complete and verified. The edge re-freeze decision in §6.5 remains open: the resolver-rebuilt edge rlib (`sha256:35a4070e…`) differs from the frozen Active artifact (`sha256:f2b0118c…`); no re-freeze may happen without Jason's explicit approval and a full evidence -> review -> promotion -> freeze cycle. MCP review (`oauth -> cc -> tcm`) and commit remain pending that review.

## 13. MCP review record (2026-08-15, oauth profile, scoped worktree)

Five review attempts, all FAIL on one remaining P1 after fixes:

1. `v4-active-link-phase1-oauth` — FAIL: review-scope copy error (cp basename collision: edge Cargo.toml overwrote v4/Cargo.toml). Real files were correct; scope fixed.
2. `v4-active-link-phase1-oauth-2` — FAIL: (a) frozen Edge lifecycle records still point at the removed Cargo package; (b) active-index gate not runnable on clean checkout. Fixes: extended hermetic fixture to all frozen modules (base/edge/control/error), CI restores actives from fixture and runs index gate; frozen-record issue documented (§10.6) but reviewer kept it as P1.
3. `v4-active-link-phase1-oauth-3` — FAIL: (a) no producer rustc check → added `ActiveLinkErr13RustcMismatch` + freeze-record `rustc_version` enforcement when recorded; (b) gate scanned only root/config manifests → gate now enumerates all `v4/**/Cargo.toml` and requires registry coverage of path edges.
4. `v4-active-link-phase1-oauth-4` — FAIL: `assert_outside_active` bypass for non-existent targets under symlinked prefixes → canonicalize deepest existing ancestor; red test added; `--out active/lib/escape-test.rlib` now fails `ActiveLinkErr11`.
5. `v4-active-link-phase1-oauth-5` — FAIL (remaining P1): `v4/.appsdk/project.json` frozen Edge build/regression commands (`cargo build -p routecodex-v4-edge`, `cargo test -p routecodex-v4-edge`) cannot resolve the removed package. appsdk refuses `compile-module` for frozen modules, so the frozen generated module-artifact (which `module_artifact_matches_project` compares for `build`) cannot be regenerated without a re-freeze cycle. Two options require Jason: (A) approve the edge re-freeze (artifact bytes already differ) and migrate the frozen lifecycle records to resolver commands through the legitimate lifecycle; (B) keep the historical frozen records and accept the resolver gates as the active truth with the frozen record documented as historical.
