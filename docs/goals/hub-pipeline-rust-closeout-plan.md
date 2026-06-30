# Hub Pipeline Rust Closeout Plan

## 0. Purpose

This is the execution table for closing remaining Hub Pipeline TS semantics into Rust-owned modules.

The target end state is not "less TypeScript". The target end state is:

- Hub Pipeline request / response / continuation / servertool / error semantics are Rust-owned.
- TS files are limited to native-call wrappers, HTTP transport, stream IO, process lifecycle, and diagnostic observation.
- Every closed slice has a feature owner, mainline edge, required gate, and replay/live evidence.
- Dead TS semantic code is physically removed after the Rust owner is green.

## 1. Current Evidence Snapshot

Source audit date: 2026-06-29.

Evidence sources:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/mainline-manifests/*.yml`
- `docs/architecture/wiki/*.md`
- `sharedmodule/llmswitch-core/src/conversion/**`
- `sharedmodule/llmswitch-core/src/servertool/**`
- `src/modules/llmswitch/bridge/**`
- `src/server/runtime/http-server/executor/**`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/**`

Observed non-Rust owner kinds in `function-map.yml`:

| owner_kind | count | Hub Pipeline relevance |
| --- | ---: | --- |
| `ts_runtime_owner` | 20 | Some are debug/config/runtime lifecycle; Hub-relevant items include stage timing, response conversion host, error decision consumer, manager health/routing bridges. |
| `server_projection` | 11 | Mostly HTTP/SSE/client projection shells; must stay transport-only and not repair payload semantics. |
| `ts_bridge` | 6 | Hub request bridge, runtime ingress bridge, Responses request/response/SSE bridge surfaces. |
| `ts_entry_shell` | 3 | Server/CLI entry shells; not primary Hub semantics but must remain thin. |
| `provider_runtime` | 2 | Error policy/catalog surface; must not duplicate router/executor policy. |
| `transitional` | 3 | MetadataCenter mainline/capture/attempt merge. |
| `rust_hub_pipeline` | 1 | Responses continuation owner registered, but several edges remain partial. |

Mainline gaps:

| mainline | edge / state | implication |
| --- | --- | --- |
| `request.mainline` | `req-05 HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload` is `partial` | Provider wire compat is still not fully closed as a Rust-only adjacent edge. |
| `responses.continuation.mainline` | 3 edges are `partial` | Continuation save/restore truth is still split across Rust/native and TS bridge/store surfaces. |
| `servertool.hook_skeleton.mainline` | response/request hook edges remain `binding pending` | Stopless slices exist, but full hook skeleton is not bound to concrete Rust symbols. |
| `error.mainline` | `err-03 ErrorErr03RuntimeClassified -> ErrorErr05ExecutionDecision` is `partial` | TS executor still derives part of retry/project/switch decision. |
| `metadata.center.mainline` | documented as partially implemented | MetadataCenter still has transitional TS read/write/merge surfaces. |

## 2. Closeout Table

Order is from simplest / lowest blast radius to most coupled / highest blast radius.

| Wave | Module closeout unit | Current state | Rust target owner | TS end state | Required gates / proof |
| ---: | --- | --- | --- | --- | --- |
| 1 | Native wrapper and bridge thinness | Many native wrapper files exist; some wrappers still contain filtering, sorting, parser helpers, or shape projections. | `router-hotpath-napi` NAPI exports plus existing Rust semantics modules. | `native-*.ts` only JSON encode/decode, type boundary, and native call. | `npm run verify:architecture-thin-wrapper-only`, `npm run verify:llmswitch-rustification-audit`, focused wrapper scan. |
| 2 | Req outbound provider wire compat (`req-05`) | `request.mainline` marks `req-05` partial. Compat entry already points at `run_req_outbound_stage3_compat_json`. | `req_outbound_stage3_compat.rs` and submodules. | `compat-engine.ts` becomes native call shell only; old TS compat action semantics removed from mainline. | `npm run verify:responses-request-compat-rust-only`, related Responses compat gates, cargo tests for req outbound compat, replay MiniMax/Anthropic tool history samples. |
| 3 | MetadataCenter request-scoped migration | `hub.metadata_center_*` entries are transitional/rust_migration; TS request stage still builds snapshots and merges runtime control. | Rust MetadataCenter contracts plus `hub.metadata_boundary`, `hub.route_metadata_surface`, `vr.metadata_center_surface`. | TS only attaches/releases center and passes opaque snapshots; no request truth, continuation truth, or runtime_control semantic merge in TS. | `npm run verify:metadata-center-dualwrite-api`, `npm run verify:architecture-metadata-center-write-boundaries`, `npm run verify:architecture-metadata-leak-boundary`, metadata manifest sync. |
| 4 | Responses continuation save/restore | `responses.continuation.mainline` has 3 partial edges; `responses-conversation-store.ts` still owns scope/materialize/pending tool details. | Chat Process continuation Rust block: restore at request Chat Process entry, save at response Chat Process exit. | TS store is persistence IO only; no owner resolution, history repair, pending tool-call semantics, or scope-only restore. | `npm run verify:responses-handler-single-bridge-surface`, continuation whitebox tests, `/v1/responses` submit_tool_outputs blackbox, old `tool id not found` replay. |
| 5 | ErrorErr05 execution decision consumer | `error.mainline err-03` is partial; TS executor still derives exhaustion/mayProject/defaultPoolAvailable decisions. | Rust/VR policy + typed `ErrorErr05ExecutionDecision` consumer contract. | TS executor consumes a typed action only; it does not decide `mayProject`, `policyExhausted`, or provider switch policy. | `npm run verify:error-pipeline-contract`, `npm run verify:architecture-error-chain-bypass`, provider-failure blackboxes, managed 5555/5520 live replay. |
| 6 | Provider response conversion host | TS `provider-response.ts` calls Rust response pipeline but still executes servertool effects, persistence effects, stream materialization, and post-servertool projection glue. | Rust response pipeline: `ProviderRespInbound01Raw -> HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`. | TS executes only declared IO effects: stream read/write, persistence write call, client inject dispatch, logging. | `npm run verify:hub-response-*`, response mainline map, JSON/SSE parity, provider response old sample replay. |
| 7 | Servertool hook skeleton | `servertool.hook_skeleton.mainline` edges remain `binding pending`; many TS servertool shells are already narrowed but not fully removable. | `servertool-core` + `router-hotpath-napi` concrete hook skeleton symbols. | TS servertool directory only CLI/IO/registry shell; obsolete response/request orchestration shells physically deleted. | `npm run verify:servertool-rust-only`, stopless three-round blackbox, servertool followup blackbox, mainline binding-pending gate, managed live replay. |

## 3. Per-Wave Execution Contract

Every wave must follow the same closeout sequence.

1. Lock owner and edge.
   - Read `function-map.yml`, `verification-map.yml`, `mainline-call-map.yml`, and the relevant wiki/manifest.
   - If owner or edge is still ambiguous after 1-2 lookups, repair map/mainline first.

2. Add or tighten a red gate first.
   - Red gate must prove the current TS semantic surface is still illegal.
   - Do not start by deleting code without a gate that would catch resurrection.

3. Move the semantic owner to Rust.
   - Add/extend Rust contract types, builders, parser, or planner in the owning Rust module.
   - Keep conversions adjacent to the pipeline node.
   - Do not add fallback or a second TS implementation.

4. Collapse TS.
   - Keep only native wrapper, IO shell, transport shell, or diagnostic observation.
   - Physically delete dead helpers, tests, docs, and feature anchors that no longer represent runtime truth.

5. Verify in layers.
   - Rust unit tests for the owner.
   - Focused Jest/blackbox for the boundary.
   - Architecture/function-map gates.
   - Build/typecheck when runtime surface changes.
   - Live replay or real sample replay when the changed path is externally observable.

6. Update maps and review surface.
   - `function-map.yml`
   - `verification-map.yml`
   - `mainline-call-map.yml`
   - `docs/architecture/mainline-manifests/*.yml`
   - `docs/architecture/wiki/*.md` and rendered HTML if node IDs/edges change.

7. Commit the closed slice.
   - Commit only the verified slice.
   - Do not mix unrelated dirty work.

## 4. First Slice Recommendation

Start with Wave 2, not Wave 7.

Reason:

- `req-05` is already explicitly marked partial.
- Rust owner and package gates already exist.
- It is adjacent to recent real failures around outbound mapping/cleaning and MiniMax tool history.
- It has lower blast radius than full servertool hook skeleton and ErrorErr05.

First slice target:

`HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`

Initial tasks:

1. Audit TS compat actions currently reachable from the req-outbound path.
2. Identify any TS code still transforming `messages`, `tools`, `tool_calls`, `tool_call_id`, `function_call_output`, `instructions`, or provider wire payload.
3. Add a red architecture gate forbidding the reachable TS transform.
4. Move missing transform into `req_outbound_stage3_compat.rs` or its submodule.
5. Delete the TS semantic helper or reduce it to a native wrapper.
6. Run:
   - `npm run verify:responses-request-compat-rust-only`
   - relevant specialized Responses/OpenAI chat compat gates
   - focused Rust cargo tests
   - `npm run verify:function-map-compile-gate`
   - real sample replay for the latest MiniMax/Anthropic outbound tool-history issue

## 5. Completion Definition

This plan is complete only when all of the following are true:

1. `request.mainline`, `response.mainline`, `responses.continuation.mainline`, `servertool.hook_skeleton.mainline`, `metadata.center.mainline`, and `error.mainline` have no unjustified `partial` or `binding pending` edges for Hub semantics.
2. `function-map.yml` has no Hub Pipeline semantic `ts_runtime_owner`, `ts_bridge`, or `transitional` owner except documented transport/IO shells.
3. `verify:architecture-thin-wrapper-only`, `verify:servertool-rust-only`, `verify:error-pipeline-contract`, metadata gates, Responses gates, and architecture CI pass.
4. Live or old-sample replay proves the changed paths work on real payloads.
5. Dead TS semantic code and stale tests/docs are physically removed.

## 6. Goal Prompt

```text
/goal
Objective: Execute the Hub Pipeline Rust closeout plan in docs/goals/hub-pipeline-rust-closeout-plan.md, closing modules in order from lower-risk Rust-ready surfaces to high-risk lifecycle surfaces. Start with Wave 2 req-outbound provider wire compat unless current repo evidence shows Wave 1 wrapper thinness has a blocking violation.

Execution rules:
- Follow AGENTS.md and .agents/skills/rcc-dev-skills/SKILL.md.
- Use rustify-the-code workflow: per-module closeout, red gate first, Rust owner green, TS collapse, replay/live evidence, then commit the verified slice.
- Do not implement fallback, downgrade, semantic TS duplicate logic, or handler/outbound repair patches.
- Before editing each wave, lock function-map owner, verification-map gates, mainline edge, wiki/manifest node IDs, and current TS residual files.
- If owner or mainline cannot be located in 1-2 lookups, repair map/mainline before implementation.
- Preserve dirty unrelated work; commit only the verified slice.

Initial slice:
1. Audit req-05 HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload.
2. Find reachable TS transforms over messages/tools/tool_calls/tool_call_id/function_call_output/instructions/provider wire payload.
3. Add or tighten a red architecture gate that proves those TS transforms cannot remain or resurrect.
4. Move missing semantics into Rust req_outbound_stage3_compat.rs or its owned submodule.
5. Collapse TS to native wrapper/IO shell or physically delete dead helpers.
6. Update function-map, verification-map, mainline-call-map, manifests/wiki if owner or edge state changes.

Required verification for first slice:
- focused Rust cargo tests for req_outbound_stage3_compat
- npm run verify:responses-request-compat-rust-only
- related specialized Responses/OpenAI chat compat gates affected by the change
- npm run verify:function-map-compile-gate
- npm run verify:architecture-thin-wrapper-only if wrapper files changed
- real sample replay for the latest MiniMax/Anthropic outbound tool-history issue
- git diff --check

Completion signal:
- Report changed files, removed TS semantic surfaces, Rust owner/gate evidence, replay/live evidence, remaining risk, and commit hash for the verified slice.
```
