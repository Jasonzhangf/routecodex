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
| `vr.route_selection` | virtual router route classification and selected target truth | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run verify:vr-no-ts-runtime`<br/>`npm run verify:llmswitch-rustification-audit`<br/>`npm run verify:repo-sanity`<br/>`npm run verify:resource-operation-map` |
| `vr.route_token_estimation` | Virtual Router request token counting uses the retired tiktoken semantics in Rust | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs` | `npm run verify:vr-token-estimation-rust`<br/>`npm run test:vr-token-estimation-red-fixtures`<br/>`npm run verify:resource-operation-map`<br/>`npm run verify:function-map-compile-gate`<br/>`npm run build:native-hotpath` |
| `vr.shared_function_library_helpers` | Virtual Router exact duplicate pure helper mechanics are centralized in Rust helper owners | `rust_helper` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine` | `npm run test:vr-shared-function-library-helpers-red-fixtures`<br/>`npm run verify:vr-shared-function-library-helpers`<br/>`npm run test:vr-shared-function-library-helpers-cargo`<br/>`npm run verify:vr-no-ts-runtime`<br/>`npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:llmswitch-rustification-audit`<br/>`npm run build:base` |
| `vr.metadata_center_surface` | Virtual Router read-only metadata-center-backed route surface | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs` | `npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:architecture-owner-queryability`<br/>`npm run verify:vr-no-ts-runtime` |
| `vr.route_retry_pin_surface` | Virtual Router retry-provider-pin parsing and forced-target selection stay queryable as one Rust owner surface | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs` | `npm run verify:vr-no-ts-runtime`<br/>`npm run verify:architecture-custom-payload-carrier-owner-queryability`<br/>`npm run verify:resource-operation-map` |
| `vr.hit_log_projection` | Virtual Router hit-log record, formatting, color-key, reason, and telemetry projection stay Rust-owned | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs` | `npm run verify:llmswitch-rustification-audit`<br/>`npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:vr-no-ts-runtime` |
| `vr.route_host_effects` | Virtual Router route host effects plan/finalize stay Rust-owned before TS host emission | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/virtual_router_host_effects.rs` | `npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:llmswitch-rustification-audit` |
| `virtual_router.primary_exhausted_to_default_pool` | primary tier exhausted to default-pool plan stays Rust-owned and host consumes plan only | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run build:base` |
| `vr.route_availability_floor` | route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine` | `npm run verify:vr-no-ts-runtime`<br/>`npm run verify:architecture-ci`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:llmswitch-rustification-audit`<br/>`npm run verify:vr-route-availability-default-floor` |
| `vr.provider_forwarder_runtime` | ProviderForwarder config load, capability filtering, internal target selection, in-process health/cooldown truth, and runtime diagnostics stay in Rust Virtual Router | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine` | `npm run verify:vr-forwarder-runtime`<br/>`npm run verify:function-map-compile-gate` |
| `vr.online_diagnostics` | Virtual Router online status and dry-run route diagnostics stay Rust-owned | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs` | `npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map`<br/>`npm run verify:vr-no-ts-runtime`<br/>`npm run verify:vr-forwarder-runtime` |

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
- `tests/servertool/virtual-router-servertool-routing.spec.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`

Required gates:
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:repo-sanity`
- `npm run verify:resource-operation-map`

Notes:
- VR selects target/policy only; no payload patch, no tool semantics, no provider-specific repair.
- Current-turn multimodal intent must read media from the active turn segment's user carrier, not from the last non-user entry and not from historical turns.

## vr.route_token_estimation

Summary: Virtual Router request token counting uses the retired tiktoken semantics in Rust

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`
Owner scope: Rust-only token estimate for longcontext classification; media payload bytes are omitted and provider aliases use the retired default encoder contract

Canonical types:
- `CoreBPE`

Canonical builders:
- `estimate_request_tokens`
- `legacy_tiktoken_encoding_name`
- `count_content_tokens`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml`
- `sharedmodule/llmswitch-core/rust-core/Cargo.lock`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `scripts/architecture/verify-vr-token-estimation-rust.mjs`
- `scripts/tests/vr-token-estimation-red-fixtures.mjs`
- `docs/goals/vr-rust-tiktoken-image-body-limit-test-design.md`
- `docs/architecture`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/providers`
- `src/server/runtime/http-server/executor`
- `provider configuration`
- `payload trimming`

Required tests:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `scripts/tests/vr-token-estimation-red-fixtures.mjs`

Required gates:
- `npm run verify:vr-token-estimation-rust`
- `npm run test:vr-token-estimation-red-fixtures`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run build:native-hotpath`

Notes:
- This feature restores the retired TS tiktoken counting semantics in Rust; it must not use tiktoken-rs prefix model matching for provider aliases such as gpt-5.5/gpt-5.6-sol.
- HTTP bodyLimit remains the transport allocation guard; Hub format nodes must not own a second fixed semantic payload byte cap.
- Route classification must ignore client-provided estimatedInputTokens/estimatedTokens metadata and derive estimated_tokens from the Rust request estimator; metadata estimates can be diagnostics/usage hints only.

## vr.shared_function_library_helpers

Summary: Virtual Router exact duplicate pure helper mechanics are centralized in Rust helper owners

Owner kind: `rust_helper`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
Owner scope: VR shared helper placement for exact duplicate string/list mechanics and tool-detection constant reuse only; no route-selection, availability, forwarder, provider, or payload semantic movement

Canonical types:
- `serde_json::Value`

Canonical builders:
- `trim_nonempty_str`
- `push_unique_trimmed`
- `normalize_unique_trimmed_strings`
- `normalize_trimmed_string_values`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/mod.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/error_err05_availability.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features/tools.rs`
- `scripts/architecture/verify-vr-shared-function-library-helpers.mjs`
- `scripts/tests/vr-shared-function-library-helpers-red-fixtures.mjs`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/virtual-router-ownership-map.md`
- `docs/architecture/wiki/html/virtual-router-ownership-map.html`
- `docs/goals/virtual-router-shared-function-library-convergence-plan.md`
- `package.json`

Forbidden paths:
- `src/server/runtime/http-server/executor`
- `src/providers`
- `src/client`
- `sharedmodule/llmswitch-core/src/router`

Required tests:
- `scripts/tests/vr-shared-function-library-helpers-red-fixtures.mjs`
- `scripts/architecture/verify-vr-shared-function-library-helpers.mjs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features/tools.rs`

Required gates:
- `npm run test:vr-shared-function-library-helpers-red-fixtures`
- `npm run verify:vr-shared-function-library-helpers`
- `npm run test:vr-shared-function-library-helpers-cargo`
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`

Notes:
- This helper owner only removes exact duplicate pure mechanics from VR Rust files; it must not decide route policy, forwarder availability, default-floor terminal projection, provider shape, or payload repair.
- Bool, number, provider-key, forwarder, and default-floor helpers are intentionally excluded until their caller-specific semantics are locked by dedicated red tests.
- Red fixtures must fail if monitored VR files reintroduce local trim/dedupe helpers or local tool-detection constant arrays.

## vr.metadata_center_surface

Summary: Virtual Router read-only metadata-center-backed route surface

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs`
Owner scope: Virtual Router read-only metadata-center-backed route scope surface for route hint, session scope, and stop-message routing reads

Canonical types:
- `MetaRoute03RouteCarrier`

Canonical builders:
- `resolve_routing_state_key`
- `resolve_session_scope`
- `resolve_stop_message_scope`
- `is_server_tool_followup_request`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
- `tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`
- `tests/servertool/virtual-router-servertool-routing.spec.ts`
- `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`
- `docs`

Forbidden paths:
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
- `src/client`
- `sharedmodule/llmswitch-core/src/router`

Required tests:
- `tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`
- `tests/servertool/virtual-router-servertool-routing.spec.ts`
- `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`

Required gates:
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:vr-no-ts-runtime`

Notes:
- VR reads route scope from the request-scoped MetadataCenter snapshot and its typed reader only; it must not restore route truth from `__rt`, flat metadata, or a separate VR-local store.
- Route selection still outputs `VrRoute04SelectedTarget` through `hub.route_selection_bridge`; this owner only covers the read-only metadata surface used by VR decisions.

## vr.route_retry_pin_surface

Summary: Virtual Router retry-provider-pin parsing and forced-target selection stay queryable as one Rust owner surface

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
Owner scope: Virtual Router adjacent route/select surface for retry-provider-pin parsing, forced-target filtering, and forced reasoning projection

Canonical types:
- `InstructionTarget`
- `SelectionResult`

Canonical builders:
- `parse_retry_provider_key_target`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/servertool/virtual-router-servertool-routing.spec.ts`
- `docs`

Forbidden paths:
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
- `src/client`

Required tests:
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/servertool/virtual-router-servertool-routing.spec.ts`

Required gates:
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:architecture-custom-payload-carrier-owner-queryability`
- `npm run verify:resource-operation-map`

Notes:
- This adjacent owner surface keeps retry pin parsing and its forced SelectionResult projection queryable; generic non-retry route selection remains under vr.route_selection.

## vr.hit_log_projection

Summary: Virtual Router hit-log record, formatting, color-key, reason, and telemetry projection stay Rust-owned

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs`
Owner scope: file-scoped Rust owner for Virtual Router hit-log diagnostic projection; host/runtime TS may only call required NAPI exports and emit returned strings

Canonical types:
- `VirtualRouterHitRecord`
- `StopMessageRuntimeSummary`
- `VirtualRouterHitEvent`

Canonical builders:
- `create_virtual_router_hit_record_json`
- `format_virtual_router_hit_json`
- `build_hit_reason_json`
- `to_virtual_router_hit_event_json`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `src/modules/llmswitch/bridge/session-log-color-host.ts`
- `src/utils/session-log-color.ts`
- `tests/sharedmodule/helpers/virtual-router-hit-log-direct-native.ts`
- `tests/sharedmodule/helpers/virtual-router-engine-direct-native.ts`
- `tests/sharedmodule/virtual-router-hit-log.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `docs`

Forbidden paths:
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
- `src/client`
- `sharedmodule/llmswitch-core/src/router`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts`
- `rcc-llmswitch-core/v2/runtime/virtual-router-hit-log`

Required tests:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs`
- `tests/sharedmodule/virtual-router-hit-log.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`

Required gates:
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:vr-no-ts-runtime`

Notes:
- Hit-log projection is diagnostic output, not route selection. It must not reselect routes, patch provider payloads, or infer provider policy.
- Human-visible hit-log route labels and telemetry `pool` projection must show the route classification only (`routeName`); standalone authoring/runtime pool names must not appear in the emitted line or telemetry event.
- Retired TS `runtime/virtual-router-hit-log.ts` facade is physically deleted; stop-message summary, provider key parsing, color selection, hit reason, and telemetry projection are Rust-owned through direct NAPI exports.
- Runtime route host-effects planning/finalization is Rust-owned; `routing-integrations.ts` may only call `planVirtualRouterRouteHostEffectsJson` / `finalizeVirtualRouterRouteHostEffectsJson`, apply returned `cleanedRequest`, and emit returned log lines.
- Session log color helpers must reach Rust through `src/modules/llmswitch/bridge/session-log-color-host.ts`; TS may not keep local color hashing or broad bridge ownership.

## vr.route_host_effects

Summary: Virtual Router route host effects plan/finalize stay Rust-owned before TS host emission

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/virtual_router_host_effects.rs`
Owner scope: file-scoped Rust owner for Virtual Router route host-effects planning and finalization

Canonical types:
- `VirtualRouterRouteHostEffectsPlan`

Canonical builders:
- `plan_virtual_router_route_host_effects_json`
- `finalize_virtual_router_route_host_effects_json`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/virtual_router_host_effects.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`
- `src/modules/llmswitch/bridge/routing-integrations.ts`
- `docs/architecture`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`

Forbidden paths:
- `src/modules/llmswitch/bridge/virtual-router-hit-log.ts`
- `src/modules/llmswitch/core`
- `src/server/runtime/http-server`

Required tests:
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`

Required gates:
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:llmswitch-rustification-audit`

Notes:
- TS routing integrations may call native host-effects exports and emit returned strings; request-id/session/status-label decisions must remain in Rust.

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
- `src/modules/llmswitch/bridge/route-availability-host.ts`
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
- `npm run verify:architecture-mainline-call-map`
- `npm run build:base`

Notes:
- Host must consume Rust plan only; no local synthesis of default-pool chain.
- Host may extract route-scoped tier shape from runtime config and pass it to Rust unchanged; this is config plumbing, not planner ownership.
- Unknown target and empty default-pool are explicit contract states, never fallback.
- Host decision helpers (e.g. src/server/runtime/http-server/direct-decision.ts) live under error.execution_decision_consumer; they must not synthesize a default-pool target list.
- Ordinary route-pool removal must not project terminal no-provider while default pool still retains its last provider; this guard is part of the Rust-owned plan/consumer contract, not a handler/executor-local reinterpretation.

## vr.route_availability_floor

Summary: route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
Owner scope: route selection must not silently collapse to empty after quota health and filters; default pool always keeps one last ordered choice

Canonical types:
- `VrRoute04SelectedTarget`

Canonical builders:
- `build_unavailable_providers_details`
- `collect_recoverable_cooldown_for_key`
- `evaluate_singleton_route_pool_exhaustion`
- `resolve_error_err05_route_availability_decision`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
- `src/modules/llmswitch/bridge/route-availability-host.ts`
- `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
- `docs`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/server/runtime/http-server/daemon-admin`
- `src/providers/core/runtime`

Required tests:
- `tests/red-tests/vr_route_availability_floor_singleton_truth.test.ts`
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/server/handlers/responses-handler.routing-empty-pool.spec.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/error_err05_availability.rs`

Required gates:
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:architecture-ci`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:vr-route-availability-default-floor`

Notes:
- non-empty routing invariant belongs to Rust Virtual Router selection only.
- singleton/default hold decision and cooldown-hint parsing belong to Rust Virtual Router; TS executor may only consume native output and perform wait/log IO.
- do not patch empty-pool behavior in handlers, adapters, provider TS runtime, or executor-local policy code.
- route order is requested route -> inserted tools route when required -> default; search/tool path must stay `search -> tools -> default`, and if default pool has providers routing must not return empty.
- Before excluding/removing an ordinary-route candidate, runtime truth must preserve the default-pool last-provider floor; `forwarder_no_available_target` or route-local empty-pool is non-terminal while default-pool availability remains.
- ErrorErr05 consumer inputs for remaining route candidates, routePoolAuthoritative, verifiedLastProvider, defaultPoolAvailable, policyExhausted, and mayProject must come from `resolve_error_err05_route_availability_decision`; TS executor/direct code may only consume the native decision.

## vr.provider_forwarder_runtime

Summary: ProviderForwarder config load, capability filtering, internal target selection, in-process health/cooldown truth, and runtime diagnostics stay in Rust Virtual Router

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`
Owner scope: ProviderForwarder config load, capability filtering, internal target selection, in-process health/cooldown truth, and runtime diagnostics stay in Rust Virtual Router

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
- `src/server/runtime/http-server/routes.ts`
- `docs`

Forbidden paths:
- `sharedmodule/llmswitch-core/src/router`
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
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
- Forwarder availability must inspect real targets using process-local health truth only; stale disk cooldown state must not be consumed after restart.
- HTTP diagnostics may expose Rust VR forwarder status only; diagnostics must not implement selection or health policy.

## vr.online_diagnostics

Summary: Virtual Router online status and dry-run route diagnostics stay Rust-owned

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs`
Owner scope: file-scoped Rust owner for Virtual Router online route/tier/forwarder/default-pool status plus dry-run decision and provider-unavailable explanation

Canonical types:
- `VrDiag01StatusSnapshot`
- `VrDiag02DryRunInput`
- `VrDiag03DryRunDecision`
- `VrDiag04ErrorExplain`

Canonical builders:
- `route_pool_status_snapshot`
- `build_dry_run_decision`
- `parse_virtual_router_error_for_diagnostics`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/napi_proxy.rs`
- `src/server/runtime/http-server/routes.ts`
- `src/cli/commands/port.ts`
- `tests/sharedmodule`
- `tests/cli`
- `docs`

Forbidden paths:
- `src/server/runtime/http-server/executor`
- `src/providers/core/runtime`
- `src/client`
- `sharedmodule/llmswitch-core/src/router`

Required tests:
- `tests/sharedmodule/virtual-router-online-diagnostics.spec.ts`
- `tests/server/runtime/http-server/virtual-router-diagnostics.spec.ts`
- `tests/cli/port-command.spec.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/status.rs`

Required gates:
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:vr-no-ts-runtime`
- `npm run verify:vr-forwarder-runtime`

Notes:
- Rust VR must produce route/tier/forwarder/default-pool status, dry-run decisions, and provider-unavailable blocker explanations.
- TS HTTP/CLI may only call native diagnostics and project the returned JSON; it must not recalculate route queues, forwarder expansion, default floor, health/cooldown, or candidate blockers.
- Dry-run must be non-mutating: no load-balancer pointer movement, no health/routing-state/sticky/cooldown/provider stats writes, and no persistence.
