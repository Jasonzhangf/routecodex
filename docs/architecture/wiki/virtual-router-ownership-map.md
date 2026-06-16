<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Virtual Router Ownership Map

把 Virtual Router 相关 owner、选择边界、forwarder/runtime 入口、验证栈集中成一页，避免把 VR 语义误改到 executor/provider/handler。

Source of truth:
- `docs/architecture/function-map.yml` defines owner, builders, paths, and gates
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`

Feature scope: `vr.* / virtual_router.*`

| feature_id | summary | owner kind | owner module | required gates |
| --- | --- | --- | --- | --- |
| `vr.route_selection` | virtual router route classification and selected target truth | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run verify:vr-no-ts-runtime`<br/>`npm run verify:llmswitch-rustification-audit`<br/>`npm run verify:repo-sanity` |
| `virtual_router.primary_exhausted_to_default_pool` | primary tier exhausted to default-pool plan stays Rust-owned and host consumes plan only | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run verify:function-map-compile-gate`<br/>`npm run build:min` |
| `vr.route_availability_floor` | route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine` | `npm run verify:vr-no-ts-runtime`<br/>`npm run verify:architecture-ci`<br/>`npm run verify:llmswitch-rustification-audit` |
| `vr.provider_forwarder_runtime` | ProviderForwarder config load, capability filtering, internal target selection, startup cooldown truth, and runtime diagnostics stay in Rust Virtual Router | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine` | `npm run verify:vr-forwarder-runtime`<br/>`npm run verify:function-map-compile-gate` |

## vr.route_selection

Summary: virtual router route classification and selected target truth

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
Owner scope: virtual router route classification and selected target truth

Canonical types:
- `VrRoute04SelectedTarget`

Canonical builders:
- `apply_route_selection`
- `build_vr_route_04_from_hub_req_chatprocess_03`

Allowed paths:
- `sharedmodule/llmswitch-core/src/native/router-hotpath`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- `src/modules/llmswitch/bridge`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/providers/core/runtime`
- `src/client`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts`
- `tests/servertool/virtual-router-servertool-routing.spec.ts`

Required gates:
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:repo-sanity`

Notes:
- VR selects target/policy only; no payload patch, no tool semantics, no provider-specific repair.

## virtual_router.primary_exhausted_to_default_pool

Summary: primary tier exhausted to default-pool plan stays Rust-owned and host consumes plan only

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
Owner scope: primary tier exhausted to default-pool plan stays Rust-owned and host consumes plan only

Canonical types:
- `PrimaryExhaustedPlanInput`
- `PrimaryExhaustedToDefaultPoolPlan`
- `PrimaryExhaustedPlanStatus`

Canonical builders:
- `plan_primary_exhausted_to_default_pool`
- `plan_primary_exhausted_to_default_pool_json`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- `src/server/runtime/http-server/http-server-bootstrap.ts`
- `src/server/runtime/http-server/index.ts`
- `src/server/runtime/http-server/request-executor.ts`
- `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
- `tests/server/http-server/http-server-bootstrap.routing-policy-group.spec.ts`
- `tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts`
- `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
- `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`
- `docs`

Forbidden paths:
- `src/providers/core/runtime`
- `src/server/handlers`
- `sharedmodule/llmswitch-core/src/router`

Required tests:
- `tests/server/http-server/http-server-bootstrap.routing-policy-group.spec.ts`
- `tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts`
- `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
- `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`

Required gates:
- `npm run verify:function-map-compile-gate`
- `npm run build:min`

Notes:
- Host must consume Rust plan only; no local synthesis of default-pool chain.
- Host may extract route-scoped tier shape from runtime config and pass it to Rust unchanged; this is config plumbing, not planner ownership.
- Unknown target and empty default-pool are explicit contract states, never fallback.
- Host decision helpers (e.g. src/server/runtime/http-server/direct-decision.ts) live under error.execution_decision_consumer; they must not synthesize a default-pool target list.

## vr.route_availability_floor

Summary: route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine`
Owner scope: route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice

Canonical types:
- `VrRoute04SelectedTarget`

Canonical builders:
- `build_unavailable_providers_details`
- `collect_recoverable_cooldown_for_key`
- `evaluate_singleton_route_pool_exhaustion`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine`
- `sharedmodule/llmswitch-core/src/native/router-hotpath`
- `src/modules/llmswitch/bridge/native-exports.ts`
- `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
- `docs`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/server/runtime/http-server/daemon-admin`
- `src/providers/core/runtime`
- `src/manager/modules/quota`

Required tests:
- `tests/red-tests/vr_route_availability_floor_singleton_truth.test.ts`
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts`
- `tests/server/handlers/responses-handler.routing-empty-pool.spec.ts`

Required gates:
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:architecture-ci`
- `npm run verify:llmswitch-rustification-audit`

Notes:
- non-empty routing invariant belongs to Rust Virtual Router selection only.
- singleton/default hold decision and cooldown-hint parsing belong to Rust Virtual Router; TS executor may only consume native output and perform wait/log IO.
- do not patch empty-pool behavior in handlers, adapters, provider TS runtime, or executor-local policy code.
- route order is requested route -> inserted tools route when required -> default; search/tool path must stay `search -> tools -> default`, and if default pool has providers routing must not return empty.

## vr.provider_forwarder_runtime

Summary: ProviderForwarder config load, capability filtering, internal target selection, startup cooldown truth, and runtime diagnostics stay in Rust Virtual Router

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
Owner scope: ProviderForwarder config load, capability filtering, internal target selection, startup cooldown truth, and runtime diagnostics stay in Rust Virtual Router

Canonical types:
- `ForwarderRegistry`
- `ForwarderEntry`
- `ForwarderTarget`

Canonical builders:
- `build_forwarder_weights`
- `select_with_forwarder_resolution`
- `resolve_forwarder_candidate_for_pool`
- `forwarder_status_snapshot`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
- `sharedmodule/llmswitch-core/src/native/router-hotpath`
- `src/server/runtime/http-server/routes.ts`
- `docs`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
- `src/manager/modules/quota`
- `src/client`

Required tests:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs`

Required gates:
- `npm run verify:vr-forwarder-runtime`
- `npm run verify:function-map-compile-gate`

Notes:
- Config routes may name `fwd.*`, but host/executor must receive only resolved real provider keys.
- Forwarder availability must inspect real targets, including startup cooldown truth, without consuming unselected targets.
- HTTP diagnostics may expose Rust VR forwarder status only; diagnostics must not implement selection or health policy.
