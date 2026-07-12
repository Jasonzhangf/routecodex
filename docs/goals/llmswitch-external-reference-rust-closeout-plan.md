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

## 2026-07-11 Current Reference Audit

- Strict shell reference audit now passes with `prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`; there are no active production or host bridge references to llmswitch-core TS runtime shells.
- The only `coreModuleSubpathRefs` reported by the strict audit are historical `note.md` references, not runtime/test/script/doc owner locks.
- `verify:llmswitch-zero-ts-closeout`, `verify:llmswitch-minimal-ts-surface -- --json`, and `verify:llmswitch-rustification-audit -- --json` all pass with zero production/non-native TS metrics.
- Architecture and build closure passed: function-map compile, mainline call-map, mainline manifest sync, deleted-path, thin-wrapper-only, VR no-TS runtime, servertool Rust-only, Responses history protocol contract, `build:native-hotpath`, sharedmodule/root TypeScript, and `build:base`.
- Runtime install evidence is consistent at `0.90.3789` across CLI entrypoints, current release package, and health checks on the managed port group.

## 2026-07-11 Leaf script host bridge dist refs contracted

- Added `scripts/helpers/responses-codec-direct-native.mjs` as a script-only direct NAPI helper for Responses request/response codec calls. It loads `router_hotpath_napi.node` directly and does not create a production TS/JS semantic owner.
- Migrated leaf scripts off host `dist/modules/llmswitch/bridge/native-exports.js` for Responses codec calls:
  - `scripts/batch-toolcall-report.mjs`
  - `scripts/outbound-regression-codex-samples.mjs`
  - `scripts/responses-sse-capture.mjs`
  - `scripts/responses-sse-replay-golden.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-tool-call-id-style-route-wins.mjs`
- Extended that same helper with direct Rust/NAPI wrappers for `runResponsesOpenaiRequestCodecJson` and `captureReqInboundResponsesContextSnapshotJson`, then migrated the remaining Responses codec/capture leaf scripts:
  - `sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-freeform-tool-args.mjs`
- Exact source scan for touched leaf scripts now returns zero `dist/modules/llmswitch/bridge/native-exports.js` references.
- Remaining `dist/modules/llmswitch/bridge/native-exports.js` source references are docs/memory history plus release-install surface verification; no new runtime semantic owner was introduced.

## 2026-07-11 Remaining blackbox bridge refs contracted to direct native helper

- Added `scripts/helpers/llmswitch-direct-native.mjs` for script-only direct native access to:
  - `hubPipelineVirtualRouterStatusJson`
  - `executeResponsesConversationStoreOperationJson`
- Migrated the remaining active blackbox/script references away from host bridge dist runtime files:
  - `scripts/tests/provider-failure-ban-blackbox.mjs`
  - `scripts/tests/responses-continuation-provider-key-blackbox.mjs` (relay-only seed path)
  - `scripts/tests/responses-store-error-release-blackbox.mjs`
- Exact source scan now leaves `dist/modules/llmswitch/bridge/*` only in `scripts/verify-rcc-release-install.mjs`, where the import is an install-surface compatibility contract rather than a runtime/test semantic owner.
- Validation:
  - `node --check` passed for `scripts/helpers/llmswitch-direct-native.mjs` and the 3 touched blackbox scripts.
  - Exact source scan under `scripts tests sharedmodule/llmswitch-core/scripts` now reports only `scripts/verify-rcc-release-install.mjs` for `dist/modules/llmswitch/bridge/*`.
  - `node scripts/tests/provider-failure-ban-blackbox.mjs` passed after the helper was aligned to the same native registry precedence as the runtime.
  - `node scripts/tests/responses-store-error-release-blackbox.mjs` passed.
  - `RCC_CONTINUATION_SCENARIO=relay node scripts/tests/responses-continuation-provider-key-blackbox.mjs` passed, proving the touched relay branch works with the direct native helper.
  - `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json` passed.
  - `npm run verify:llmswitch-rustification-audit -- --json` passed.
  - `git diff --check` passed.
- Residual risk:
  - The full `node scripts/tests/responses-continuation-provider-key-blackbox.mjs` still fails in the untouched `direct` scenario because current runtime behavior routes the resumed continuation to `p2` instead of preserving the expected `p1` pin. This is a pre-existing runtime regression outside the relay-branch reference-contraction slice and must be fixed at the direct continuation owner before this blackbox can be fully green.

## 2026-07-12 Hub Pipeline / VR Host Bridge External Reference Audit

### Current answer

There are no remaining production TypeScript runtime modules under
`sharedmodule/llmswitch-core/src`, and the Virtual Router runtime has no
production TS surface. The remaining external references are host-side
RouteCodex bridge references under `src/modules/llmswitch`, not llmswitch-core
or VR runtime TS modules.

This is a source/doc audit. No runtime behavior changed, so this section does
not claim new global-install or live replay closure.

### Evidence

- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`
  passed with `prodTsShellCount=0`, `shellsWithProdImporters=0`,
  `shellsWithHostTextRefs=0`; the only `coreModuleSubpathRefs` are historical
  `note.md` entries.
- `node scripts/ci/llmswitch-rustification-audit.mjs --json` passed with
  `prodTsFileCount=0`, `prodTsLocTotal=0`, `nonNativeFileCount=0`,
  `nonNativeLocTotal=0`.
- `node scripts/ci/verify-llmswitch-minimal-ts-surface.mjs --json` passed with
  `entries=0`, `current non-native prod TS files=0`, and
  `explicit native-linked TS shells=0`.
- `node scripts/architecture/verify-vr-no-ts-runtime.mjs` passed with
  `VR production TS files: 0`.
- `git ls-files 'sharedmodule/llmswitch-core/src/**/*.ts' ... '*.d.ts'`
  returned no tracked TS-like files.
- `find src/modules/llmswitch -type f` currently shows `README.md` and 7
  existing concrete `bridge/*.ts` files.
- `git ls-files 'src/modules/llmswitch/**'` still tracks
  `responses-sse-bridge.ts`, but the current dirty worktree has that file as a
  pending deletion from a separate SSE closeout slice. The matrix below uses
  existing working-tree files and excludes the missing file.

### Current host bridge reference matrix

The reference scan used `git ls-files` over `src`, `tests`, `scripts`, `docs`,
and package manifests, excluded generated outputs, resolved ESM `.js` imports
back to tracked `.ts` sources, and counted direct import / dynamic import /
require / Jest mock references.

| File | LOC | External refs | src refs | test refs | Current classification |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/modules/llmswitch/bridge/native-exports.ts` | 1540 | 65 | 31 | 34 | Shrink candidate; central native binding facade, too broad for long-term external imports. |
| `src/modules/llmswitch/bridge/routing-integrations.ts` | 1120 | 55 | 22 | 33 | Shrink candidate; config codec/materialization and Hub/VR handle lifecycle are mixed in one facade. |
| `src/modules/llmswitch/bridge/runtime-integrations.ts` | 274 | 42 | 8 | 34 | Keep as host IO shell for now; async wrappers, store calls, stream materialization, runtime ingress. |
| `src/modules/llmswitch/bridge/snapshot-recorder.ts` | 577 | 16 | 2 | 14 | Keep as host observation/IO shell; not a Hub/VR semantic owner. |
| `src/modules/llmswitch/bridge/provider-response-converter-host.ts` | 838 | 13 | 1 | 12 | Keep as host stream/MetadataCenter/continuation-save IO shell for now. |
| `src/modules/llmswitch/bridge/responses-conversation-store-host.ts` | 337 | 11 | 3 | 8 | Keep as host operation shell around Rust store API for now. |
| `src/modules/llmswitch/bridge/responses-request-bridge.ts` | 878 | 9 | 1 | 8 | Shrink candidate; single handler facade still contains request-side host/context glue. |

### What is already closed

- `sharedmodule/llmswitch-core` production TS is closed at zero. Do not reopen
  root barrels, source-side native wrappers, VR runtime wrappers, or checked-in
  JS/d.ts mirrors.
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` is physically
  deleted. Response JSON dispatch now uses the handler boundary plus direct
  native calls through the narrow
  `src/modules/llmswitch/bridge/responses-client-projection-host.ts`; only
  history docs and absence gates may mention the old path.
- Production source outside `src/modules/llmswitch/bridge` no longer imports
  broad `native-exports.ts` directly. New runtime callers must add or reuse an
  owner-specific host instead of widening handler/executor imports.
- `src/modules/llmswitch/core-loader.ts` is physically deleted. Native package
  path resolution is private loader plumbing inside `native-exports.ts`; do not
  restore a standalone core-loader shell for tests or docs.
- VR runtime semantics are Rust-only. `src/modules/llmswitch/bridge` may call
  Rust/NAPI for VR status, diagnostics, route host effects, and Hub engine
  lifecycle, but must not own route selection, health, availability, retry pin,
  hit-log semantic construction, or provider policy.
- `state-integrations.ts` is not a tracked host bridge file. Active routing
  state host IO lives in `src/manager/modules/routing/native-routing-state-store.ts`,
  and request metadata session extraction imports native helpers directly.
- `responses-sse-bridge.ts` is currently a pending deletion in the dirty
  worktree. If that slice is kept, SSE transport facade ownership must stay in
  `handler-response-sse.ts` plus Rust/NAPI projection helpers, and architecture
  maps/gates that still name the old bridge file must be updated or kept only
  as negative residue assertions.

### Remaining external reference groups

1. Runtime host importers that must remain until the host boundary is split:
   server runtime setup, request executor, direct/provider response converter,
   provider runtime, config loaders/writers, routing manager, debug snapshot
   writer, and memory observer.
2. Test importers that still call bridge facades directly. These are the first
   contraction target when they only need Rust/NAPI evidence.
3. Architecture and residue tests that mention deleted `sharedmodule` paths as
   negative assertions. These are not active runtime references and should not
   be counted as current TS owner evidence.

### Closeout sequence

1. Freeze the current truth with a bridge allowlist.
   - Extend the existing shell/reference audit or add a focused host-bridge
     reference manifest that classifies each `src/modules/llmswitch` file as
     `native facade`, `config facade`, `request handler facade`, `response
     facade`, `transport facade`, `store operation shell`, or `observation IO`.
   - Gate each facade by allowed runtime importers and forbidden semantic
     patterns; do not use line count alone as a closeout signal.

2. Contract test-only external references first.
   - Move tests that only need direct NAPI proof from
     `src/modules/llmswitch/bridge/native-exports.ts` to narrow test helpers
     under `tests/sharedmodule/helpers/*direct-native.ts`.
   - Do the same for bridge facade tests that only assert Rust output, leaving
     handler/runtime integration tests on the real host boundary.
   - Expected first shrink: the 34 test refs to `native-exports.ts` and the
     high test ref counts on `routing-integrations.ts`, `runtime-integrations.ts`,
     and response/request facades.

3. Split `routing-integrations.ts` by owner before trying to delete anything.
   - Config/TOML/path/auth/provider config functions are not Hub/VR runtime
     semantics. Move or re-export them behind a config-owned native facade so
     config callers stop depending on the Hub/VR facade name.
   - Keep only Hub pipeline engine lifecycle, VR route/status/diagnostics, and
     concurrency-scope calls in the Hub/VR bridge.
   - Audit `injectVirtualRouterRuntimeMetadataLocal`: it may pass host runtime
     facts such as time/user-dir, but it must not become route truth or revive
     flat `__rt` route decisions.

4. Collapse `native-exports.ts` to a smaller native binding loader plus
   feature-specific facades.
   - Keep one fail-fast NAPI binding loader and JSON invoke primitive.
   - Move request/response/SSE/store/snapshot/error/VR helpers to their owning
     facade modules or direct test helpers.
   - Migrate local TS semantic candidates into Rust before removing them from
     the facade. Current candidates to audit first are
     `extractServertoolCliResultRouteHintFromRequestNative` and
     `mergeObservedRoutePoolChainNative`; the latter currently converts parse
     failure to `null`, so it needs explicit owner/gate review before being
     treated as acceptable optional observation.

5. Shrink `responses-request-bridge.ts`; keep `responses-response-bridge.ts`
   deleted.
   - Request bridge must stay the single `/v1/responses` handler facade, but
     pure endpoint/scope/error/stream planning helpers should be native-owned
     and direct-testable.
   - `applySystemPromptOverride` remains a request mutation behind the bridge;
     closeout requires a Rust/native replacement or an explicit owner removal,
     not a second handler-side helper.
   - `responses-response-bridge.ts` is no longer an active facade. Response
     JSON dispatch now lives in `handler-response-utils.ts` as HTTP/log/snapshot
     glue around `responses-client-projection-host.ts`. Do not restore a bridge
     facade or JS mirror to satisfy tests; update tests/scripts to target the
     handler boundary, the narrow host, or direct native helpers.

6. Keep host IO shells until a real replacement exists.
   - `provider-response-converter-host.ts`, `runtime-integrations.ts`,
     `responses-conversation-store-host.ts`, and `snapshot-recorder.ts` are
     deletion candidates only after their Node stream,
     MetadataCenter, timer/env/path/logging, and file IO responsibilities have
     an explicit replacement owner and gates.
   - Do not delete them merely to reduce TS LOC; that would move IO breakage
     elsewhere without reducing semantic duplication.

7. Delete only zero-ref leaves.
   - Use `git ls-files` based scans before deletion, update function/mainline/
     verification maps in the same slice, then add residue gates that fail if
     the old path/export/import returns.

### Required gates for each closeout slice

Minimum source/reference gates:

```bash
node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json
node scripts/ci/llmswitch-rustification-audit.mjs --json
node scripts/ci/verify-llmswitch-minimal-ts-surface.mjs --json
node scripts/architecture/verify-vr-no-ts-runtime.mjs
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-mainline-manifest-sync
npm run verify:architecture-deleted-path
npm run verify:architecture-thin-wrapper-only
git diff --check
```

Add feature gates by touched owner:

- VR route/diagnostics: `npm run verify:vr-no-ts-runtime`, VR route/status
  focused tests, and live VR diagnostics only if runtime behavior is claimed.
- Responses request handler facade: `npm run verify:responses-handler-single-bridge-surface`.
- Responses SSE facade: `npm run verify:responses-sse-business-module`.
- Continuation/store: `npm run verify:responses-history-protocol-contract`.
- Provider response/SSE materialization: the focused
  `hub.response_provider_sse_materialization` tests from `verification-map.yml`.
- Runtime-impacting changes: rebuild, global install, managed restart, `/health`
  version check, and same-entry live replay before claiming runtime closure.

### Non-goals

- Do not delete `native-exports.ts` or `routing-integrations.ts` wholesale while
  production importers still depend on them.
- Do not convert host IO into hidden runtime semantics just to remove a facade.
- Do not count historical docs, residue tests, `dist`, `target`, `.mempalace`,
  or local indexes as current code-state evidence.
- Do not restore any deleted `sharedmodule/llmswitch-core/src` TS runtime shell,
  source-side JS mirror, or d.ts mirror.
