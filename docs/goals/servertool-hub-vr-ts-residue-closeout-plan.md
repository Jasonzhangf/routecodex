# Servertool / Hub Pipeline / Virtual Router TS Residue Closeout Plan

## Goal

Close remaining TypeScript residue across servertool, Hub Pipeline, and Virtual Router from easiest to most complex while preserving RouteCodex's single runtime truth:

`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`

Rust remains the semantic owner. TypeScript may remain only for public API barrels, native marshal, Node/HTTP/file/stream IO, admin presentation, and explicitly documented thin host effects.

## Acceptance Criteria

- Servertool active TS shells are reduced to unavoidable IO/native dispatch only.
- Hub Pipeline response/request orchestration has no duplicated protocol, servertool, routing, provider-response, or effect-plan semantics in TS.
- Virtual Router runtime remains TS-free by gate; remaining TS config/admin surfaces are either moved to Rust or explicitly bounded as authoring/admin IO with gates.
- Function map, mainline call map, verification map, wiki/manifest review surfaces stay synchronized.
- No fallback, silent salvage, duplicate semantic owner, provider-specific Hub/VR branch, or MetadataCenter data-plane misuse is introduced.
- Completion is claimed only after required tests, architecture gates, build gates, and representative live/replay validation pass.

## Current Evidence Baseline

- `node scripts/verify-servertool-rust-only.mjs` currently passes and reports servertool Rust-only invariants hold.
- `node scripts/architecture/verify-vr-no-ts-runtime.mjs` currently passes with `VR production TS files: 0`.
- `node scripts/architecture/verify-vr-no-fallback-semantics.mjs` currently passes.
- Servertool TS residue: `sharedmodule/llmswitch-core/src/servertool/**/*.ts`, about 2409 LOC.
- Hub Pipeline TS residue: `sharedmodule/llmswitch-core/src/conversion/hub/**/*.ts`, about 2725 LOC.
- Virtual Router wrapper/config/admin TS residue: native wrappers/contracts about 1912 LOC; runtime/config/admin surfaces about 2366 LOC.

Do not treat this baseline as final proof. Re-run the commands in the active worktree before each closeout claim.

## Scope

In scope:

- `sharedmodule/llmswitch-core/src/servertool/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/*virtual-router*.ts`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-*.ts`
- `src/config/virtual-router-*`
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `src/server/runtime/http-server/**/routing*`
- Architecture docs and gates under `docs/architecture/**`, `docs/goals/**`, and `scripts/architecture/**`
- Focused tests under `tests/servertool/**`, `tests/sharedmodule/**`, `tests/server/**`, `tests/cli/**`

Out of scope unless directly required by closeout:

- Provider-specific runtime behavior unrelated to Hub/VR/servertool boundaries.
- SSE rustification beyond interactions needed by Hub response transport.
- Broad config migration or release publishing.
- Destructive cleanup of unrelated dirty work.

## Design Principles

- Rust owns semantics; TS applies native plans or performs IO only.
- Every removed TS semantic must be replaced by one Rust owner and one native wrapper path, not by a second TS helper.
- Delete physically after migration; do not leave unused alternate implementations.
- Prefer small verified slices. Commit each verified slice if the worktree allows relevant-only staging.
- If the same failure repeats twice, stop retrying locally and research alternative approaches before continuing.
- For runtime-impacting changes, local tests are not enough; replay or live validation is required before claiming closeout.

## Phase Order

### Phase 1: Servertool IO Thin-Shell Tightening

Difficulty: easiest.

Target files:

- `sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/log/progress-file.ts`
- `sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts`
- `sharedmodule/llmswitch-core/src/servertool/*-shell.ts`

Tasks:

- Identify every remaining TS `switch` over native action plans and classify it as IO dispatch, native marshal, or semantic branching.
- Move semantic classification, result-mode decisions, error projection, queue/stage decisions, and MetadataCenter write-plan construction to Rust if any remain.
- Keep TS only for async handler invocation, file/console/stageRecorder IO, timer setup, and native plan application.
- Add or strengthen gate markers so removed TS semantics cannot return.
- Delete obsolete tests or helpers that only validate old TS semantics.

Required verification:

- Focused Jest for touched servertool shells.
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

Completion signal:

- Servertool TS residue report shows only IO/native marshal/action application remains, with gate coverage for every removed semantic marker.

### Phase 2: Hub Pipeline Provider-Response Effect Application

Difficulty: medium.

Target files:

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-helpers.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`

Tasks:

- Separate pure IO from response semantics in `provider-response.ts`.
- Move effect-plan normalization, provider response materialization decisions, servertool response-stage routing decisions, response recording decisions, and error projection decisions into Rust/native plans where any remain in TS.
- Keep TS for Node stream/SSE transport, snapshot file IO, stage timing/logging, and invoking servertool shell/native wrappers.
- Ensure `resp_chatprocess save -> immutable store interval -> req_chatprocess restore` remains untouched by handler/SSE/outbound logic.
- Update mainline call map if caller/callee edges move.

Required verification:

- Focused Hub response/provider-response Jest tests.
- Relevant servertool response-stage tests if touched.
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-review-surface-light`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `npx tsc --noEmit --pretty false`
- `git diff --check`

Completion signal:

- `provider-response.ts` is reduced to IO/native dispatch/observability; no TS-owned protocol projection, servertool decision, response repair, fallback, or provider-specific branch remains.

### Phase 3: Hub Pipeline Runtime Class and Request Stage Shell

Difficulty: medium-high.

Target files:

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing*.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/*.ts`

Tasks:

- Audit HubPipeline class responsibilities and isolate dependency injection, native runtime registration, and timing/debug IO from request/route/provider semantics.
- Move request-stage native plan validation and MetadataCenter control policy decisions to Rust if TS still owns branching beyond fail-fast shape checks.
- Keep TS for class construction, dependency wiring, native wrapper calls, and timing/debug IO only.
- Update docs/gates to define allowed Hub Pipeline TS residue precisely.

Required verification:

- Focused Hub Pipeline request-stage tests.
- VR selection smoke/unit tests if route bridge edges move.
- `npm run verify:servertool-rust-only`
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:vr-no-fallback-semantics`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `npx tsc --noEmit --pretty false`
- `git diff --check`

Completion signal:

- HubPipeline TS is a runtime shell: construction, IO, dependency injection, timing/debug, and native calls only.

### Phase 4: Virtual Router Config/Admin/Host-Effects Boundary

Difficulty: high.

Target files:

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts`
- `src/config/virtual-router-builder.ts`
- `src/server/runtime/http-server/daemon-admin/routing-policy.ts`
- `src/server/runtime/http-server/daemon-admin/providers-handler-routing-utils.ts`

Tasks:

- Preserve the current invariant: no production TS runtime selection/fallback semantics.
- Classify remaining TS as native wrapper, deterministic config authoring, admin presentation, hit-log IO, or host effect.
- Move any route selection, pool availability, fallback/default floor, provider exhaustion, or dry-run semantic currently found in config/admin TS into Rust.
- Gate admin/config TS so it cannot become a runtime semantic owner.
- If config builder remains TS, document it as authoring/compile surface and ensure runtime consumes compiled deterministic manifest/config only.

Required verification:

- `node scripts/architecture/verify-vr-no-ts-runtime.mjs`
- `node scripts/architecture/verify-vr-no-fallback-semantics.mjs`
- VR focused Rust tests for touched route/config semantics.
- VR diagnostics/dry-run tests if admin output changes.
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false`
- `git diff --check`

Completion signal:

- VR report shows runtime semantics are Rust-only; any remaining TS is explicitly bounded to wrapper/config authoring/admin IO with gates.

### Phase 5: Aggregate Validation and Live/Replay Closeout

Difficulty: highest because it proves integration.

Required verification:

- All phase-specific focused tests.
- `npm run verify:servertool-rust-only`
- `node scripts/architecture/verify-vr-no-ts-runtime.mjs`
- `node scripts/architecture/verify-vr-no-fallback-semantics.mjs`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-review-surface-light`
- `npm run verify:architecture-wiki-html-sync`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `npx tsc --noEmit --pretty false`
- `npm run build:base`
- `git diff --check`

Live/replay evidence:

- Rebuild/restart using the project-approved routecodex flow for the target port.
- Validate `/health`.
- Run at least one representative servertool/stopless request through the same runtime entry.
- Run at least one VR status/dry-run or live routed request that proves route selection still uses Rust truth.
- Run one representative Hub Pipeline request/response path that exercises response-stage/servertool or provider-response materialization.
- Capture sample paths/log lines used as proof.

Completion signal:

- Final report includes changed files, deleted TS semantics, remaining allowed IO TS residue, exact test/gate/live evidence, and residual risks.

## Risk Matrix

- Risk: TS shell dispatch accidentally remains semantic.
  Mitigation: add source-marker gates and red tests before migration.

- Risk: MetadataCenter becomes data-plane fallback.
  Mitigation: enforce carrier-only control semantics and fail-fast shape checks.

- Risk: VR admin/config cleanup changes runtime route behavior.
  Mitigation: keep runtime gate green and validate online status/dry-run.

- Risk: Hub response cleanup breaks streaming/SSE or continuation immutable interval.
  Mitigation: run response-stage, SSE, and representative live stream tests.

- Risk: Dirty worktree contaminates commits.
  Mitigation: stage only verified relevant paths; never stage all.

## Documentation Updates

For each phase that changes owners or edges, update:

- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- Relevant wiki/manifest artifacts generated by the project renderer.
- `note.md` for working evidence.
- `MEMORY.md` or rcc lessons only for verified reusable conclusions.

## Done Definition

The closeout is done only when:

- No active TS semantic owner remains for servertool, Hub Pipeline response/request semantics, or VR runtime selection/fallback.
- Remaining TS residue is explicitly categorized as IO/native marshal/public shell/admin authoring and protected by gates.
- Aggregate build/test/gate/live evidence passes in the active worktree.
- Obsolete TS implementations and tests are physically removed.
- Final report states what changed, how it was verified, what TS remains by design, and any unresolved risk.
