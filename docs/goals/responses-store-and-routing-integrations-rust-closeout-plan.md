# Responses Store And Routing Integrations Rust Closeout Plan

## Goal And Acceptance Criteria

Close the remaining Rustification blockers in:

- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts`
- `src/modules/llmswitch/bridge/routing-integrations.ts`

Acceptance criteria:

- Responses conversation store state, indexes, persistence eligibility, prune lifecycle, capture, record, resume, materialize, scope attach/detach, and missing-context decisions are Rust-owned.
- The TS responses store host file is either physically deleted or collapsed to a minimal native-call and host-IO shell with no store semantics.
- `routing-integrations.ts` is no longer a wide mixed bridge. It is split or collapsed into narrow owner-aligned host bridges.
- Config materialization, HubPipeline native handle lifecycle, Virtual Router route/hit projection, path/env planning, and host-effects planning are owned by their Rust modules.
- TS may only apply returned host effects, pass host env/time, call native functions, and perform unavoidable Node IO.
- No fallback, compatibility dual path, TS semantic duplicate, provider-specific branch, or deleted TS wrapper resurrection is introduced.
- Function map, mainline call map, verification map, and residue gates reflect the final owner paths.

## Scope And Boundaries

In scope:

- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts`
- `src/modules/llmswitch/bridge/responses-conversation-store-host.js` if it is checked in and still used
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `src/modules/llmswitch/bridge/routing-integrations.js` if it is checked in and still used
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_engine/registry.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/runtime_config_materialization.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_file_codec.rs`
- Rust NAPI export registry and `native-hotpath-required-exports.json`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- focused tests and residue gates tied to these owners

Out of scope:

- Changing provider routing policy, provider config semantics, or user config values.
- Reworking server handlers, SSE transport, direct passthrough, or provider runtimes except where an existing caller must be redirected to the new bridge boundary.
- Reintroducing old llmswitch-core TS native wrappers.
- Adding fallback or best-effort behavior for missing native capabilities.
- Claiming live runtime closure without global install plus managed live replay evidence.

## Current Evidence Baseline

Known owner locks:

- `conversion.responses.store` is mapped to Rust owner `shared_responses_conversation_utils.rs`.
- `hub.chat_process_responses_continuation` is Rust-owned through the same responses conversation utilities and request/response Chat Process boundaries.
- `hub.runtime_ingress_bridge` is mapped to Rust owner `hub_pipeline_engine/registry.rs`.
- `config.user_config_materialization` is mapped to Rust owner `runtime_config_materialization.rs` plus `config_file_codec.rs`.
- `vr.hit_log_projection` is mapped to Rust owner `virtual_router_hit_log.rs`.

Current blocker shape:

- `responses-conversation-store-host.ts` still owns live TS `Map` indexes, persistence file IO, prune timer, singleton lifecycle, and attach/detach execution around native semantic plans.
- `routing-integrations.ts` currently combines config native bridge, HubPipeline native handle bridge, Virtual Router route/hit host effects, stop-message marker parsing helpers, path/env helpers, and host logging side effects.
- Previous shell-reference closeout removed old llmswitch-core TS facades, but these two host files still need structural closeout before the TS surface can approach zero.

## Design Principles

- Rust/native binding is the only semantic runtime truth.
- TS host files may do Node process/env/time/FS/log emission only when that IO cannot live in Rust.
- Any TS-host action must be driven by an explicit Rust plan, not local inference.
- Store lifecycle decisions must be action-specific Rust plans. Do not reintroduce generic TS-callable isolation or continuation helpers.
- Route hit formatting, reason projection, color/session key selection, and telemetry payload shaping stay Rust-owned.
- Config materialization and HubPipeline handle lifecycle failures must fail fast.
- Delete verified-dead code physically. Do not leave disabled imports, commented fallbacks, or compatibility branches.
- Keep direct/provider passthrough boundaries unchanged.

## Technical Plan

### 1. Responses Store Full Rust State

Move the current store state machine behind Rust NAPI operations:

- `requestMap`
- `responseIndex`
- `scopeIndex`
- persisted entry load/flush eligibility and shaping
- capture request context
- record response
- resume by response id
- latest continuation resume/materialize by scope
- attach entry scopes
- detach request ids
- release request payload
- clear unresolved requests
- prune expired entries
- singleton/timer lifecycle decisions

Target shape:

- Rust owns the store state and returns operation results as JSON.
- TS exposes only a thin host shell if process lifecycle or file path wiring still requires Node.
- If persistence remains host FS IO, Rust must own the load/flush plan and entry validation; TS only reads/writes the exact file requested by the plan.
- If persistence can move fully to Rust without breaking install packaging or path ownership, delete the TS host file.

Required red locks:

- Missing request context must short-circuit with the official Responses-style error projection, not wait for provider timeout.
- Direct and relay continuation owners must not cross.
- Entry protocol, continuation owner, port/group, and session/conversation scope must all be part of restore isolation.
- Released input prefix must not become live current input.
- Duplicate pending tool-call batches and stale stopless history must not be resurrected.

### 2. Routing Integrations Split By Owner

Split or collapse `routing-integrations.ts` into narrow bridges:

- config native bridge: only host env/path input and calls to Rust config materialization.
- HubPipeline native bridge: create/execute/update/dispose native engine handles only.
- Virtual Router route bridge: call Rust route selection and consume structured result.
- Virtual Router hit-log host effect bridge: ask Rust for hit record/log/telemetry/color/session projection, then emit returned host effects.
- RCC path/env bridge: pass process env/user dir/base dir to Rust planner; TS must not encode config semantics.

Target shape:

- No aggregate "routing-integrations" semantic bucket remains.
- Any remaining file name is a narrow compatibility barrel or native-call shell only.
- Host effects are explicit data returned by Rust. TS applies them without recomputing route/hit/session semantics.

Required red locks:

- Route selection is not duplicated in TS.
- Virtual Router hit logs are still emitted for direct and relay paths.
- Same session id produces the same color across request start, VR hit, usage, response, and failure logs.
- Missing native HubPipeline/VR/config capability fails fast.
- Deleted aggregate TS wrappers stay physically absent.

### 3. Map And Gate Synchronization

Update architecture truth with the new final paths:

- Function map: owner, allowed paths, forbidden paths, canonical builders.
- Mainline call map: adjacent caller/callee edges only.
- Verification map: exact required tests and gates for each touched feature.
- Residue audit: old paths and old local semantics must be forbidden.
- Minimal TS surface/rustification audit: baseline must shrink or explain remaining host IO shell explicitly.

## File Checklist

Primary source:

- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts`
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- checked-in `.js` companions for the two files, if still present
- Rust files listed in the scope section
- NAPI export registry and required export manifest

Architecture and tests:

- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `tests/sharedmodule/responses-continuation-store.spec.ts`
- `tests/sharedmodule/responses-openai-bridge-metadata-boundary.spec.ts`
- `tests/modules/llmswitch/bridge/responses-openai-bridge.spec.ts`
- `tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`
- `tests/sharedmodule/virtual-router-hit-log.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
- config and runtime setup tests mapped in `verification-map.yml`

## Risks And Controls

- Risk: moving the store state into Rust changes retention or scope behavior.
  Control: preserve current action-plan semantics with red/green tests before replacing the TS Map/index implementation.

- Risk: persistence path ownership crosses user data directory boundaries.
  Control: Rust must consume explicit host path/env inputs and return explicit IO plans or perform only verified path-resolved writes.

- Risk: splitting `routing-integrations.ts` breaks existing import barrels.
  Control: keep a temporary narrow barrel only if needed, then delete it after all call sites move.

- Risk: checked-in JS drifts from TS.
  Control: update checked-in JS companions in the same slice or prove they are generated/stale before deletion.

- Risk: old shell paths survive through package exports or tests.
  Control: exact reference scans plus residue gates before claiming deletion.

- Risk: a source-only gate passes while installed runtime is stale.
  Control: if runtime behavior is touched, run build, release/global install, managed restart, health version check, and live replay.

## Verification Matrix

Minimum for source-only batches:

- focused Rust unit tests for changed Rust modules
- `npm run build:native-hotpath`
- focused Jest for responses store, routing integrations, VR hit log, and config bridge call sites
- `npm run verify:responses-history-protocol-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:llmswitch-ts-shell-reference-audit`
- `npm run verify:llmswitch-minimal-ts-surface -- --json`
- `npm run verify:llmswitch-rustification-audit -- --json`
- `npm run verify:vr-no-ts-runtime`
- sharedmodule TypeScript check
- root TypeScript check
- `npm run build:base`
- exact reference scan for deleted or redirected paths
- `git diff --check`

Additional runtime closure, when behavior changes:

- global release install using the standard project install flow
- managed `routecodex restart --port <port>` for affected ports
- `/health` version and `pipelineReady=true`
- live replay for a same-entry Responses continuation sample
- live request proving VR hit log emission and color/session consistency when routing integrations behavior changed

## Implementation Steps

1. Re-read the relevant function map, mainline call map, verification map, and this plan.
2. Generate a current source-only reference graph for both files and their exports/importers.
3. Add failing tests for the smallest boundary being moved before changing implementation.
4. Move one action group at a time into Rust and expose direct NAPI functions.
5. Replace TS local decisions with native operation calls.
6. Delete old TS helper code after exact references and focused tests prove it is dead.
7. Split or collapse `routing-integrations.ts` after call-site owners are clear.
8. Update maps, gates, and docs in the same change set.
9. Run the verification matrix.
10. Stage only this task's files and commit when clean for this scope.

## Definition Of Done

- `responses-conversation-store-host.ts` no longer owns store semantics or live continuation state decisions; it is deleted or a minimal host IO/native-call shell.
- `routing-integrations.ts` no longer owns mixed routing/config/Hub/VR host-effect semantics; each remaining bridge has a single owner and narrow IO role.
- All old TS semantic paths are physically deleted or forbidden by gates.
- Function map, mainline call map, and verification map match the final code paths.
- Required source gates pass.
- Runtime behavior changes, if any, are verified through global install, managed restart, `/health`, and live replay.

## Progress Notes

### 2026-07-10 Handler response-store gate de-scoped from continuation owner

- Confirmed `hub.chat_process_responses_continuation` and `conversion.responses.store` owners remain Rust-owned in `shared_responses_conversation_utils.rs`.
- `tests/server/handlers/handler-response-utils.responses-store-integration.spec.ts` currently expects `sendPipelineResponse` / SSE transport to save continuation state and fails 16/18 when run directly.
- That expectation conflicts with the immutable interval contract: handler/SSE/outbound may not save, repair, or infer continuation semantics after response Chat Process save.
- Updated function map and verification map to remove this stale handler spec from continuation owner required tests/integration gates.
- Future work must migrate any still-valid assertions to bridge/Rust owner tests or delete the stale handler spec; it must not be greened by adding handler-side continuation save logic.
