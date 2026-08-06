# Hub Pipeline Rust Residual Reference Closeout Plan

## Goal

Complete the first systematic convergence pass for Hub Pipeline Rust residual reference interfaces without changing provider, Virtual Router, Hub Pipeline runtime behavior, live config, restart, install, or release behavior.

This plan covers the gate-level inventory and first safe slice for broad `native-exports`, aggregate host, retired TS stage bridge, old helper wrapper, and direct-native helper reference surfaces.

## Scope

In scope:

- Hub Pipeline related references in request/response converter, request typed entrypoint, servertool, continuation, SSE projection, and host bridge tests.
- Owner/resource/source grouping by `feature_id`, owner module, allowed paths, forbidden paths, and required gates.
- Architecture gate and red fixture preventing broad native surface regressions.
- Function-map, verification-map, wiki, skill, note, memory, and `.agent-collab` evidence.

Out of scope:

- Provider runtime behavior changes.
- Virtual Router selection/runtime behavior changes.
- Hub Pipeline runtime behavior changes.
- Live config, restart, install, release, or global runtime mutation.
- Taking over active worker claims for provider runtime tests, handler executor contraction, runtime ingress, VR host effects, or lifecycle work.

## Collaboration State

| Item | Current value |
| --- | --- |
| run_id | `20260712T115923Z-Macstudio.local-5572-333b` |
| claim | `gate_id:hub_pipeline_native_reference_gate` |
| claim status | active |
| KILL_SWITCH | absent at start-of-run check |
| active claims avoided | provider runtime tests, handler executor native host contraction, hub runtime ingress, VR route host effects, runtime lifecycle |

This run owns the gate-level inventory and review surface only. It must write handoff or merge-queue items instead of editing files owned by active claims.

## Inventory Method

Inventory must start from `git ls-files`, excluding generated artifacts such as `dist`, `target`, `coverage`, `.mempalace`, and `.local-index`.

Patterns:

- `native-exports`
- `createNativeExportsMock`
- `llmswitch-native-exports-fake`
- `runReqInboundPipelineJson`
- `runReqProcessPipelineJson`
- `runRespOutboundPipelineJson`
- `native-hub-pipeline-orchestration-semantics`
- `hub_pipeline_`

Initial compact inventory from current source-controlled files:

| Category | Count | Meaning | First action |
| --- | ---: | --- | --- |
| runtime/source | 61 | Rust `hub_pipeline_` symbols, narrow TS hosts importing private loader, and a few runtime shells | separate legitimate Rust/native-loader references from illegal external broad callers |
| test | 46 | red/audit tests, direct-native evidence helpers, current white-box host mocks, and active-claim tests | avoid active claims; gate selected white-box targets against broad mocks |
| doc/map/wiki | 82 | plans, maps, wiki pages, stale/reference docs, and historical closeout notes | classify docs as forbidden/retired/private loader vs stale owner surface |
| gate/script | 14 | architecture verifiers and release/test scripts mentioning native surfaces | preserve verifier references unless they authorize broad runtime ownership |
| other | 7 | skills, memory, beads/history/truncated output | use only as memory/history, not current source truth |

## Owner Grouping

| Residual family | Current feature owner | Desired interface owner | Runtime behavior path | Safe action this run |
| --- | --- | --- | --- | --- |
| Hub runtime ingress handle/deps | `hub.runtime_ingress_bridge` | `routing-native-host.ts` / Rust `hub_pipeline_engine::registry` | yes, but owned by active claim | document and gate; do not edit claimed tests |
| Retired request-stage TS bridge | `hub.request_stage_pipeline_bridge` | test-only `request-stage-direct-native.ts` / Rust NAPI | no active runtime owner | document and gate retired path |
| Provider response post-servertool projection | `hub.response_post_servertool_client_projection` | `provider-response-converter-host.ts` / Rust `effect_plan.rs` | yes, partly owned by complete claim | gate and document; do not rework runtime |
| Handler/executor native host mocks | `gate_id:handler_request_executor_native_host_reference_contraction` | owner-specific bridge hosts | test-only | active claim owns edits; handoff only if needed |
| Handler/executor shared fake helpers | `hub.pipeline_rust_residual_reference_closeout` | `tests/providers/helpers/responses-handler-host-fakes.ts` | test-only | move monitored handler/executor tests off broad `llmswitch-native-exports-fake` |
| Responses provider runtime tests | `conversion.shared.responses_openai.provider_runtime_tests` | owner-specific response/request hosts | test-only/provider runtime | active claim owns edits; avoid |
| Direct-native evidence helpers | owner-specific feature tests | `tests/sharedmodule/helpers/*direct-native*` or `scripts/helpers/*direct-native*` | no runtime import allowed | gate runtime import ban |
| Doc/wiki stale owner references | `hub.pipeline_rust_residual_reference_closeout` | this plan + wiki review surface | no | first safe slice |

## Residual Classification Rules

| Type | Allowed? | Rule |
| --- | --- | --- |
| runtime business caller importing `native-exports.ts` directly | no | must use owner-specific narrow host or Rust owner directly only through approved bridge |
| owner-specific narrow host importing `./native-exports.js` | yes | host is IO/native-call shell only; no business semantics |
| Jest white-box mock of broad `native-exports` | no for target Hub Pipeline host wiring tests | mock owner-specific host instead |
| monitored test import of `llmswitch-native-exports-fake` | no for target Hub Pipeline host wiring tests | use owner-specific fake helper instead |
| pure Rust/NAPI black-box evidence helper | yes | only under `tests/sharedmodule/helpers/*direct-native*` or `scripts/helpers/*direct-native*` |
| runtime import of direct-native helper | no | direct-native helpers are test/script evidence surfaces only |
| doc mention of `native-exports.ts` as private loader or forbidden legacy surface | yes | must not describe broad surface as Hub Pipeline owner |
| doc/wiki owner surface naming broad `native-exports.ts` as owner | no | replace with owner-specific host/Rust owner or mark forbidden legacy |

## Selected First Slice

The first safe slice is gate/doc/test-design only:

1. Add `verify:hub-pipeline-native-reference-gate`.
2. Add `test:hub-pipeline-native-reference-gate-red-fixtures`.
3. Add `hub.pipeline_rust_residual_reference_closeout` to function-map and verification-map.
4. Add `Hub Pipeline Rust Reference Closeout` wiki review surface and HTML render.
5. Record active-claim test files as avoided/handoff-only.

This slice does not modify runtime code or claimed test files.

The next safe test slice migrates monitored handler/executor tests from broad
`llmswitch-native-exports-fake` imports to
`tests/providers/helpers/responses-handler-host-fakes.ts`, while leaving
provider runtime active-claim tests untouched.

## Gate Contract

The architecture gate must fail when:

- A runtime/source file imports broad `src/modules/llmswitch/bridge/native-exports`.
- A monitored Hub Pipeline white-box test imports/mocks broad `native-exports`,
  `createNativeExportsMock`, or broad `llmswitch-native-exports-fake`.
- Runtime code imports `tests/sharedmodule/helpers/*direct-native*` or `scripts/helpers/*direct-native*`.
- Wiki/doc owner surface describes broad `native-exports.ts` as the Hub Pipeline owner.
- The closeout owner is missing from function-map or verification-map.
- Required package scripts for the gate/red fixture are missing.

The gate must allow:

- `src/modules/llmswitch/bridge/native-exports.ts` itself.
- Owner-specific narrow hosts importing `./native-exports.js`.
- Red/audit tests that mention retired or forbidden paths as assertions.
- Rust `hub_pipeline_` module/function names.
- Direct-native helpers in tests/scripts.

## Required Gates

- `npm run verify:hub-pipeline-native-reference-gate`
- `npm run test:hub-pipeline-native-reference-gate-red-fixtures`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `npm run verify:architecture-review-surface-light`
- `npm run verify:architecture-ci-longtail`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:llmswitch-rustification-audit -- --json`
- `npm run verify:llmswitch-ts-shell-reference-audit -- --json`
- `git diff --check`
- `.agent-collab` JSON/JSONL parse check
- `mempalace mine . --wing routecodex --agent codex`
- `mempalace search "Hub Pipeline Rust residual narrow host direct-native gate" --wing routecodex --results 5`

## Completion Criteria

- Inventory exists and is grouped by owner/resource/source, not raw grep output.
- At least one minimal safe slice is closed without runtime behavior change.
- Red fixture proves the gate rejects broad native import, broad test mock, runtime direct-native helper import, stale doc owner surface, and missing map owner.
- Function-map, verification-map, wiki Markdown, and wiki HTML are synchronized.
- `.agent-collab` evidence/events/heartbeat and merge/handoff state are written.
- `note.md`, `MEMORY.md`, and local skill capture only reusable confirmed rules.
- Any residual requiring runtime behavior refactor is listed as blocker/backlog, not silently handled in this gate slice.
