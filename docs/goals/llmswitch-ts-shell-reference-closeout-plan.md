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

- `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts`
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

### 2026-07-09 VR provider bootstrap wrapper deleted

- Physically deleted `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-providers.ts`.
- `tests/sharedmodule/virtual-router-bootstrap-provider-auth-alias.spec.ts` now uses direct `router_hotpath_napi.node` `bootstrapVirtualRouterProvidersJson` evidence instead of importing the retired TS wrapper.
- Rust `provider_bootstrap.rs` now owns `tokenFile` / `token_file` auth material, treats token files as effective material, and does not synthesize placeholder `secretRef` when a token file is present.
- `scripts/architecture/verify-vr-no-ts-runtime.mjs` and `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` lock the retired wrapper path as physically absent.
- Verification passed: focused provider bootstrap/residue Jest 201/201, `verify-vr-no-ts-runtime`, strict shell reference audit (`prodTsShellCount=61`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`), zero-ts closeout, minimal TS surface, rustification audit, sharedmodule/root `tsc`, Rust `provider_bootstrap` tests 7/7, exact ref scan, and `git diff --check`.

### 2026-07-09 Responses SSE event payload wrapper deleted

- Physically deleted `sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.ts` after direct Rust NAPI tests replaced the old TS wrapper imports.
- Added `tests/sharedmodule/helpers/responses-sse-direct-native.ts` as test-only direct native binding evidence for Responses SSE payload/sequence builders; it does not create a runtime TS owner.
- `tests/sharedmodule/responses-sse-output-item-descriptor-native.spec.ts`, `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`, and `tests/sharedmodule/responses-sse-reasoning-summary-no-normalize.spec.ts` now call `router_hotpath_napi.node` directly.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` now locks the deleted Responses SSE wrapper path alongside the Chat/Anthropic/Gemini event-payload wrappers.
- `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` now mark Responses SSE encode projection as direct Rust/NAPI-owned with the old event-payload wrapper deleted.
- Strict audit now reports `prodTsShellCount=90`, `nonNativeFileCount=0`, `shellsWithHostTextRefs=1`, and `coreModuleSubpathRefs=8`.
- Verification passed: focused Responses SSE/residue Jest 220/220, `verify:sse-architecture-boundary`, `verify:function-map-compile-gate`, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule `tsc`, root `tsc`, exact source ref scan for deleted wrapper path, and `git diff --check`.

### 2026-07-09 Hub request-stage wrapper deleted

- Physically deleted `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`.
- Added `tests/sharedmodule/helpers/request-stage-direct-native.ts` as test-only direct Rust/NAPI request-stage evidence; runtime ownership remains in Rust/native `runHubPipelineLibWithNative` and request-stage plan builders.
- `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts` and `tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts` now use the direct native helper instead of importing the retired shell.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`, `scripts/architecture/verify-route-metadata-preselected-route-owner.mjs`, and `scripts/architecture/verify-metadata-center-dualwrite-api.mjs` now lock the old request-stage shell as physically absent and validate the direct-native evidence surface.
- The real-entry stopless provider payload regression now supplies request truth `sessionId` through the entry payload; this matches the Rust request governance contract that requires both `stopMessageEnabled` and `requestTruth.sessionId` before injecting stopless guidance.
- Function map and verification map now mark `hub.request_stage_pipeline_bridge` as retired/Rust-owned with the old shell in forbidden paths.
- Verification passed: focused request-stage/residue Jest 217/217, route metadata owner gate, metadata-center dualwrite gate, function-map compile gate, strict shell reference audit (`prodTsShellCount=60`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`), zero-ts closeout, minimal TS surface, rustification audit, sharedmodule/root `tsc`, exact source/package scan for old shell refs, and `git diff --check`.

### 2026-07-09 session identifier wrapper deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-session-identifiers-semantics.ts`.
- `tests/servertool/hub-pipeline-session-headers.spec.ts` now calls direct Rust/NAPI `extractSessionIdentifiersJson` instead of the retired TS wrapper.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` locks the old wrapper path as physically absent while keeping the retired header-helper public NAPI symbols forbidden.
- `tests/scripts/install-release-snapshot.spec.ts` now checks a still-live sharedmodule dist file instead of preserving the retired session identifier wrapper path.

### 2026-07-09 stop-message auto wrapper deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`.
- `tests/servertool/stop-message-native-decision.spec.ts` and `tests/servertool/stop-schema-lifecycle-contract.spec.ts` now call direct Rust/NAPI `decideStopMessageAction` and `evaluateStopSchemaGateJson` through test-only helper code.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` locks the old wrapper path as physically absent.
- Function map and verification map now record that the stop-message auto wrapper must stay deleted and that direct NAPI tests are evidence, not runtime TS ownership.

### 2026-07-10 runtime-integrations test loader mock removed

- Removed the stale `src/modules/llmswitch/bridge/module-loader.js` mock from `tests/modules/llmswitch/bridge/runtime-integrations.responses-store.spec.ts`.
- The spec now proves `runtime-integrations.ts` reaches the authoritative process-global Responses conversation store without preserving `requireCoreDist` / `importCoreDist` as a test consumer.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `module-loader` / `resolveImplForSubpath` / `resolveBaseDir` in that spec now returns zero matches.

### 2026-07-10 responses debug diag spec shared mock consumer removed

- `tests/server/handlers/responses-handler.debug-diag.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The spec now uses a local minimal bridge mock for the exact handler failure path it exercises, reducing `createBridgeHttpServerMock(...)` source consumers from 19 to 18.
- Exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` in that spec now returns zero matches.

### 2026-07-10 responses request-timeout spec shared mock consumer removed

- `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The timeout blackbox now uses a local minimal bridge mock for the timeout and fast-path branches it exercises, reducing `createBridgeHttpServerMock(...)` source consumers from 18 to 17.
- Exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` in that spec now returns zero matches.

### 2026-07-10 responses request-start-log spec shared mock consumer removed

- `tests/server/handlers/responses-handler.request-start-log.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The request-start logging spec now uses a local minimal bridge mock for handler log/session-color coverage, reducing `createBridgeHttpServerMock(...)` source consumers from 17 to 16.
- Exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` in that spec now returns zero matches.

### 2026-07-10 SSE timeout spec shared mock consumer removed

- `tests/server/handlers/sse-timeout.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The SSE timeout test now uses a local minimal bridge mock for finish-reason/error-frame projection and passes the stream through the current `PipelineExecutionResult.sseStream` contract instead of the stale `body.sseStream` shape.
- `createBridgeHttpServerMock(...)` source consumers are reduced from 16 to 15, and exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` in that spec now returns zero matches.

### 2026-07-10 submit tool outputs SSE error shared mock consumer removed

- `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The submit-tool-outputs SSE error regression now uses local minimal mocks for the handler-facing request bridge, response/SSE bridge, bridge barrel session extraction, and native export projection symbols required by the tested path.
- Exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` / legacy core loader helpers in that spec now returns zero matches, and `createBridgeHttpServerMock(...)` source consumers are reduced from 15 to 14.

### 2026-07-10 provider response converter stopless sync shared mock consumer removed

- `tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The provider response converter metadata-center binding spec now uses a local minimal bridge mock for `convertProviderResponse`, `createSnapshotRecorder`, and `deriveFinishReasonNative`; it no longer declares `importCoreDist` / `requireCoreDist` loader helpers.
- Exact file scan for `bridge-http-server-mock` / `createBridgeHttpServerMock` / legacy core loader helpers in that spec now returns zero matches, and `createBridgeHttpServerMock(...)` source consumers are reduced from 14 to 13.

### 2026-07-09 req-process wrapper deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-process-semantics.ts`.
- `tests/sharedmodule/req-process-servertool-bundle-contract.spec.ts` now calls direct Rust/NAPI `applyReqProcessToolGovernanceJson` through test-only helper code.
- `tests/sharedmodule/native-governance-apply-patch-line-edit.spec.ts` and `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` lock the old wrapper path as physically absent.
- Function map and verification map now record that direct NAPI tests are evidence, not runtime TS ownership.

### 2026-07-09 servertool MetadataCenter carrier shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts`.
- Stop-gateway and stop-message compare tests now call direct native exports for Rust decisions/normalization and use the server HTTP MetadataCenter API for request-local runtime-control writes.
- `scripts/architecture/verify-metadata-center-dualwrite-api.mjs` no longer allows this servertool-local migration shell to perform direct MetadataCenter writes.
- `scripts/verify-rcc-release-install.mjs` no longer imports the deleted dist path from installed packages.
- Residue and red-test coverage now lock the shell as physically absent while keeping the bound MetadataCenter/no-flat-providerProtocol boundary.

### 2026-07-09 guidance public TS shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/guidance/index.ts`.
- Removed package exports `./guidance` and `./v2/guidance` so the old public TS guidance shell cannot be recreated through package subpaths.
- Tool guidance tests now call direct Rust/NAPI exports `buildSystemToolGuidanceJson` and `augmentOpenAIToolsJson` through a test-only direct native helper.
- Residue coverage now locks the guidance TS shell as physically absent.

### 2026-07-09 text markup normalizer shells deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.ts` and its helper `sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer/normalize.ts`.
- Text markup tests now call direct Rust/NAPI extraction and normalization exports through a test-only direct native helper.
- `scripts/verify-apply-patch.mjs` now calls the host bridge native export `normalizeAssistantTextToToolCallsJson` instead of loading the deleted llmswitch-core subpath.
- Residue/red-test coverage now locks both retired source paths as physically absent.

### 2026-07-09 Anthropic response runtime shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts`.
- Hidden-reasoning tests now call direct native response semantics through `tests/sharedmodule/helpers/anthropic-response-direct-native.ts`; this helper is test-only evidence and not a runtime TS owner.
- `scripts/tests/anthropic-chat-e2e.mjs` and `scripts/tests/anthropic-responses-roundtrip.mjs` now load `dist/native/router-hotpath/native-hub-pipeline-resp-semantics.js` instead of the retired response runtime dist subpath.
- Function/verification maps and residue/red-test coverage now lock the former response runtime shell as physically absent.

### 2026-07-09 Standardized bridge runtime shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.ts`.
- Chat semantics tests now call direct native req inbound/outbound conversion helpers through `tests/sharedmodule/helpers/standardized-bridge-direct-native.ts`.
- Function/verification maps now keep only the still-consumed ChatEnvelope/StandardizedRequest declaration files as TS bridge surface and forbid restoring the runtime wrapper.

### 2026-07-09 Sharedmodule snapshot recorder runtime shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts`.
- Snapshot recorder native plan test now exercises `src/modules/llmswitch/bridge/snapshot-recorder.ts`, which owns host IO/observation and delegates snapshot stage normalization, write-option planning, should-record policy, and write execution to direct native snapshot hook capabilities.
- Removed the obsolete host ambient declaration for the retired sharedmodule dist snapshot-recorder subpath.

### 2026-07-09 Compat engine runtime shell deleted

- Physically deleted zero-production-import `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts` and `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/native-adapter-context.ts`.
- Compat tests now call direct native req outbound compat helpers through `tests/sharedmodule/helpers/compat-engine-direct-native.ts`; this helper is test-only evidence and not a runtime TS owner.
- Architecture verification scripts now assert the old compat engine TS shell is physically absent while continuing to verify Rust request compat truth and native req-outbound bridge exports.

### 2026-07-09 core-loader implementation selector removed

- `src/modules/llmswitch/core-loader.ts/js/d.ts` no longer exports `LlmsImpl` or accepts an implementation selector argument on core package/module resolution APIs.
- `src/modules/llmswitch/bridge/routing-integrations.ts/js` and `src/modules/llmswitch/bridge/native-exports.ts/js` now call `resolveCorePackageDir()` without a dead `'ts'` implementation parameter.
- Exact source/runtime scan found no remaining `LlmsImpl`, unsupported implementation branch, or explicit `resolveCorePackageDir('ts')` caller outside docs.

### 2026-07-09 SSE event payload wrappers deleted

- Physically deleted three zero-production-import SSE native wrapper shells after direct Rust NAPI tests replaced the old TS wrapper imports:
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.ts`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.ts`
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-gemini-sse-event-payload.ts`
- `tests/sharedmodule/sse-rust-parity-chat-json-to-sse.blackbox.spec.ts`, `tests/sharedmodule/anthropic-sse-tool-input-no-fallback.spec.ts`, and `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` now call `router_hotpath_napi.node` directly for JSON->SSE sequence ownership.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` locks the three deleted wrapper paths and source references as retired.
- `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` now mark SSE JSON->SSE sequence ordering as direct Rust/NAPI-owned with TS limited to stream IO shell only.
- Strict audit now reports `prodTsShellCount=91`, `nonNativeFileCount=0`, `shellsWithHostTextRefs=1`, and `coreModuleSubpathRefs=8`.
- Verification passed: focused SSE/residue Jest 220/220, `verify:sse-architecture-boundary`, `verify:function-map-compile-gate`, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule `tsc`, root `tsc`, exact source ref scan for deleted wrapper paths, and `git diff --check`.

### 2026-07-09 zero-production-import conversion facades deleted

- Physically deleted three zero-production-import TS shells after exact source scan proved no production importer and no host bridge/package export reachability:
  - `sharedmodule/llmswitch-core/src/conversion/compaction-detect.ts`
  - `sharedmodule/llmswitch-core/src/conversion/mcp-injection.ts`
  - `sharedmodule/llmswitch-core/src/conversion/shared/tooling.ts`
- `sharedmodule/llmswitch-core/scripts/tests/coverage-bridge-protocol-blackbox.mjs` no longer imports the retired dist facades as bridge/protocol coverage targets.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` now locks these source files as retired/physically deleted.
- Strict audit now reports `prodTsShellCount=94` with `nonNativeFileCount=0`; deleted files did not reduce `shellsWithProdImporters` because they already had no production importers.
- Verification passed: sharedmodule `tsc`, root `tsc`, `verify:llmswitch-ts-shell-reference-audit`, zero-ts closeout, minimal TS surface, rustification audit, residue audit 191/191, and `git diff --check`.

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

### 2026-07-10 native shared conversion core shell retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.ts` is physically deleted after exact source refs were migrated to the existing native router hotpath loader.
- The moved surface is only binding/stringify/parse/error glue around required Rust/NAPI exports; no Hub/VR/provider semantics were added to TS.
- Build-core required dist output no longer packages a router-hotpath TS loader; required native exports are tracked by `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`.
- Verification passed: sharedmodule `tsc`, focused VR/stopmessage/residue/build-core Jest, strict shell reference audit, minimal TS surface, and rustification audit.

### 2026-07-10 virtual-router hit-log facade retired

- `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts` is physically deleted after production/test consumers were moved to Rust/NAPI direct calls.
- `sharedmodule/llmswitch-core/package.json` no longer exports `./v2/runtime/virtual-router-hit-log`, and `src/types/rcc-llmswitch-core.d.ts` no longer declares that ambient package subpath.
- `src/utils/session-log-color.ts` now calls `resolveSessionColorStr` / `resolveSessionLogColorKeyJson` through the host native binding instead of importing the deleted package facade; it no longer reimplements session-key candidate priority locally.
- `native-virtual-router-runtime.ts` now calls `createVirtualRouterHitRecordJson`, `formatVirtualRouterHitJson`, and `resolveSessionLogColorKeyJson` through the existing native loader helpers; the old TS facade is locked as forbidden in maps and residue audit.
- `tests/sharedmodule/virtual-router-hit-log.spec.ts` uses test-only direct native helper `tests/sharedmodule/helpers/virtual-router-hit-log-direct-native.ts`.
- Strict reference audit now reports `prodTsShellCount=4`, `shellsWithProdImporters=2`, `shellsWithHostTextRefs=1`, and `coreModuleSubpathRefs=3`; rustification audit baseline is `prodTsFileCount=4`, `prodTsLocTotal=2184`, `nonNativeFileCount=0`.
- Verification passed: focused hit-log/residue/required-export Jest 230/230, sharedmodule tsc, `build:base`, strict shell reference audit, minimal TS surface, rustification audit, VR no-TS runtime, function-map/mainline/deleted-path/thin-wrapper/manifest/wiki gates.

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

### 2026-07-09 exec_command validator shell deleted

- Physically deleted `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts`.
- `tests/sharedmodule/helpers/tool-validation-direct-native.ts` and `scripts/helpers/tool-validation-direct-native.mjs` no longer import the deleted source/dist validator shell; they call direct Rust/NAPI `normalizeExecCommandArgsJson`, `validateCanonicalClientToolCallJson`, and `validateExecCommandGuardJson`.
- Added `validateCanonicalClientToolCallJson` to `native-router-hotpath-loader.ts` so the native binding contract locks the direct validation path.
- Removed the deleted validator path from `docs/architecture/no-fallback-diff-rules.json`.
- Residue audit now locks the validator shell as physically absent and scans helper surfaces for old TS hardcoded guard/policy logic.
- Strict audit now reports `prodTsShellCount=64`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, and `coreModuleSubpathRefs=4`.
- Verification passed: focused exec_command/residue Jest 205/205, script syntax checks, strict shell audit, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule/root `tsc`, exact source/package ref scan, and `git diff --check`.

### 2026-07-09 exec_command parse/normalize shells deleted

- Physically deleted `sharedmodule/llmswitch-core/src/tools/args-json.ts` and `sharedmodule/llmswitch-core/src/tools/exec-command/normalize.ts`.
- `tests/sharedmodule/helpers/tool-validation-direct-native.ts` now calls direct Rust/NAPI `parseToolArgsJsonWithArtifactRepairJson` and `normalizeExecCommandArgsJson`.
- Removed the deleted `args-json.ts` path from `docs/architecture/no-fallback-diff-rules.json`.
- Residue audit now locks both paths physically absent and scans helper surfaces for old local parser/normalizer logic.
- Strict audit now reports `prodTsShellCount=62`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, and `coreModuleSubpathRefs=4`.
- Verification passed: focused exec_command/residue Jest 205/205, script syntax checks, strict shell audit, zero-ts closeout, minimal TS surface, rustification audit, sharedmodule/root `tsc`, exact source/package ref scan, and `git diff --check`.

### 2026-07-10 host bridge source-side JS mirrors deleted

- Physically deleted all tracked `src/modules/llmswitch/**/*.js` and `src/modules/llmswitch*.js` source-side emit mirrors after confirming every deleted file had a canonical same-name `.ts` source.
- Kept canonical TypeScript bridge sources as the only host authoring surface. Runtime build output is produced under `dist`; Jest relative `.js` specifiers resolve to TS via `moduleNameMapper`, so checked-in source mirrors are not active runtime truth.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` now fails if any tracked-and-existing host bridge `.js` source artifact returns under `src/modules/llmswitch`.
- Gate updates stopped reading deleted mirrors in `verify-responses-handler-single-bridge-surface`, `llmswitch-ts-shell-reference-audit`, `hub-policy-injection`, and residue tests; checks now target `.ts` canonical sources or absent mirrors.
- Verification passed: focused residue Jest 211/211, focused hub-policy/snapshot Jest 4/4, `verify:responses-handler-single-bridge-surface`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=3`), `verify:responses-sse-business-module`, `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, `verify:function-map-compile-gate`, root `tsc`, and `build:base`.

### 2026-07-11 request executor shared bridge mock consumer removed

- `tests/server/runtime/http-server/request-executor.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The single request-executor bridge mock site now uses a file-local minimal mock exposing only `evaluateResponsesDirectRouteDecisionNative`, which is the only symbol required by the tested direct-payload contract branch.
- This removes one external consumer of the legacy helper APIs `importCoreDist`, `requireCoreDist`, `resolveImplForSubpath`, and `resolveBaseDir` without adding a new TS semantic owner.
- Remaining `createBridgeHttpServerMock(...)` consumers are the submit-tool-outputs responses-provider regression and the SSE projection-timeout blackbox suite; both require dedicated contract review before migration.

### 2026-07-11 submit_tool_outputs shared bridge mock consumer removed

- `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The spec now declares its response/SSE/request bridge mocks explicitly, including the current Rust/native request bridge contracts for `planResponsesContinuationRequestAction`, `materializeProviderOwnedSubmitContext`, and `planResponsesRequestContext`.
- The submit assertions were aligned with the current handler contract: raw HTTP body remains on `pipelineInput.body`, prepared Hub payload is asserted on `pipelineInput.hubBody`, and relay `routeHint` / `providerKey` are not expected in pre-execute MetadataCenter continuation/runtime control.
- This removes the submit-tool regression from the legacy helper consumer set without reintroducing `importCoreDist`, `requireCoreDist`, `resolveImplForSubpath`, or `resolveBaseDir`.

### 2026-07-11 SSE projection timeout shared bridge mock deleted

- `tests/server/handlers/sse-projection-timeout.blackbox.spec.ts` no longer imports `tests/helpers/bridge-http-server-mock.ts`.
- The spec now mocks the current handler-facing facades directly: `responses-response-bridge.js` and `responses-sse-bridge.js`, with SSE projection/terminal state kept as explicit file-local test doubles.
- Stale SSE-side repair expectations were removed: the blackbox now locks the current transport-only contract that SSE passes projected frames, does not synthesize function-call repair frames, and does not turn a normally ended non-terminal upstream stream into a handler-owned semantic error.
- Source-tracked active consumer scan showed `createBridgeHttpServerMock(...)` was referenced only by the helper itself, so `tests/helpers/bridge-http-server-mock.ts` was physically deleted.

### 2026-07-11 prestart close guard loader helper removed

- `tests/server/handlers/handler-response-utils.prestart-client-close-guard.spec.ts` no longer declares legacy `importCoreDist` / `requireCoreDist` bridge loader mocks.
- The spec now mocks the current handler-facing `responses-response-bridge.js` and `responses-sse-bridge.js` facades directly for the prestart close guard path.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad `bridge.js` mock references returns zero matches.

### 2026-07-11 responses keepalive legacy loader mock removed

- `tests/server/handlers/handler-response-utils.responses-keepalive-protocol.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or declares legacy `importCoreDist` / `requireCoreDist` helpers.
- The keepalive transport spec now mocks only the current handler-facing `responses-response-bridge.js` and `responses-sse-bridge.js` facades, preserving the SSE transport-only contract without adding TS semantic owner logic.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad `bridge.js` mock references returns zero matches.

### 2026-07-11 responses SSE client contract broad bridge mock removed

- `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` / `.ts` or declares legacy `importCoreDist` / `requireCoreDist` helpers.
- The blackbox now exercises the real current handler-facing facade/native path while keeping only snapshot writer disabled; no replacement TS projection/continuation mock was added.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad `bridge.js` / `.ts` mock references returns zero matches.

### 2026-07-11 required_action split-frame broad bridge mock removed

- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` / `.ts`, response/SSE bridge source `.ts`, or declares legacy `importCoreDist` / `requireCoreDist` helpers.
- The regression now exercises the real current handler-facing facade/native path while keeping only snapshot writer disabled; no replacement TS projection/continuation/terminal-repair mock was added.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 upstream-incomplete broad bridge mock removed

- `tests/server/handlers/handler-response-sse-upstream-incomplete.regression.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or declares legacy `importCoreDist` / `requireCoreDist` projection helpers.
- The regression now exercises the real current response/SSE facade/native path for incomplete and split-terminal SSE closeout while keeping only snapshot writer disabled for IO isolation.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 write-after-end broad bridge mock removed

- `tests/server/handlers/handler-response-sse-write-after-end.regression.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or declares legacy `importCoreDist` / `requireCoreDist` projection helpers.
- The regression now exercises the real current response/SSE facade/native path for closed-client and late-upstream SSE writes while keeping only snapshot writer disabled for IO isolation.
- Removed the stale `requires_action` output assertion that was only true under the deleted mock; this file now locks transport no-uncaught behavior and does not claim SSE/handler ownership of required_action semantics.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 SSE timeout broad bridge mock removed

- `tests/server/handlers/sse-timeout.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` for native error projection or snapshot hooks.
- The timeout regression now exercises the real current response/SSE facade/native path for stalled SSE stream timeout while keeping only snapshot writer disabled for IO isolation.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 request-timeout broad bridge mock removed

- `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or old handler-facing bridge helpers.
- The blackbox now exercises the real current request/response/SSE facade/native path for Responses request timeout and fast-stream completion while keeping only snapshot writer disabled for IO isolation.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 request-start-log broad bridge mock removed

- `tests/server/handlers/responses-handler.request-start-log.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or declares the local `readSessionToken` helper solely for that mock.
- The request-start logging spec still uses its local `responses-request-bridge.js` mock for handler log/session-color coverage, but now lets response dispatch use the real current response/SSE facade/native path.
- The local request bridge mock now includes current `requestContext.context.toolsRaw` shape so the spec does not rely on response projection failure side effects.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` / `resolveBaseDir` / broad bridge mock references returns zero matches.

### 2026-07-11 submit_tool_outputs SSE error broad bridge mock removed

- `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts` no longer mocks broad `src/modules/llmswitch/bridge.js` or root `src/modules/llmswitch/bridge.ts`.
- The regression keeps only current handler-facing `responses-request-bridge.js`, `responses-response-bridge.js`, `responses-sse-bridge.js`, `runtime-integrations.js`, and `native-exports.js` facade mocks needed for the SSE error path.
- The fixture mock covers the full `runtime-integrations.js` re-export surface required by `bridge.ts` link-time validation and uses only the current `native-exports.js` facade mock without restoring `importCoreDist`, `requireCoreDist`, `resolveImplForSubpath`, or `resolveBaseDir`.
- Exact file scan for legacy loader helpers, broad root bridge mock references, and root `bridge.ts` mock references returns zero matches.

### 2026-07-11 snapshot entry bucket root bridge import removed

- `src/debug/snapshot/writer.ts` now loads `writeSnapshotViaHooks` from `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root `src/modules/llmswitch/bridge.js` barrel.
- `tests/snapshot/entry-endpoint-bucket.spec.ts` now mocks the same narrow runtime integration facade and no longer mocks broad `bridge.js` / `bridge.ts`.
- The change preserves snapshot hook failure behavior while removing one production root-bridge dynamic import and one test root-bridge mock consumer.

### 2026-07-11 config/unified leaf root bridge imports removed

- Fifteen config, unified-hub, and sharedmodule leaf tests no longer import the root `src/modules/llmswitch/bridge.js` barrel for already-factored symbols.
- Config/routing symbols now import from `src/modules/llmswitch/bridge/routing-integrations.js`; snapshot recorder tests import from `snapshot-recorder.js`; the mimoweb native text harvest test imports from `native-exports.js`.
- `tests/unified-hub/policy-observe-shadow.spec.ts` now uses the real helper path `../helpers/native-hub-pipeline-test-wrapper.js` and supplies top-level `metadataCenterSnapshot.runtimeControl` required by the current Rust HubPipeline/VR metadata contract.
- Exact file scan across the touched test files returns zero root `src/modules/llmswitch/bridge.js` references, with focused Jest passing 15/15 suites and 80/80 tests.

### 2026-07-11 attachment history store facade import narrowed

- `tests/server/handlers/responses-handler.attachment-history-placeholder.blackbox.spec.ts` now imports Responses conversation store helpers from `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- The test captures the current handler handoff payload from `input.hubBody ?? input.body`, matching the request bridge contract where prepared Hub payload is separate from raw HTTP body.
- Exact file scan for root bridge and legacy loader helper references in the touched test returns zero matches; focused Jest passes 1/1.

### 2026-07-11 provider policy ingress root bridge import removed

- `src/providers/core/utils/provider-error-reporter.ts` now imports provider policy ingress functions from `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- Provider policy event types now come from the local llmswitch type contract, so this production error-chain caller no longer depends on the root bridge barrel for either runtime functions or types.
- `tests/providers/core/utils/provider-error-reporter.spec.ts` mocks the same narrow runtime integration facade, and `tests/providers/core/runtime/base-provider-success-report.spec.ts` no longer carries an obsolete root bridge mock.
- Exact file scan for root bridge and legacy loader helper references in the touched files returns zero matches; focused Jest passes 2/2 suites and 5/5 tests.

### 2026-07-11 provider outbound sanitizer and snapshot raw-port mocks narrowed

- `src/providers/core/runtime/http-request-executor.ts` now imports `sanitizeProviderOutboundPayload` from `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel.
- `tests/debug/snapshot-default-raw-port-contract.spec.ts` now mocks `writeSnapshotViaHooks` through `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- Exact file scan for root bridge and legacy loader helper references in the touched files returns zero matches; snapshot default raw/port focused Jest passes 5/5, `npx tsc --noEmit --pretty false` passes, and shell reference plus architecture gates pass.
- Attempted direct passthrough handler focused Jest was stopped after no output from its specific session; it is not used as passing evidence for this slice and `responses-provider.ts` remains a dedicated future production-root-import closeout candidate.

### 2026-07-11 finish-reason native export import narrowed

- `src/server/utils/finish-reason.ts` and checked-in `src/server/utils/finish-reason.js` now import `deriveFinishReasonNative` from `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel.
- This removes a production root-bridge dependency from server response closeout logging while keeping finish-reason derivation owned by the existing Rust/native helper.
- Exact file scan for root bridge and legacy loader helper references in the touched files returns zero matches; focused finish-reason Jest and architecture gates pass.

### 2026-07-11 provider logger and mimoweb native helper imports narrowed

- `src/debug/logger/provider-error.ts` now imports the `ProviderErrorEvent` type from `src/types/llmswitch-local-types.js` instead of the root bridge barrel.
- `src/providers/core/runtime/mimoweb/mimoweb-provider.ts` now imports `normalizeAssistantTextToToolCallsJson` from `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel, keeping text tool-call harvest on the Rust/native helper.
- `tests/providers/core/runtime/mimoweb-provider.unit.test.ts` now mocks the same narrow native-export facade and has a complete current provider-error-reporter mock surface for `BaseProvider` link-time validation.
- Exact file scan for root bridge and legacy loader helper references in the touched files returns zero matches; focused mimoweb Jest passes 9/9, `npx tsc --noEmit --pretty false` passes, and shell reference plus architecture gates pass.

### 2026-07-11 executor metadata and stage-recorder imports narrowed

- `src/server/runtime/http-server/executor-pipeline.ts` now imports `createSnapshotRecorder` from `src/modules/llmswitch/bridge/snapshot-recorder.js` instead of the root bridge barrel.
- `src/server/runtime/http-server/executor-metadata.ts` now imports `extractSessionIdentifiersFromMetadata` from `src/modules/llmswitch/bridge/state-integrations.js` instead of the root bridge barrel.
- Removed an unused root bridge namespace import from `src/server/runtime/http-server/daemon-admin/control-handler.ts`.
- `tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts` now mocks the same narrow snapshot-recorder facade.
- Exact file scan for root bridge and legacy loader helper references in the touched files returns zero matches; executor-pipeline and executor-metadata focused Jest passes, `npx tsc --noEmit --pretty false` passes, and shell reference plus architecture gates pass. `tests/server/runtime/http-server/daemon-admin-routes.auth.spec.ts` still has a pre-existing config-write 500 in its config editor case and is not used as passing evidence for this slice.

### 2026-07-11 provider response converter production root import narrowed

- `src/server/runtime/http-server/executor/provider-response-converter.ts` now imports `convertProviderResponse` from `src/modules/llmswitch/bridge/response-converter.js` and `createSnapshotRecorder` from `src/modules/llmswitch/bridge/snapshot-recorder.js` instead of the root bridge barrel.
- Focused provider response converter tests now mock those two narrow facades directly for error logging, MetadataCenter provider protocol, and stopless runtime sync coverage.
- Production root bridge scan now reports only `src/providers/core/runtime/responses-provider.ts`, `src/server/runtime/http-server/index.ts`, and `src/server/runtime/http-server/request-executor.ts` as remaining root bridge importers.
- Verification passed: focused Jest 3 suites / 8 tests, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.
- Boundary: some provider response converter focused tests still carry root bridge mocks for adjacent not-yet-narrowed symbols; those are test debt for the next cleanup wave, not production import evidence for this slice.

### 2026-07-11 request executor continuation helper import narrowed

- `src/server/runtime/http-server/request-executor.ts` now imports Responses continuation request helpers from `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- Exact file scan for root bridge and legacy loader helper references in `request-executor.ts` returns zero matches, and production root bridge scan is reduced to `src/providers/core/runtime/responses-provider.ts` plus `src/server/runtime/http-server/index.ts`.
- Verification passed: provider-owned continuation reroute blackbox Jest 2/2, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), and touched-file `git diff --check`.
- Boundary: `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts` still has a broad native-exports mock surface and failed link-time when run as a broader batch; it is not used as passing evidence for this one-line production import slice.

### 2026-07-11 production root bridge imports reduced to zero

- `src/server/runtime/http-server/index.ts` now imports Responses continuation store helpers from `src/modules/llmswitch/bridge/runtime-integrations.js` and `isToolCallContinuationResponseNative` from `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel.
- `src/providers/core/runtime/responses-provider.ts` now imports `buildResponsesJsonFromSseStreamWithNative` from `runtime-integrations.js`, and direct request normalization / outbound sanitization from `native-exports.js` instead of the root bridge barrel.
- `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` now mocks the same narrow facades directly, using provider-test-only fake facade helpers for link-time surface completeness without importing the broad root bridge.
- Exact production scan across `src/providers src/debug src/client src/server src/modules` now returns zero root `src/modules/llmswitch/bridge.js` or `.ts` importers.
- Verification passed: focused Jest 2 suites / 22 tests (`responses-provider.direct-passthrough`, `hub-policy-injection`), `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only).
- Boundary: `responses-provider-direct-stream-incomplete` and broad `protocol-http-providers` still expose older provider test assumptions when migrated to narrow facades; they were restored and are not used as passing evidence for this production root-import closeout slice.

### 2026-07-11 type-only bridge imports moved to local type contract

- `src/manager/modules/health/index.ts`, `src/tools/stats-request-events.ts`, and `src/tools/stats-usage.ts` now import `ProviderErrorEvent` / `ProviderUsageEvent` from `src/types/llmswitch-local-types.js` instead of the root bridge barrel.
- Exact scans for root bridge imports and legacy loader helper names in the touched files return zero matches.
- Verification passed: `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), and `verify:function-map-compile-gate`.

### 2026-07-11 responses-to-chat production import narrowed

- `src/utils/responses-to-chat.ts` now imports `convertResponsesRequestToChatNative` from `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel.
- This closes the production `src/utils` root-bridge importer missed by the earlier `src/providers src/debug src/client src/server src/modules` production scan, without moving Responses-to-Chat request semantics out of the existing Rust/native codec owner.
- Exact production scan across tracked `src/**` now reports only `src/modules/README.md` as a root bridge text reference and no production code importers.
- Verification passed: `tests/utils/responses-to-chat-native.spec.ts` 6/6, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.

### 2026-07-11 continuation provider-key blackbox script import narrowed

- `scripts/tests/responses-continuation-provider-key-blackbox.mjs` now imports `captureResponsesRequestContextForRequest` and `recordResponsesResponseForRequest` from `dist/modules/llmswitch/bridge/runtime-integrations.js` instead of the root `dist/modules/llmswitch/bridge.js` barrel.
- The script-level exact scan for root bridge, legacy loader helpers, and `dist/modules/llmswitch/bridge.js` references now returns zero matches.
- Verification passed: `RCC_CONTINUATION_SCENARIO=relay node scripts/tests/responses-continuation-provider-key-blackbox.mjs`, `npm run build:base`, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.
- Boundary: full `node scripts/tests/responses-continuation-provider-key-blackbox.mjs` still fails before the relay branch because the direct child currently routes the continuation to `p2` instead of the expected pinned `p1`; that pre-existing behavioral failure is not used as passing evidence for this import-narrowing slice.

### 2026-07-11 app stop retention test bridge mock narrowed

- `tests/cli/routecodex-app-stop.responses-store-retention.spec.ts` now mocks `clearAllResponsesConversationState` through `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- This keeps the test focused on the app stop retention contract while removing one test-only root bridge consumer; `RouteCodexApp.stop()` behavior and Responses store semantics are unchanged.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 1/1, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.

### 2026-07-11 HTTP error mapper native projection mock narrowed

- `tests/server/utils/http-error-mapper-native-projection.spec.ts` now mocks `projectSseErrorEventPayloadNative` through `src/modules/llmswitch/bridge/native-exports.js` instead of the root bridge barrel.
- This keeps ErrorErr06 client projection owned by `src/server/utils/http-error-mapper.ts` while removing one test-only root bridge consumer.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 1/1, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:error-pipeline-contract`, `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.

### 2026-07-11 snapshot writer payload guard mock narrowed

- `tests/server/utils/snapshot-writer.payload-guard.spec.ts` now mocks `writeSnapshotViaHooks` through `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- This keeps snapshot hook observation on the current runtime integration facade and removes one test-only root bridge consumer without changing snapshot writer behavior.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 3/3 with 2 skipped existing tests, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.

### 2026-07-11 provider SSE snapshot mock narrowed

- `tests/providers/core/utils/snapshot-writer.sse-error-propagation.spec.ts` now mocks `writeSnapshotViaHooks` through `src/modules/llmswitch/bridge/runtime-integrations.js` instead of the root bridge barrel.
- This follows the existing provider snapshot test pattern and removes one more test-only root bridge consumer while preserving the SSE error/close propagation assertions.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 2/2, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.

### 2026-07-11 dual-port stopless routing import narrowed

- `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts` now imports `bootstrapVirtualRouterConfig` from `src/modules/llmswitch/bridge/routing-integrations.js` instead of the root bridge barrel.
- This keeps VR bootstrap on the existing Rust/NAPI routing facade and removes one leaf test root bridge consumer without changing stopless/servertool behavior.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 3/3, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.
- Boundary: `responses-handler.routing-empty-pool.spec.ts` and `responses-handler.provider-outbound-reasoning.blackbox.spec.ts` remain future candidates because focused runs expose pre-existing fixture contract gaps around `NativeHubPipelineTestWrapper` pathing and current Rust `metadataCenterSnapshot` requirements; they were restored and are not included in this passing slice.

### 2026-07-11 provider composite guard runtime import narrowed

- `tests/provider/provider-composite-guards.test.ts` now mocks provider policy ingress through `src/modules/llmswitch/bridge/runtime-integrations.ts` instead of the root bridge barrel.
- The test now uses the current explicit `recoverable` / `affectsHealth` error reporter contract and keeps its original assertion that provider errors go to router policy instead of `errorHandlingCenter` fallback.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 2/2, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.
- Boundary: `responses-provider-direct-stream-incomplete.spec.ts` was checked and restored; after moving it to narrow facades it exposes a direct SSE passthrough behavioral assertion mismatch, so it needs a separate contract/test slice rather than being included in this reference-only cleanup.

### 2026-07-11 responses debug diag request bridge mock narrowed

- `tests/server/handlers/responses-handler.debug-diag.spec.ts` now mocks `src/modules/llmswitch/bridge/responses-request-bridge.js` instead of the root bridge barrel.
- The local mock surface was reduced to the current handler request-bridge imports and updated to return the current `prepareResponsesHandlerRuntimeForHttp` / stream-plan shape needed by the handler.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 1/1, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, and `verify:function-map-compile-gate`.
- Boundary: `protocol-http-providers.unit.test.ts` was checked and restored; splitting its root mock exposes provider snapshot entry-port fixture gaps, so it needs a separate provider snapshot contract slice rather than being included in this reference-only cleanup.

### 2026-07-11 provider outbound param stale bridge mock removed

- `tests/provider/provider-outbound-param.test.ts` no longer mocks the root `src/modules/llmswitch/bridge.ts` barrel with stale symbols that the current bridge no longer exports.
- The provider implementations under test already import the current narrow facades (`runtime-integrations.js`, `native-exports.js`, and provider snapshot writer), so the old root bridge mock was dead test scaffolding rather than an active runtime consumer.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest loads the file but remains skipped because no local codex sample aggregates are present; this is reference-cleanup evidence only, not outbound behavior evidence. Full static/architecture gates are tracked by the slice commit.

### 2026-07-11 direct boundary tests legacy loader field removed

- `tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts` and `tests/server/runtime/http-server/direct-server-contract.red.spec.ts` no longer expose the retired `resolveBaseDir` helper from their `routing-integrations.js` mocks.
- Both tests already mock the current routing facade surface and do not need the old module-loader API; this removes two test-only legacy helper consumers without changing direct/router behavior.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 2/2 suites, 16/16 tests. Boundary: `direct-passthrough-route-level.spec.ts` and `http-server-runtime-setup.provider-merge.spec.ts` were checked and restored because their focused runs expose pre-existing behavior/fixture failures unrelated to this reference-only cleanup.

### 2026-07-11 responses store cleanup loader field removed

- `tests/server/runtime/http-server/request-executor.responses-store-cleanup.spec.ts` no longer exposes the retired `resolveBaseDir` helper from its `routing-integrations.js` mock.
- The test already imports the current Responses conversation store host and routing facade directly, so the old module-loader field was dead mock surface.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 1/1 suite, 5/5 tests. The run still emits the existing non-blocking provider snapshot `entryPort required` warning, which is unrelated to this reference-only cleanup.

### 2026-07-11 provider response metadata protocol mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.metadata-center-provider-protocol.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` barrel or declares legacy `importCoreDist`.
- The production converter already imports its active collaborators through `response-converter.js` and `snapshot-recorder.js`; the removed root barrel mock was dead test surface.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.
- Verification passed: focused Jest 1/1 suite, 1/1 test.

### 2026-07-11 provider response error logging mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.error-logging.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` barrel or declares legacy `requireCoreDist` / `importCoreDist`.
- The production converter imports only `response-converter.js` and `snapshot-recorder.js` for this path; the removed root barrel mock was dead test surface.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.

### 2026-07-11 provider response stopless sync mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` / `.ts` barrels.
- The spec already mocks the active collaborators through `response-converter.js` and `snapshot-recorder.js`; the removed root barrel mock was dead test surface.
- Exact file scan for root bridge and legacy loader helper references returns zero matches.

### 2026-07-11 request executor reroute loader helper residue removed

- `tests/server/runtime/http-server/request-executor.pre-send-reroute.spec.ts` and `tests/server/runtime/http-server/request-executor.rebind-failfast.spec.ts` no longer expose retired `resolveBaseDir` or `importCoreDist` helper fields from their bridge/routing mocks.
- The specs still keep only the explicit request-executor runtime mocks needed for reroute/rebind behavior; no TS semantic owner or legacy loader path was added.
- Exact file scan for `importCoreDist` / `resolveBaseDir` in both specs returns zero matches.

### 2026-07-11 hub policy injection loader helper residue removed

- `tests/server/http-server/hub-policy-injection.spec.ts` no longer exposes retired `resolveBaseDir`, `importCoreDist`, or `requireCoreDist` helper fields from its bridge/routing mocks.
- The spec still mocks only the current routing/runtime surfaces required to observe hub policy injection; no TS semantic owner or legacy loader path was added.
- Exact file scan for `importCoreDist` / `requireCoreDist` / `resolveBaseDir` in the spec returns zero matches.

### 2026-07-11 request executor reroute root bridge mock removed

- `tests/server/runtime/http-server/request-executor.pre-send-reroute.spec.ts` and `tests/server/runtime/http-server/request-executor.rebind-failfast.spec.ts` no longer mock the root `src/modules/llmswitch/bridge.js` / `.ts` barrels.
- Both specs keep only the current `routing-integrations` and `runtime-integrations` submodule mocks needed by `request-executor.ts`; no root bridge consumer or TS semantic owner was restored.
- Exact file scan for root bridge imports/mocks and legacy loader helpers in both specs returns zero matches.

### 2026-07-11 hub policy root bridge path mock removed

- `tests/server/http-server/hub-policy-injection.spec.ts` no longer registers root `src/modules/llmswitch/bridge.ts` or `bridge/index.ts` mocks.
- The spec keeps only the directly used `routing-integrations`, `runtime-integrations`, and `hub-pipeline-handle` mocks, deleting the unused broad root bridge mock surface.
- Exact file scan for root bridge paths and legacy loader helpers in the spec returns zero matches.

### 2026-07-11 root bridge documentation references narrowed

- `src/modules/README.md`, `docs/responses-generic-provider.md`, `sharedmodule/llmswitch-core/README.md`, and `sharedmodule/llmswitch-core/docs/server-sse-refactor-plan.md` no longer describe `src/modules/llmswitch/bridge.ts` or `dist/modules/llmswitch/bridge.js` as the active Hub Pipeline entrypoint.
- The docs now describe the current boundary: Rust/NAPI owns Hub Pipeline semantics, and Host code may only use approved `src/modules/llmswitch/bridge/*.ts` thin IO/native-binding shells.
- Exact file scan for root bridge paths and legacy loader helpers in the touched docs returns zero matches.
- Verification passed: `git diff --check`, `npx tsc --noEmit --pretty false`, strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only), `verify:architecture-deleted-path`, `verify:architecture-thin-wrapper-only`, `verify:function-map-compile-gate`, and `npm run build:base`.

### 2026-07-11 responses bridge function-map root path allowance removed

- `docs/architecture/function-map.yml` no longer lists `src/modules/llmswitch/bridge.ts` or `src/modules/llmswitch/bridge/index.ts` as allowed paths for `server.responses_request_handler_bridge_surface`, `server.responses_sse_bridge_surface`, or `server.responses_response_handler_bridge_surface`.
- The allowed paths now name only the concrete owner submodules plus handler/gate/doc surfaces, matching the current root-bridge closeout direction.
- Exact function-map scan for the retired root bridge allowed paths returns zero matches.
- Verification passed: `npm run verify:server-function-map-boundary`, `npm run verify:function-map-compile-gate`, and strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only).

### 2026-07-11 stale session-daemon bootstrap test deleted

- Physically deleted `tests/server/http-server/http-server-session-daemon.bootstrap.spec.ts`.
- The spec was a stale clock/heartbeat bootstrap test left after `refactor: remove clock heartbeat features`; its only exercised symbol, `tickSessionDaemonInjectLoop`, no longer exists, and it carried an empty root `src/modules/llmswitch/bridge.js` / `.ts` mock solely as dead scaffolding.
- Exact repo scan for `http-server-session-daemon.bootstrap` / `tickSessionDaemonInjectLoop` now has no active source references after deletion.
- The still-live `tests/server/http-server/http-server-session-daemon.spec.ts` covers the remaining exported `extractWorkdirHintFromReservationTasks` helper and passes 3/3.

### 2026-07-11 responses provider outbound reasoning root bridge import removed

- `tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts` no longer imports the root `src/modules/llmswitch/bridge.js` barrel and no longer uses the stale out-of-tree helper path.
- The spec now imports `bootstrapVirtualRouterConfig` from `src/modules/llmswitch/bridge/routing-integrations.js` and the real `tests/helpers/native-hub-pipeline-test-wrapper.js` helper path.
- `tests/helpers/native-hub-pipeline-test-wrapper.ts` exposes the native pipeline handle for request-executor style tests without adding MetadataCenter writeback or TS runtime semantics.
- The streamed `/v1/responses` test input now supplies top-level `metadataCenterSnapshot.runtimeControl` required by the Rust HubPipeline/VR metadata contract and returns a real `sseStream` for a streaming client request.
- Exact file scan for root bridge paths, stale helper path, and legacy loader helpers in the touched files returns zero matches.
- Verification passed: focused Jest 1/1 suite, 1/1 test; strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only).

### 2026-07-11 provider response finish-reason mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.finish-reason.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` / `.ts` barrels and no longer declares legacy `importCoreDist` / `requireCoreDist` loader helpers.
- The spec now mocks only the active production collaborators, `bridge/response-converter.js` and `bridge/snapshot-recorder.js`; finish-reason derivation runs through the current `server/utils/finish-reason.ts` native wrapper instead of a test-local TS copy.
- Exact file scan for root bridge paths, legacy loader helpers, and the retired `syncReasoningStopModeFromRequest` mock returns zero matches.
- Verification passed: focused Jest 1/1 suite, 5/5 tests; strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only); `verify:architecture-deleted-path`; `verify:architecture-thin-wrapper-only`; `verify:function-map-compile-gate`; `npm run build:base`; touched-file `git diff --check`.

### 2026-07-11 provider response prebuilt SSE mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` / `.ts` barrels, `bridge/index`, or `bridge/module-loader`.
- The spec now mocks only the active production collaborators, `bridge/response-converter.js` and `bridge/snapshot-recorder.js`; removed legacy `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` helpers and the test-local `deriveFinishReasonNative` copy.
- Exact file scan for root bridge paths and legacy loader helpers in the touched spec returns zero matches.
- Verification passed: focused Jest 1/1 suite, 5/5 tests; strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only); `verify:architecture-deleted-path`; `verify:architecture-thin-wrapper-only`; `verify:function-map-compile-gate`; `npm run build:base`; touched-file `git diff --check`.

### 2026-07-11 provider response unified semantics mock narrowed

- `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` / `.ts` barrels, `bridge/index`, or `bridge/module-loader`.
- The spec now mocks only the active production collaborators, `bridge/response-converter.js` and `bridge/snapshot-recorder.js`; removed legacy `importCoreDist` / `requireCoreDist` / `resolveImplForSubpath` helpers and test-local TS copies of finish-reason, direct-chat SSE reprojection, and Responses tool-argument normalization logic.
- Exact file scan for root bridge paths, legacy loader helpers, and retired mock symbols in the touched spec returns zero matches.
- Verification passed: focused Jest 1/1 suite, 19/19 tests; strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only); `verify:architecture-deleted-path`; `verify:architecture-thin-wrapper-only`; `verify:function-map-compile-gate`; `npm run build:base`; touched-file `git diff --check`.

### 2026-07-11 handler SSE finish-reason mock surface removed

- `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` no longer mocks the root `src/modules/llmswitch/bridge.js` barrel and no longer declares legacy `importCoreDist` / `requireCoreDist` projection helpers.
- Removed the spec-local `createMockCoreDistProjectionModule` TS projection copy and the broad root bridge mock blocks; the spec now exercises the real handler path with only snapshot-writer IO isolation where needed.
- Two assertions were narrowed back to the transport layer they actually cover: client-close destroys upstream during Responses SSE transport, and required_action client close must not become a transport error. Continuation persistence remains owned by Chat Process / bridge/Rust gates, not this handler SSE spec.
- Exact file scan for root bridge paths, legacy loader helpers, and retired local helper symbols in the touched spec returns zero matches.
- Verification passed: focused Jest 1/1 suite, 24/24 tests; strict shell reference audit (`prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`, `coreModuleSubpathRefs=2` both note-only); `verify:architecture-deleted-path`; `verify:architecture-thin-wrapper-only`; `verify:function-map-compile-gate`; `npm run build:base`; touched-file `git diff --check`.
