# llmswitch-core TS Shell Reference Closeout Plan

## Goal

Close the remaining llmswitch-core TypeScript shell references before deleting or collapsing the shells. The target is not to re-prove native semantic ownership; that is already guarded by the zero-TS/non-native gates. The target is to remove the runtime and package reference graph that still keeps `sharedmodule/llmswitch-core/src` TS shells alive.

## Acceptance Criteria

- Host bridge code no longer loads llmswitch-core runtime behavior through TS-shell `dist` subpaths that can be replaced by a single Rust/native binding owner.
- `src/modules/llmswitch/bridge/module-loader.ts` no longer contains the dead `ts`/`engine` implementation split, engine-prefix selection, or Jest source-prefer path for runtime shell loading.
- `src/modules/llmswitch/bridge/*` references to removable core shell subpaths are redirected to the agreed native binding entrypoint or deleted when unused.
- Static production import blockers inside `sharedmodule/llmswitch-core/src` are reduced before deleting files; no shell is deleted while it still has production importers or host bridge dist references.
- Package exports are narrowed so external consumers cannot keep recreating the old TS-shell surface through broad `./v2/*` or equivalent wildcard access.
- Deletions are physical deletions, not comments, dead aliases, compatibility fallback, or dual-path retention.

## Scope

In scope:

- `src/modules/llmswitch/bridge/module-loader.ts`
- `src/modules/llmswitch/bridge/native-exports.ts`
- `src/modules/llmswitch/bridge/provider-response-converter-host.ts`
- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts`
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` / `.js` if the TS source no longer exists
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `src/modules/llmswitch/bridge/runtime-integrations.ts`
- `src/modules/llmswitch/bridge/snapshot-recorder.ts`
- `src/modules/llmswitch/bridge/state-integrations.ts`
- `src/providers/core/runtime/provider-failure-policy-native.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/*` TS native shells that remain only as dist modules or internal fan-out barrels
- `sharedmodule/llmswitch-core/src/conversion/*` TS native shells that remain only as dist modules or bridge helpers
- `sharedmodule/llmswitch-core/package.json` exports
- Relevant architecture/function/verification maps and CI gates

Out of scope:

- Reintroducing TS semantic ownership.
- Adding fallback to old TS modules.
- Changing provider-specific behavior.
- Changing user runtime config.
- Live server restart unless a runtime behavior change requires final online verification and Jason explicitly permits release/global-install scope.

## Current Evidence Baseline

The previous audit established:

- `node scripts/ci/llmswitch-rustification-audit.mjs --json` passes with `nonNativeFileCount=0` and `nonNativeLocTotal=0`.
- `node scripts/ci/verify-llmswitch-minimal-ts-surface.mjs --json` passes with `entries=0`.
- `node scripts/ci/verify-llmswitch-zero-ts-closeout.mjs` passes.
- Remaining production TS files in `sharedmodule/llmswitch-core/src` are shell/native-linked surfaces, not non-native semantic owners.
- Host code does not directly static-import `sharedmodule/llmswitch-core/src/**/*.ts`; the runtime coupling is through `requireCoreDist` / `importCoreDist` and package/dist subpaths.

## Reference Blockers To Close First

Primary host bridge blockers:

| Host file | Current shell subpaths to close |
| --- | --- |
| `src/modules/llmswitch/bridge/module-loader.ts` | `native/router-hotpath/native-failure-policy`, `native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol`, `native/router-hotpath/native-virtual-router-routing-state`; dead `ts`/`engine` selection and Jest source preference |
| `src/modules/llmswitch/bridge/native-exports.ts` | `native-failure-policy`, `native-hub-vr-node-contracts`, `native-shared-conversion-semantics`, `native-hub-pipeline-resp-semantics` |
| `src/modules/llmswitch/bridge/provider-response-converter-host.ts` | `native-hub-pipeline-orchestration-semantics-protocol`, `native-shared-conversion-semantics`, `conversion/runtime-metadata`, `native-virtual-router-routing-state`, `native-sse-runtime`, `conversion/hub/response/provider-response-helpers`, `native-hub-pipeline-resp-semantics`, `conversion/hub/metadata-center-runtime-control-writer`, `conversion/hub/pipeline/stages/utils` |
| `src/modules/llmswitch/bridge/responses-conversation-store-host.ts` | `conversion/shared/responses-conversation-store-native` |
| `src/modules/llmswitch/bridge/responses-response-bridge.*` | `conversion/responses/responses-openai-bridge` |
| `src/modules/llmswitch/bridge/routing-integrations.ts` | `native-hub-pipeline-orchestration-semantics`, `runtime/virtual-router-host-effects`, `native-virtual-router-bootstrap-config` |
| `src/modules/llmswitch/bridge/runtime-integrations.ts` | `conversion/snapshot-utils`, `native-sse-runtime`, `native-provider-runtime-ingress` |
| `src/modules/llmswitch/bridge/snapshot-recorder.ts` | `conversion/hub/snapshot-recorder` |
| `src/modules/llmswitch/bridge/state-integrations.ts` | `native-virtual-router-routing-state` |
| `src/providers/core/runtime/provider-failure-policy-native.ts` | direct `dist/native/router-hotpath/native-failure-policy` load |

Primary internal fan-out blockers:

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-shared.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.ts`
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts`

Zero-production-import candidates that still require exact reference verification before deletion:

- `sharedmodule/llmswitch-core/src/conversion/compaction-detect.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/utils.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-helpers.ts`
- `sharedmodule/llmswitch-core/src/conversion/mcp-injection.ts`
- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.ts`
- `sharedmodule/llmswitch-core/src/conversion/shared/tooling.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-failure-policy.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-gemini-sse-event-payload.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-vr-node-contracts.ts`

## Design Principles

- Rust/native binding is the only runtime truth.
- TS may remain only as host IO or intentionally retained public boundary code; it must not own pipeline, routing, tool governance, metadata, error policy, servertool, SSE, or conversion semantics.
- No fallback, no compatibility dual path, no best-effort module probing that silently revives deleted shell modules.
- A shell can be removed only after its direct production importers, host bridge dist references, package exports, generated JS references, tests, and architecture maps are all accounted for.
- Broad package exports must be narrowed before declaring a surface closed.
- Do not use generated files, `dist`, `target`, `coverage`, `.mempalace`, or local indexes as source-of-truth evidence for current source state.

## Technical Plan

1. Regenerate a precise shell reference graph from git-tracked source:
   - production TS shell list under `sharedmodule/llmswitch-core/src`;
   - static source importers;
   - `requireCoreDist` / `importCoreDist` / `importCoreModule` / package export references;
   - package export reachability;
   - test-only and docs-only references.
2. Close `module-loader.ts` first:
   - remove dead engine implementation routing if it is not needed;
   - remove Jest source-prefer loading for runtime shells;
   - make failures explicit when a required native binding is missing.
3. Close host bridge direct subpath references:
   - move grouped native calls behind the smallest authoritative native binding entrypoint;
   - avoid replacing one shell subpath with another equivalent shell subpath;
   - remove bridge helpers that only forwarded to deleted shell modules.
4. Collapse internal native-shell fan-out:
   - start with high-fan-out barrels/loaders;
   - redirect internal modules to the canonical native binding or remove the importer;
   - keep type-only interfaces only if they remain public and cannot be expressed through existing declarations.
5. Delete verified zero-production-import shells:
   - run exact reference scans before each deletion batch;
   - update tests/docs/gates that intentionally mentioned removed paths;
   - avoid deleting files owned by other workers' dirty changes.
6. Narrow package exports:
   - remove or replace broad `./v2/*` style exports if they expose deleted shells;
   - keep only intentional public entrypoints.
7. Update maps/gates:
   - function map, mainline call map, verification map, and architecture gates must reflect the final owner and forbidden old shell paths.

## Risk Points

- Jest may currently rely on source-prefer behavior to load TS modules instead of dist. Removing it can expose missing build steps or stale test assumptions.
- Some `.js` files under `src/modules/llmswitch/bridge` may be checked in and must be kept consistent with `.ts` source or deleted only if verified generated/stale.
- Package wildcard exports can keep old shell subpaths reachable even after direct imports are removed.
- Tests and docs may intentionally assert deleted-path contracts; update them to assert the new forbidden paths rather than removing coverage.
- Multiple workers may have unrelated dirty files. Stage only files changed for this task.

## Verification Matrix

Minimum required checks after each meaningful batch:

- `git status --short` and precise diff review.
- Exact reference scan for removed/redirected subpaths.
- `node scripts/ci/verify-llmswitch-zero-ts-closeout.mjs`
- `npm run verify:llmswitch-minimal-ts-surface -- --json`
- `npm run verify:llmswitch-rustification-audit -- --json`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json`
- Root TypeScript/build gate if host bridge files change.
- Focused tests for touched bridge/runtime area.
- `git diff --check`

If runtime behavior is changed beyond compile-time reference closure, add the mapped runtime smoke/live replay required by `docs/architecture/verification-map.yml` and project AGENTS.

## Implementation Order

1. Audit and write the exact reference graph.
2. Close `module-loader.ts` dead `ts`/`engine` path.
3. Close host bridge subpath loaders.
4. Close internal high-fan-out native shell barrels/loaders.
5. Delete verified zero-production-import shells.
6. Narrow package exports.
7. Update maps and gates.
8. Run verification matrix.
9. Commit only this task's files.

## Definition Of Done

- The remaining TS shell list is smaller because references were removed first, not because imports were broken.
- No runtime host bridge depends on removable TS-shell dist subpaths.
- Old shell paths are covered by deletion/forbidden-path gates where appropriate.
- Verification gates pass with evidence.
- Work is committed without staging unrelated dirty files.

## Progress Notes

### 2026-07-09 module-loader and responses response bridge CoreDist helpers removed

- `src/modules/llmswitch/bridge/module-loader.ts/js` is now a path-resolution-only bridge and no longer implements `importCoreDist`, `requireCoreDist`, node `require` creation, Jest runtime detection, or TS dist module loading.
- `src/modules/llmswitch/core-loader.ts/js` no longer carries the dead `engine` implementation family, `rcc-llmswitch-engine` lookup, Jest source-prefer branch, or builtin TS source fallback; `importCoreModule` now imports only the resolved core dist URL and fails explicitly when the dist module is missing.
- `src/modules/llmswitch/bridge/responses-response-bridge.ts/js` no longer exports `importResponsesHandlerCoreDist` / `requireResponsesHandlerCoreDist` and no longer loads `conversion/responses/responses-openai-bridge`; chat-completion JSON normalization now calls `buildResponsesPayloadFromChatNative` directly.
- `docs/architecture/function-map.yml` no longer lists the deleted Responses CoreDist helpers as canonical builders.
- Package export scan found no broad wildcard exports in `sharedmodule/llmswitch-core/package.json`.
- Verification passed so far: root `tsc`, JS syntax checks for touched JS bridge/loader files, focused `responses-response-bridge.direct-json-protocol-guard` Jest 3/3, `verify:server-function-map-boundary`, and `verify:llmswitch-ts-shell-reference-audit`.
- Verification caveat: `npm test -- --runTestsByPath ...` incorrectly ran the repo's default routing-instructions suite before the target file and failed on unrelated existing environment/sample/deleted-shell issues; the focused file was rerun with `npm run jest:run -- --runTestsByPath ... --runInBand` and passed.

### 2026-07-09 snapshot-recorder host bridge ref direct-native wired

- `src/modules/llmswitch/bridge/snapshot-recorder.ts/js` no longer imports `importCoreDist` or loads the llmswitch-core snapshot recorder dist facade.
- Base recorder creation moved into the host bridge and calls direct `router_hotpath_napi` snapshot hook capabilities for should-record, stage payload normalization, write-option planning, and write execution.
- MetadataCenter snapshot read remains host bridge IO and is passed into the Rust write-option plan; bridge errorsample/client-tool/empty-response observation logic remains unchanged.
- Strict reference audit improved to `shellsWithHostTextRefs=2` and `coreModuleSubpathRefs=8`, with `host=[]`; remaining subpath refs are docs/scripts/other categories.
- Verification passed: focused Jest 192/192, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule tsc, root tsc, JS syntax check, and `git diff --check`.
- Remaining work: host bridge shell refs are closed; continue with `module-loader.ts`, package exports, internal fan-out, and deletion candidates.

### 2026-07-09 routing-integrations host bridge shell refs direct-native wired

- `src/modules/llmswitch/bridge/routing-integrations.ts/js` no longer imports `importCoreDist` / `requireCoreDist` or loads `native-hub-pipeline-orchestration-semantics`, `native-virtual-router-bootstrap-config`, or `runtime/virtual-router-host-effects`.
- HubPipeline handle calls and VR bootstrap now call direct `router_hotpath_napi` binding functions.
- Virtual router route host effects are local host IO/object mutation only; marker parsing, stop-scope resolution, marker cleanup planning, session color key, hit record/format, forced stop label, and `rccUserDir` resolution call direct Rust NAPI capabilities.
- Strict reference audit improved to `shellsWithHostTextRefs=3` and `coreModuleSubpathRefs=10`; host bridge refs now list only `snapshot-recorder.ts/js -> conversion/hub/snapshot-recorder`.
- Verification passed: focused Jest 210/210, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule tsc, root tsc, JS syntax check, and `git diff --check`.
- Remaining work: close `snapshot-recorder.ts/js`, then proceed to module-loader/package/internal fan-out and deletion candidates.

### 2026-07-09 native-exports host bridge shell loaders direct-native wired

- `src/modules/llmswitch/bridge/native-exports.ts/js` no longer imports `importCoreDist` / `requireCoreDist` from `module-loader.ts/js`.
- Removed the remaining `native-shared-conversion-semantics`, `native-hub-pipeline-resp-semantics`, and `native-hub-bridge-policy-semantics` loader/cache paths from `native-exports.ts/js`.
- Shared conversion, MCP injection, Responses handler/context/continuation planning, Responses stored media strip, Anthropic response projection, and provider outbound sanitize wrappers now call direct `router_hotpath_napi` JSON capabilities.
- The bridge keeps `planResponsesHandlerEntryJson` on its native mixed signature: encoded payload JSON plus raw optional `entryEndpoint` and `responseIdFromPath` strings.
- Exact scan for old `native-exports.ts/js` loader/subpath names returns zero matches.
- Strict reference audit improved to `shellsWithHostTextRefs=6` and `coreModuleSubpathRefs=16`.
- Verification passed: focused Jest 207/207, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule tsc, root tsc, JS syntax check, and `git diff --check`.
- Remaining work: `snapshot-recorder.ts/js` and `routing-integrations.ts/js` still hold host bridge shell subpath refs; module-loader/package/internal fan-out closeout remains.

### 2026-07-09 provider response and runtime bridge refs direct-native wired

- `src/modules/llmswitch/bridge/runtime-integrations.ts/js` now calls direct native JSON capabilities for SSE decode preload and provider runtime ingress policy; it no longer loads `native/router-hotpath/native-sse-runtime` or `native/router-hotpath/native-provider-runtime-ingress`.
- `src/modules/llmswitch/bridge/provider-response-converter-host.ts/js` now calls direct Rust JSON capabilities for HubPipeline response execution, metadata snapshot planning, effect-plan normalization, provider protocol resolution, Responses record planning, runtime metadata carrier materialization, metadata write-plan projection, response SSE materialization/error descriptors, SSE frame building, provider response context helpers, and session usage planning.
- Provider-response host now keeps only host stream construction and MetadataCenter symbol read/write IO locally; response semantics remain Rust/native-owned.
- The residue gate now requires `resolveProviderResponseContextHelpersJson` direct capability use and forbids the old `native/router-hotpath/native-hub-pipeline-resp-semantics` host subpath.
- Strict reference audit improved to `shellsWithHostTextRefs=9` and `coreModuleSubpathRefs=26`.
- Verification passed: focused Jest 242/242, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule tsc, root tsc, JS syntax checks, and `git diff --check`.
- Remaining work: `snapshot-recorder.ts/js`, `native-exports.ts/js`, and `routing-integrations.ts/js` still hold host bridge shell subpath refs.

### 2026-07-09 snapshot and routing-state host bridge refs closed

- `src/modules/llmswitch/bridge/runtime-integrations.ts/js` now calls direct native snapshot hook capabilities via `native-exports.ts/js`; the host bridge no longer loads `conversion/snapshot-utils`.
- `src/modules/llmswitch/bridge/state-integrations.ts/js` now calls direct native JSON capabilities for routing instruction state load/save and preserves Set/Map state through native serialize/deserialize; the host bridge no longer loads `native/router-hotpath/native-virtual-router-routing-state`.
- `src/modules/llmswitch/bridge/provider-response-converter-host.ts/js` now calls `planChatProcessSessionUsageJson` through `getRouterHotpathJsonBindingSync()` instead of loading the routing-state TS shell for session usage planning.
- Exact bridge scan for `native/router-hotpath/native-virtual-router-routing-state|conversion/snapshot-utils` under `src/modules/llmswitch/bridge` returns zero matches.
- Strict reference audit improved to `shellsWithHostTextRefs=14` and `coreModuleSubpathRefs=30` while `prodTsShellCount=97` remains unchanged.
- Verification passed: focused Jest 216/216, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule tsc, root tsc, and `git diff --check`.
- Remaining work: continue closing provider response orchestration/shared conversion/metadata writer/SSE and routing integration shell subpaths before deleting further shells.

### 2026-07-09 responses store and node contract shell deletion

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.ts` was removed after host bridge direct native JSON wiring was in place.
- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts` now calls `getRouterHotpathJsonBindingSync()` for the responses store plan/resume capabilities instead of loading the deleted core TS facade.
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-vr-node-contracts.ts` was removed after tests were redirected to `src/modules/llmswitch/bridge/native-exports.ts`.
- `native-exports.ts` now exposes the former contract-help functions from direct native binding wrappers, including server module help.
- Added `verify:llmswitch-ts-shell-reference-audit` as the package script for the new strict reference gate.
