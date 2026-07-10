# llmswitch External Reference Rust Closeout Plan

## Goal

Continue from external reference contraction: remove active source/test/script/doc references to remaining llmswitch-core TypeScript runtime shells, close each semantic owner to Rust/NAPI truth, then physically delete stale shells only after dependency proof and gates pass.

This plan is an execution document for the next `/goal`. It is not a new feature design and does not authorize broad rewrites, provider changes, or fallback paths.

## Acceptance Criteria

- Remaining llmswitch-core production TypeScript shells have a current `git ls-files` based reference inventory.
- Each candidate is classified as `delete now`, `reference contraction required`, `Rust owner missing`, or `allowed thin IO/native loader`.
- External imports from root tests, sharedmodule tests, scripts, docs, public barrels, ambient declarations, and dist-required lists are contracted before deleting implementation files.
- Runtime semantics for Hub Pipeline, Virtual Router, Chat Process, servertool, continuation, stopless, and error policy remain Rust-owned.
- No JS/TS semantic backfill is added. Test-only helpers are allowed only when they call direct Rust/NAPI truth and do not become production runtime owners.
- Dead shells, stale exports, ambient declarations, and docs/map references are physically deleted or updated in the same slice after dependency proof.
- Function map, mainline call map, verification map, wiki/manifest, rustification baseline, `MEMORY.md`, and project lessons are updated when a durable owner or deletion fact changes.
- Focused gates, architecture gates, rustification audits, and build pass before claiming the slice closed.
- Runtime-impacting slices are globally installed and live-verified before any runtime closeout claim.

## Scope

In scope:

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts` and other remaining llmswitch-core TypeScript shells identified by the strict shell reference audit.
- External consumers that keep those shells alive: root tests, sharedmodule tests, scripts, package exports, ambient declarations, docs, wiki, manifests, and architecture maps.
- Rust/NAPI owners under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` and `servertool-core/`.
- Gate updates that prevent old TypeScript shell references from returning.

Out of scope:

- Provider pool/config changes.
- WebUI or unrelated runtime lifecycle work unless the audit proves it is an active blocker.
- Reintroducing deleted `.js` or TypeScript production wrappers.
- Broad cleanup of unrelated dirty worktree files.
- Fallback, compatibility dual paths, silent swallow, or provider-specific patches outside provider runtime.

## Current Starting Point

Use the current repository state as truth, not memory or generated artifacts. The expected starting facts from the prior slice are:

- Latest committed closeout removed `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts` and its package/ambient exports.
- `native-virtual-router-runtime.ts` still exists and is not directly deletable until active references and map edges are contracted.
- Current strict audit baseline should be approximately:
  - `prodTsShellCount=4`
  - remaining production shells include `src/index.ts`, `native-router-hotpath-loader.ts`, `native-router-hotpath.ts`, and `native-virtual-router-runtime.ts`
  - `native-virtual-router-runtime.ts` should have no production importers, but still has test/script/doc/map references.
- Current worktree may contain unrelated dirty files from other workers. Preserve them and stage only this goal's files.

## Design Rules

- Rust is the semantic source of truth.
- TypeScript may only be Node IO, native loader, direct binding shell, generated/type boundary, diagnostic emission, or test-only helper.
- Root and sharedmodule tests must not keep production TypeScript shells alive just for convenience; move them to direct-native test helpers or public runtime boundaries.
- A test-only helper must call the real `.node`/NAPI export and must not duplicate route selection, metadata, stopless, continuation, hit-log, or error-policy semantics.
- Deletion requires proof from source-controlled files: start with `git ls-files`; exclude `dist`, `target`, `coverage`, `.mempalace`, local indexes, and generated artifacts from current-state evidence.
- Do not delete a shell while function map, mainline call map, verification map, wiki, manifest, package exports, required dist outputs, or source tests still identify it as active owner/caller/callee.
- If a semantic gap is found, add Rust owner/export/tests first, then shrink TypeScript references.
- No fallback, no shadow JS implementation, no "temporary" production wrapper.

## Technical Plan

1. Establish current inventory.
   - Run strict shell reference audit and rustification audit with JSON output.
   - Enumerate references with `git ls-files` and source/doc allowlists.
   - Record active references by category: production import, package export, ambient declaration, test import, script import, map/wiki/manifest/doc reference.

2. Lock owner and gates before edits.
   - For each candidate feature, read `docs/architecture/function-map.yml`, `docs/architecture/mainline-call-map.yml`, `docs/architecture/verification-map.yml`, and the matching wiki/manifest.
   - If owner or mainline edge still names a TypeScript shell, treat map contraction as part of the slice.
   - If owner cannot be found in 1-2 queries, first add or correct the map/contract instead of editing implementation code.

3. Contract external references first.
   - Move root tests off production shell imports to test-only direct-native helpers or public server/runtime boundaries.
   - Move sharedmodule tests off `src/native/.../*.js` production shell imports when a direct Rust/NAPI helper exists.
   - Move scripts off dist shell imports to direct native exports or approved host/native commands.
   - Remove public package exports and ambient declarations only after active consumers are gone.
   - Update docs/wiki/manifests that incorrectly name a TypeScript shell as semantic owner.

4. Close Rust gaps.
   - If contraction reveals missing NAPI exports, implement the missing semantic owner in Rust.
   - Add positive and negative Rust tests for each owner.
   - Add focused Jest/contract tests only at the host boundary; do not recreate business semantics in TypeScript.
   - Rebuild native artifacts before running blackbox tests that consume `.node`.

5. Delete stale shells.
   - Delete the TypeScript shell only after reference inventory and maps prove no active consumer.
   - Remove package exports, ambient modules, required dist outputs, stale docs, and old baselines in the same slice.
   - Add or update residue gates so the deleted path, old export, and old import strings cannot return.

6. Verify and commit by slice.
   - Run focused tests for changed consumers and Rust owners.
   - Run strict shell reference audit, rustification audit, function map gate, mainline gate, manifest/wiki sync gates, and build.
   - For runtime-impacting changes, pack/install globally, restart the managed port with `routecodex restart --port <port>`, verify `/health.version`, and replay the same-entry sample.
   - Commit only scoped files. Do not stage unrelated dirty files.

## File And Evidence Checklist

Always check these before deleting or claiming closeout:

- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/mainline-call-graph.md`
- `docs/architecture/wiki/virtual-router-ownership-map.md`
- `docs/architecture/manifests/*.yml`
- `docs/loops/rustification/minimal-ts-surface.json`
- `scripts/ci/llmswitch-ts-shell-reference-audit.mjs`
- `scripts/ci/llmswitch-rustification-audit.mjs`
- `sharedmodule/llmswitch-core/package.json`
- `src/types/*.d.ts`
- `scripts/lib/build-core-utils.mjs`
- root `tests/`, `sharedmodule/llmswitch-core/tests/`, and `scripts/`

## Verification Matrix

Minimum source/reference gates:

```bash
node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json
npm run verify:llmswitch-rustification-audit -- --json
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-mainline-manifest-sync
npm run verify:architecture-mainline-mermaid-sync
npm run verify:vr-no-ts-runtime
```

Minimum build gates:

```bash
npm run build:native-hotpath
npm run verify:llmswitch-core-tsc
npm run build:base
```

Focused tests depend on the slice. For the current Virtual Router shell contraction wave, include the affected root/sharedmodule/servertool Virtual Router tests, hit-log tests, and native-required export tests. If stopless/servertool/continuation is touched, also run the feature-specific gates from `docs/architecture/verification-map.yml`.

Runtime-impacting closeout requires:

```bash
npm run pack:rcc
npm run verify:rcc-release-install
routecodex restart --port <managed-port>
curl -sS http://127.0.0.1:<managed-port>/health
```

Then replay the same endpoint/sample that proves the installed runtime consumes the new Rust owner. Without this, report only source/gate closeout, not runtime closeout.

## Risks

- `native-virtual-router-runtime.ts` is currently still referenced by maps and tests, so deleting it before reference contraction would break active consumers and lie about owner state.
- Test-only helpers can become accidental semantic mirrors. Keep them direct-native and narrow.
- Passing a rustification audit with allowed shells is not proof that Rust closeout is complete.
- Generated `dist` or local indexes can hide stale source references. Do not use them as current-state proof.
- Dirty worktree files may belong to other workers. Preserve them and use scoped staging.

## Definition Of Done

- The current slice strictly reduces active references or deletes a proven-dead shell.
- Every changed semantic owner points to Rust/NAPI in function map, mainline map, verification map, wiki, and manifest.
- All active tests/scripts/docs/package/type references to deleted paths are gone.
- Residue gates fail on reintroducing deleted paths or old production shell imports.
- Focused tests, architecture gates, rustification audits, and build pass.
- Runtime-impacting changes are globally installed and live-replayed.
- `note.md`, `MEMORY.md`, and local lessons are updated only with durable, verified facts.
