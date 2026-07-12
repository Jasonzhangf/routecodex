# Resource Ownership Refactor Plan

## Goal

Refactor RouteCodex architecture from scattered request/response manipulation into a resource-owned, stage-bound model. Start from resource ownership, resource relationships, documentation, and gates. Only after the ownership model is mapped and verified should runtime code be refactored.

## Acceptance Criteria

- Request, response, metadata, error, route, provider runtime, continuation, dry-run, snapshot, SSE, and servertool resources have explicit ownership and lifecycle boundaries.
- Function map entries for key features can be queried by resource bindings: reads, writes, projections, forbidden writes, and required gates.
- Mainline call map edges describe adjacent resource flow and side-channel reads/writes.
- Architecture documentation explains the resource taxonomy, unique owner rule, side-channel isolation, and forbidden shortcut patterns.
- Static gates validate map parseability, owner uniqueness, resource binding consistency, forbidden writes, and non-adjacent resource conversion.
- No runtime refactor starts until M0 maps and gates are green.
- Subsequent code refactors are performed resource-by-resource and remove duplicate/incorrect implementations physically after ownership is verified.

## Scope

In scope:

- Project-wide resource convergence across RouteCodex. `dryrun.provider_request_probe` is only a low-risk sample/pilot, not the scope boundary.
- Resource taxonomy and resource operation map.
- Function map resource binding extensions.
- Mainline call map resource flow extensions.
- Verification map updates for resource gates.
- Architecture docs and local skills updates.
- Static verification scripts for resource ownership and binding consistency.
- Small pilot refactors only after resource maps and gates pass.

Out of scope for M0:

- Creating a global request/response manager class.
- Moving all request/response logic into one file or one object.
- Changing provider behavior without a resource-owner finding and red/green verification.
- Adding fallback, compatibility shortcuts, or dual-path compensation.
- Rewriting Hub Pipeline, Virtual Router, provider runtime, continuation, or servertool logic before maps and gates identify the unique owner and boundary.

## Project-Wide Scope Correction

This refactor is global to RouteCodex. M0 established the first resource taxonomy and the first machine-checked map, but it is not the finish line. The next layer is a project-wide coverage audit that keeps the work from narrowing to dry-run or any single resource.

Current coverage command:

- `npm run audit:resource-global-coverage`

Current audit artifact:

- `docs/architecture/resource-global-coverage-report.json`

Coverage interpretation:

- `resource_bindings` coverage measures how many active function-map owners can be queried by resource reads/writes/projections/forbidden paths.
- `resource_flow` coverage measures how many mainline call-map edges have adjacent resource consumes/produces/side-channel reads/writes.
- Missing coverage is not runtime failure by itself; it is the global backlog for top-down resource convergence.
- Runtime refactor may only start inside a resource/domain after the relevant owner bindings and adjacent mainline flows are mapped and gated.

Expansion order:

1. Main request/response/error/metadata/continuation/servertool/VR/runtime lifecycle edges.
2. Config materialization and WebUI config editor resources.
3. Runtime lifecycle, install/restart, and process-lifecycle resources.
4. Debug/diagnostics/snapshot resources beyond dry-run.
5. Provider/runtime family resources and host bridge resources.

## First-Layer Backlog Boundary

The first layer closes only resources and adjacent flows that can be described with the current M0 resource taxonomy without inventing ambiguous resource identities.

Closed in the first layer:

- `request.mainline`
- `response.mainline`
- `responses.continuation.mainline`
- `servertool.hook_skeleton.mainline`
- `error.mainline`
- `vr.route_availability.mainline`
- `metadata.center.mainline`

Deferred to the next layer:

- Config materialization and WebUI editor edges need config-specific resources before they can be mapped correctly.
- Runtime lifecycle edges need process/runtime lifecycle resources instead of overloading request/response resources.
- Debug/internal-error/diagnostic edges need debug artifact and internal-error resources beyond `snapshot.debug_sample`.
- VR online diagnostics and hit-log edges need diagnostic projection resources distinct from route selection truth.
- Servertool engine subfeatures outside `servertool.hook_skeleton.mainline` need finer servertool engine resources before feature-level coverage can be made precise.

## Second-Layer Closure

Second-layer resource coverage closes the domains that were intentionally deferred by the first layer. It adds config, WebUI edit intent, runtime lifecycle, debug/internal-error, and VR diagnostic resources without changing runtime behavior.

Closed in the second layer:

- `config.user_config_materialization.mainline`
- `webui.config_editor_surface.mainline`
- `runtime.lifecycle.mainline`
- `debug.unified_surface.mainline`
- `debug.pipeline_dry_run_loop.mainline` missing dry-run edges `ddr-01` and `ddr-03`
- `internal_error_numbering.mainline`
- `vr.online_diagnostics.mainline`
- `vr.hit_log_projection.mainline`

Second-layer resource identities:

- Config: `config.authoring_surface`, `config.validated_manifest`, `config.runtime_projection`, `config.provider_profile_projection`, `config.routing_policy_projection`.
- WebUI config editor: `webui.config_edit_intent`, `config.admin_mutation_request`, `config.shared_write_result`.
- Runtime lifecycle: `runtime.pid_cache`, `runtime.stop_intent`, `runtime.instance_record`, `runtime.restart_signal`, `runtime.admin_restart_request`.
- Debug/internal-error: `debug.artifact`, `debug.internal_error_envelope`, `debug.external_error_link`, `debug.client_boundary_proof`.
- VR diagnostics / hit-log: `vr.diagnostic_snapshot`, `vr.diagnostic_decision`, `vr.hit_log_record`, `vr.telemetry_projection`, `diagnostic.http_payload`.

Current second-layer coverage evidence:

- `npm run audit:resource-global-coverage` reports `resources: 40`.
- Mainline resource flow coverage increased from `51/108` to `91/108`.
- Active feature resource binding coverage increased from `31/119` to `43/119`.
- Remaining missing mainline `resource_flow` edges are outside the second-layer scope: `stopless.session.mainline`, `sse.chat_stream_projection.mainline`, and `stage_a.p0_rust_migration.mainline`.

Next-layer backlog:

- Add finer-grained resources for stopless session sub-edges beyond `stl-01`.
- Add SSE protocol/transport resources for Anthropic/Gemini stream projection edges.
- Add Rust migration/stage_a resources for conversion and servertool closeout edges.
- Add servertool engine subfeature resources for feature-level coverage outside `servertool.hook_skeleton.mainline`.
- Continue provider/runtime family and host bridge resource binding only after each owner edge is anchored in the function map and mainline call map.

## Third-Layer Closure

Third-layer resource coverage closes all remaining mainline edge `resource_flow` gaps. This layer still does not change runtime behavior; it only adds resource identities and adjacent flows for the already-anchored mainline edges.

Closed in the third layer:

- `stopless.session.mainline` edges `stl-02` through `stl-08`.
- `sse.chat_stream_projection.mainline` Anthropic/Gemini JSON-to-SSE and SSE-to-JSON edges.
- `stage_a.p0_rust_migration.mainline` P0 Rust migration owner-boundary edges.

Third-layer resource identities:

- Stopless: `stopless.schema_gate_state`, `stopless.runtime_snapshot`, `stopless.cli_projection`, `stopless.cli_result`, `stopless.guidance_rewrite`, `stopless.schema_contract`.
- SSE: `sse.protocol_stream_projection`, `sse.provider_stream_aggregate`.
- Stage A migration: `stage_a.servertool_outcome_plan`, `stage_a.protocol_canonical`, `stage_a.continuation_store_state`, `stage_a.req_tool_governance_state`, `stage_a.resp_tool_governance_state`.

Current third-layer coverage evidence:

- `npm run audit:resource-global-coverage` reports `resources: 53`.
- Mainline resource flow coverage increased from `91/108` to `108/108`.
- Active feature resource binding coverage increased from `43/119` to `50/119`.
- Mainline edge resource flow is now complete; remaining backlog is feature-level `resource_bindings` for non-mainline or more granular owner surfaces.

Next-layer backlog:

- Servertool engine subfeatures: engine selection, CLI projection, auto-hook execution, preflight/runtime/prepass/skip/action/dispatch/outcome/registry contracts.
- Host bridge and runtime surface features: runtime key resolution, runtime ingress bridge, provider response conversion host, response inspection helpers, models capability, responses handler/SSE/response bridge surfaces.
- Protocol normalization feature bindings: OpenAI chat compat and Responses normalization features outside the current mainline edges.
- Config codec/path/coercion feature bindings below the high-level config materialization/write surfaces.

## Fourth-Layer Servertool Engine Feature Binding Closure

Fourth-layer resource coverage starts after mainline `resource_flow` reached `108/108`. This layer does not add new mainline flows and does not change runtime behavior; it maps non-mainline servertool engine owner surfaces to queryable feature-level `resource_bindings`.

Closed in the servertool engine batch:

- `hub.servertool_followup`
- `hub.servertool_engine_selection`
- `hub.servertool_cli_projection`
- `hub.servertool_auto_hook_execution`
- `hub.servertool_engine_preflight_contract`
- `hub.servertool_engine_runtime_action_contract`
- `hub.servertool_engine_prepass_action_contract`
- `hub.servertool_engine_skip_contract`
- `hub.servertool_execution_branch_contract`
- `hub.servertool_execution_dispatch_contract`
- `hub.servertool_execution_handler_contract`
- `hub.servertool_execution_loop_effect_contract`
- `hub.servertool_execution_loop_runtime_action_contract`
- `hub.servertool_execution_outcome_runtime_action_contract`
- `hub.servertool_execution_state_contract`
- `hub.servertool_registry_contract`
- `hub.servertool_response_stage_runtime_action_contract`
- `hub.servertool_server_side_tool_entry_contract`
- `hub.servertool_stopless_cli_projection_context`
- `hub.servertool_flow_presentation`
- `hub.servertool_loop_warning`
- `hub.servertool_rust_only_closeout`
- `hub.servertool_orchestration_policy`

Fourth-layer servertool resource identities:

- `servertool.engine_selection_plan`
- `servertool.engine_action_plan`
- `servertool.auto_hook_execution_plan`
- `servertool.execution_contract_plan`
- `servertool.execution_state`
- `servertool.registry_projection`
- `servertool.cli_projection_plan`
- `servertool.flow_presentation`
- `servertool.loop_warning`
- `servertool.hook_closeout_contract`
- `servertool.orchestration_policy`

Current fourth-layer coverage evidence:

- `npm run audit:resource-global-coverage` reports `resources: 64`.
- Mainline resource flow coverage remains `108/108`.
- Active feature resource binding coverage increased from `50/119` to `73/119`.
- The first missing resource binding is now `server.runtime_key_resolution`, so the servertool engine priority batch is no longer in the missing list.

Next-layer backlog:

- Host bridge and runtime surface features: `server.runtime_key_resolution`, `hub.runtime_ingress_bridge`, provider response conversion host, response inspection helpers, models capability, Responses handler/SSE/response bridge surfaces, and CLI command surface.
- Protocol/conversion feature bindings: OpenAI chat compat, Responses normalization, web search governance, and shared Gemini conversion.
- Config codec/path/coercion bindings below the high-level config materialization resources.
- Manager/debug/snapshot residual feature bindings.

## Fourth-Layer Host Bridge / Runtime Surface Binding Closure

The host bridge / runtime surface batch continues fourth-layer feature-level binding coverage. It does not add mainline flows and does not change runtime behavior; it maps server entry shells, host bridge wrappers, runtime handle surfaces, and response/CLI transport surfaces to explicit resources.

Closed in the host/runtime batch:

- `server.runtime_key_resolution`
- `hub.runtime_ingress_bridge`
- `hub.response_anthropic_client_projection`
- `hub.response_post_servertool_client_projection`
- `hub.response_provider_context_helpers`
- `hub.chat_process_session_usage`
- `server.http_runtime_entry`
- `server.http_runtime_lifecycle`
- `server.provider_response_conversion_host`
- `server.response_inspection_helpers`
- `server.models_capability_contract`
- `server.responses_handler_family`
- `server.responses_sse_bridge_surface`
- `server.responses_response_handler_bridge_surface`
- `cli.command_surface`

Fourth-layer host/runtime resource identities:

- `runtime.provider_binding_resolution`
- `runtime.hub_pipeline_handle`
- `runtime.http_entry_dispatch`
- `runtime.http_lifecycle_context`
- `response.host_conversion_handoff`
- `response.inspection_signal`
- `models.capability_catalog`
- `server.handler_transport_envelope`
- `cli.command_dispatch_intent`
- `hub.chat_session_usage`
- `response.provider_context_projection`

Current host/runtime batch coverage evidence:

- `npm run audit:resource-global-coverage` reports `resources: 75`.
- Mainline resource flow coverage remains `108/108`.
- Active feature resource binding coverage increased from `73/119` to `88/119`.
- The first missing resource binding is now `error.backoff_action_queue`; the host bridge / runtime priority batch is no longer in the missing list.

Next-layer backlog:

- Error/VR/pipeline contract surfaces: `error.backoff_action_queue`, `vr.route_selection`, `hub.route_metadata_surface`, `vr.route_retry_pin_surface`, `hub.pipeline_contract_surface`, and `server.rust_contract_surface`.
- Protocol/conversion feature bindings: OpenAI chat compat, Responses normalization, CRS request compat, web search governance, and shared Gemini conversion.
- Config codec/path/coercion bindings below the high-level config materialization resources.
- Manager/debug/snapshot residual feature bindings.

## Fourth-Layer Protocol / Conversion Feature Binding Closure

The protocol / conversion batch continues fourth-layer feature-level binding coverage after mainline `resource_flow` is already complete at `108/108`. This layer does not add mainline flows and does not change runtime behavior; it maps provider-wire compatibility, Responses request normalization, web search governance, and Gemini conversion owner surfaces to explicit protocol resources.

Closed in the protocol/conversion batch:

- `openai_chat.single_tool_call_history_compat`
- `responses.function_tool_normalization`
- `responses.tool_parameters_normalization`
- `responses.instructions_to_input_normalization`
- `responses.crs_request_compat`
- `hub.web_search_tool_governance`
- `conversion.shared.gemini`

Fourth-layer protocol/conversion resource identities:

- `protocol.openai_chat_history_compat`
- `protocol.responses_function_tool_schema`
- `protocol.responses_tool_parameters_schema`
- `protocol.responses_instruction_projection`
- `protocol.responses_crs_request_compat`
- `protocol.gemini_canonical`
- `protocol.web_search_governance_plan`

Design closeout:

- `protocol.responses_function_tool_schema` and `protocol.responses_tool_parameters_schema` are intentionally split so `responses.function_tool_normalization` and `responses.tool_parameters_normalization` do not share a single ambiguous resource writer.
- `protocol.web_search_governance_plan` is `side_channel`; it may guide Hub/VR/provider outbound control decisions but must not enter provider body or client body.
- Provider-wire compatibility resources may enter provider body only at `ProviderReqOutbound06WirePayload`; they are forbidden from response projection and route selection.

Current protocol/conversion batch coverage evidence:

- `npm run audit:resource-global-coverage` reports `resources: 82`.
- Mainline resource flow coverage remains `108/108`.
- Active feature resource binding coverage increased from `88/119` to `95/119`.
- `missing_resource_flow_edges` remains empty.
- The protocol/conversion priority batch no longer appears in the missing binding list.

Verified gates for this map-only slice:

- `npm run verify:resource-operation-map`
- `npm run audit:resource-global-coverage`
- `npm run verify:resource-owner-uniqueness`
- `npm run verify:resource-mainline-bindings`
- `npm run verify:resource-forbidden-writes`
- `npm run verify:resource-side-channel-isolation`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `git diff --check`

Next-layer backlog:

- Error/VR/pipeline contract surfaces: `error.backoff_action_queue`, `vr.route_selection`, `hub.route_metadata_surface`, `vr.route_retry_pin_surface`, `hub.pipeline_contract_surface`, `server.rust_contract_surface`, and `tool.apply_patch_freeform_contract`.
- Snapshot/debug surfaces: `snapshot.stage_contract`, `snapshot.provider_error_buffer`, and `provider.debug_example_hooks_surface`.
- Config codec/path/coercion features: `config.path_resolution_surface`, `config.toml_codec`, `config.user_config_codec`, `config.provider_config_codec`, and `config.provider_config_coercion`.
- Manager/daemon/SSE residuals: `manager.routing_control_surface`, `manager.health_runtime`, `daemon_admin.command_handlers`, `daemon_admin.auth_gate_shell`, `sse.runtime_rust_dispatch`, `sse.stream_parse_boundary`, `sse.event_type_validation`, `sse.responses_decode_projection`, and `sse.responses_encode_projection`.

## Design Principles

- Unique resource identity does not mean one global mutable object.
- Unique owner does not mean one monolithic implementation file.
- Request/response normal payload, metadata, error, snapshot, dry-run, continuation, route, provider runtime, and SSE frames are separate resources.
- Each resource has one canonical writer per lifecycle stage and only explicitly allowed readers.
- Every resource operation must bind to a feature owner and a mainline node.
- Only adjacent lifecycle nodes may transform resources.
- Side-channel resources must not enter provider wire payload or client normal payload.
- Provider-specific behavior belongs in provider runtime, not Hub Pipeline or Virtual Router.
- Continuation save/restore stays in Chat Process lifecycle boundaries.
- Dry-run observes current live/sample paths and must not become a second request or response converter.

## Technical Plan

### New Architecture Artifacts

- `docs/architecture/resource-taxonomy.md`
  - Human-readable resource classes, identities, lifecycle boundaries, allowed persistence, and forbidden payload crossings.
- `docs/architecture/resource-operation-map.yml`
  - Machine-readable owner/read/write/project/forbidden map for each resource operation.
- Optional later artifact: `docs/architecture/resource-mainline-map.yml`
  - Only add if `mainline-call-map.yml` becomes too dense. Prefer extending existing mainline call map first.

### Existing Architecture Artifacts To Extend

- `docs/architecture/function-map.yml`
  - Add `resource_bindings` for key features.
- `docs/architecture/mainline-call-map.yml`
  - Add `resource_flow` to adjacent mainline edges.
- `docs/architecture/verification-map.yml`
  - Add resource gate requirements.
- `docs/architecture/mainline-manifest*.yml` or related manifests if existing gates require synchronization.
- `.agents/skills/rcc-dev-skills/*`
  - Add reusable lessons after stable resource mapping and gates are proven.

### M0 Resource Coverage

Cover these resources first:

- `request.normal_payload`
- `request.protocol_context`
- `request.provider_semantic`
- `provider.wire_payload`
- `response.provider_raw`
- `response.hub_semantic`
- `response.client_payload`
- `metadata.runtime_control`
- `metadata.request_truth`
- `metadata.response_observation`
- `error.chain`
- `route.selection`
- `provider_runtime.observation`
- `continuation.scope_state`
- `dryrun.provider_request_probe`
- `snapshot.debug_sample`
- `sse.transport_frame`
- `servertool.followup_state`

### M0 Feature Coverage

Bind resources for these features first:

- `request.mainline`
- `response.mainline`
- `error.mainline`
- `hub.metadata_center_mainline`
- `responses.continuation.mainline`
- `responses.direct_passthrough.mainline`
- `debug.pipeline_dry_run_loop`
- `vr.route_availability`
- `vr.online_diagnostics`
- `sse.chat_stream_projection`
- `servertool.hook_skeleton`
- `stopless.session`

### Gate Plan

Add package scripts only after the verifier exists:

- `verify:resource-operation-map`
- `verify:resource-owner-uniqueness`
- `verify:resource-mainline-bindings`
- `verify:resource-forbidden-writes`
- `verify:resource-side-channel-isolation`

The first verifier should check:

- Resource operation map is parseable.
- Each `resource_id` has an owner feature and owner node.
- Each writer maps to an existing feature in function map.
- Each required gate maps to verification map or an existing package script.
- Function map resource bindings reference declared resources.
- Mainline resource flows reference declared resources and known node IDs.
- Forbidden writer entries are syntactically valid and queryable.

Later verifiers should add static scans for:

- Metadata/debug/snapshot/error fields leaking into provider wire payload builders.
- Continuation save/restore outside Chat Process owner nodes.
- Non-adjacent resource conversion helpers.
- Duplicate writer helpers for the same resource operation.

## Implementation Order

1. Read current `AGENTS.md`, `docs/agent-routing/05-foundation-contract.md`, `docs/agent-routing/00-entry-routing.md`, `.agents/skills/rcc-dev-skills/SKILL.md`, function map, verification map, mainline call map, and relevant wiki/manifest docs.
2. Create resource taxonomy and M0 resource operation map.
3. Extend function map with `resource_bindings` for M0 features.
4. Extend mainline call map with adjacent `resource_flow` for M0 edges.
5. Extend verification map and package scripts for the first resource verifier.
6. Implement the first static verifier and run it red/green against intentionally missing/invalid map entries where practical.
7. Run existing architecture gates to ensure map changes remain consistent.
8. Do an architecture review before touching runtime code.
9. Pick one low-risk pilot resource, preferably `dryrun.provider_request_probe` or `metadata.runtime_control.providerProtocol`.
10. Refactor only that resource operation to the unique owner; physically remove duplicate helpers only after tests and maps prove they are dead.
11. Verify with unit/contract gates plus dry-run/live sample replay where the changed resource affects runtime behavior.
12. Update `note.md`, `MEMORY.md`, local skills, and MemPalace after verified conclusions.

## M0 Pilot Resource Plan

Pilot resource: `dryrun.provider_request_probe`.

Reason:

- It is diagnostic-only and already has a focused owner, `debug.pipeline_dry_run_loop`.
- It touches request final-provider-request observation and response black-box replay without owning provider/runtime business semantics.
- It has existing concrete gates: `verify:resource-operation-map`, `test:pipeline-dry-run`, provider-request sample replay, and response dry-run.

Pilot constraints:

- Do not create a global request/response manager.
- Do not make dry-run a second request builder or second response converter.
- Keep provider-request dry-run as an observation resource over the final provider wire payload.
- Keep response dry-run as a black-box call through `convertProviderResponseIfNeeded`.
- Any runtime pilot change must first update the resource operation map and mainline `resource_flow`, then run resource gate red/green.

Pilot acceptance:

- `dryrun.provider_request_probe` has a single owner feature in function map.
- The dry-run mainline edges `ddr-02` and `ddr-04` have resource flows in both `resource-operation-map.yml` and `mainline-call-map.yml`.
- `verify:resource-operation-map` proves function-map bindings and mainline flows stay consistent.
- Runtime behavior is verified with provider-request dry-run and response dry-run only if code changes are made.

## Risk And Mitigation

- Risk: Creating a global mutable manager that bypasses pipeline nodes.
  - Mitigation: Maps and gates define resource ownership first; runtime code remains stage-bound.
- Risk: Resource map becomes documentation-only.
  - Mitigation: Add parseability, owner uniqueness, binding, and forbidden-write gates in M0.
- Risk: Provider-specific fixes leak into Hub/VR.
  - Mitigation: Resource map must classify provider wire/resource operations under provider runtime owners.
- Risk: Continuation lifecycle is accidentally widened.
  - Mitigation: Explicitly mark `continuation.scope_state` save/restore nodes and forbid handler/outbound/SSE writes.
- Risk: Dry-run or snapshot becomes alternate runtime truth.
  - Mitigation: Mark dry-run and snapshot as observation resources only.
- Risk: Large refactor breaks unrelated dirty work.
  - Mitigation: Work resource-by-resource, avoid broad checkout/reset, and stage only exact files if committing.

## Verification Matrix

M0 documentation/gate verification:

- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `git diff --check`

Pilot runtime refactor verification:

- Focused unit/contract tests for the resource owner.
- Existing architecture gates above.
- `npx tsc --noEmit --pretty false`
- `npm run build:base`
- If behavior changes: global install, live `/health`, request dry-run for request-side bugs, response dry-run for response-side bugs, and old sample replay.

## Definition Of Done

- M0 resource taxonomy and operation map are committed in docs.
- M0 function map and mainline call map resource bindings are machine-validated.
- Resource verifier gates pass.
- No runtime refactor is claimed complete unless resource ownership, tests, build, and live/sample verification match the changed resource.
- Local skills and project memory capture reusable resource-ownership rules and anti-patterns.
