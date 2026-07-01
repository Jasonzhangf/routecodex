<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Servertool Ownership Map

把 servertool 的 owner、验证栈、允许修改路径、禁止修改路径集中成一页，避免在 followup/CLI/stopless/backend-route 多文件里改错层。

Source of truth:
- `docs/architecture/function-map.yml` defines owner, builders, paths, and gates
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`

Feature scope: `hub.servertool_*`

| feature_id | summary | owner kind | owner module | required gates |
| --- | --- | --- | --- | --- |
| `hub.servertool_followup` | servertool followup orchestration and governed response truth | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run verify:servertool-rust-only` |
| `hub.servertool_engine_selection` | servertool primary auto-hook first pass and rerun selection planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_cli_projection` | servertool execution migrates to client-visible exec_command CLI projection with status-only CLI input | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run build:base`<br/>`npm run verify:architecture-ci` |
| `hub.servertool_stopless_cli_continuation` | stop_message_auto current-turn CLI continuation planning inside Chat Process request/response boundary | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src` | `npm run verify:stopless-invalid-schema-blackbox`<br/>`npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_auto_hook_execution` | servertool auto-hook runtime attempt, trace, and caller finalization planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_runtime_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_engine_preflight_contract` | servertool engine preflight early-return planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_engine_runtime_action_contract` | servertool engine runtime action planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_engine_skip_contract` | servertool engine skip planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_branch_contract` | servertool execution branch and CLI projection target planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_dispatch_contract` | servertool execution dispatch error and followup contract planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_dispatch_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_handler_contract` | servertool handler materialization planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_loop_effect_contract` | servertool execution loop effect planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_loop_runtime_action_contract` | servertool execution loop runtime action planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_outcome_runtime_action_contract` | servertool execution outcome runtime action planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_execution_state_contract` | servertool execution loop state creation and append planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_registry_contract` | servertool registry lookup, auto-hook descriptor, and projection planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_response_stage_runtime_action_contract` | servertool response-stage runtime action planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/response_stage_runtime_action_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_server_side_tool_entry_contract` | servertool entry preflight action planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_stopless_cli_projection_context` | stopless CLI projection context planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_flow_presentation` | servertool progress log tool-name and highlight presentation policy | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_loop_warning` | stop-message loop warning text/count injection and seed payload bridge | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/followup-core/src` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_rust_only_closeout` | servertool hook skeleton closeout gate; proves remaining TS orchestration has been reduced to thin shells before physical deletion and anchors the Rust hook skeleton contract | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate`<br/>`npm run verify:architecture-mainline-call-map` |
| `hub.servertool_orchestration_policy` | servertool timeout, client-inject, followup error, and adapter provider-key policy | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |

## hub.servertool_followup

Summary: servertool followup orchestration and governed response truth

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
Owner scope: servertool followup orchestration and governed response truth

Canonical types:
- `HubRespChatProcess03Governed`
- `HubRespOutbound04ClientSemantic`

Canonical builders:
- `project_hub_resp_outbound_04_from_hub_resp_chatprocess_03`
- `run_servertool_response_stage_json`
- `plan_servertool_outcome_json`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- `sharedmodule/llmswitch-core/src/conversion/hub/response`
- `src/modules/llmswitch/bridge`

Forbidden paths:
- `src/providers`
- `src/server`

Required tests:
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`
- `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
- `tests/red-tests/hub_pipeline_reasoning_tool_parser_shell_deleted.test.ts`

Required gates:
- `npm run verify:servertool-rust-only`

Notes:
- Rust owns orchestration semantics; TS only bridge/reentry/IO.
- Zero-consumer TS reasoning tool parser shell must stay physically deleted; native reasoning tool extraction is exposed through the text-markup native wrapper owner.

## hub.servertool_engine_selection

Summary: servertool primary auto-hook first pass and rerun selection planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs`
Owner scope: servertool primary auto-hook first pass and rerun selection planning

Canonical types:
- `EngineSelectionStartInput`
- `EngineSelectionStartPlan`
- `EngineSelectionAfterRunInput`
- `EngineSelectionAfterRunPlan`
- `EngineSelectionAction`

Canonical builders:
- `plan_engine_selection_start`
- `plan_engine_selection_after_run`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-selection-block.ts`
- `tests/servertool/engine-selection-block.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/engine-selection-block.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns whether to run default engine, run primary auto hooks first, return current result, or rerun excluding primary hooks.
- TS engine-selection-block may only read skeleton queue config, call native plans, and execute the planned runEngine calls.
- Do not restore local `primaryAutoHookIds.length`, `engineResult.mode`, or `!engineResult.execution` selection policy in TS.

## hub.servertool_cli_projection

Summary: servertool execution migrates to client-visible exec_command CLI projection with status-only CLI input

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
Owner scope: servertool execution migrates to client-visible exec_command CLI projection with status-only CLI input

Canonical types:
- `ServertoolCliProjection01Planned`

Canonical builders:
- `build_servertool_cli_projection_01_from_hub_resp_chatprocess_03`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- `sharedmodule/llmswitch-core/src/servertool`
- `src/cli/commands`
- `src/server/handlers`
- `docs/design/servertool-cli-lifecycle.md`
- `docs/design/servertool-cli-projection-migration.md`

Forbidden paths:
- `src/providers`
- `src/providers/profile`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-stage-shell.spec.ts`
- `tests/servertool/servertool-cli-result-restore.spec.ts`
- `tests/cli/servertool-command.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`

Required gates:
- `npm run build:base`
- `npm run verify:architecture-ci`

Notes:
- Phase 1 keeps existing injection/interception but projects execution to real client exec_command.
- CLI command is `routecodex hook run <toolName> --input-json <json>`; no opaque state handle is used.
- stop_message_auto CLI input must stay concise: `flowId/repeatCount/maxRepeats/triggerHint` plus optional structured `schemaFeedback{reasonCode,missingFields}`; continuationPrompt/schema guidance/prompt preview are CLI-result-side material and must not be embedded in the command string.
- CLI execution path must not call server-side followup/reenter for migrated flows.
- `apply_patch` is excluded; it remains native/freeform client tooling.
- `servertool_fixture` CLI projection dispatch is Rust-owned; the old TS fixture handler file must stay physically deleted.

## hub.servertool_stopless_cli_continuation

Summary: stop_message_auto current-turn CLI continuation planning inside Chat Process request/response boundary

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`
Owner scope: Chat Process-owned stopless lifecycle: response-side stop/reasoningStop schema judgment plus CLI/terminal normalization, request-side CLI result restore/guidance rewrite/schema-contract reinjection

Canonical types:
- `StoplessExecutionPlanInput`
- `StoplessExecutionPlan`
- `StoplessOrchestrationPlanInput`
- `StoplessOrchestrationPlan`
- `RuntimeStopMessageStateFromMetadataCenterInput`
- `RuntimeStopMessageStateSnapshot`

Canonical builders:
- `plan_stopless_orchestration_action`
- `resolve_runtime_stop_message_state_from_metadata_center`
- `plan_client_exec_cli_projection_output`
- `resolve_stop_message_session_scope`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/effect_plan.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/tests.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `tests/servertool/stop-message-auto.goal-default.spec.ts`
- `tests/servertool/stopless-cli-continuation.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/stopless-cli-continuation.spec.ts`
- `tests/servertool/execution-stage-shell.spec.ts`
- `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
- `tests/responses/responses-openai-bridge.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `scripts/tests/stopless-invalid-schema-blackbox.mjs`
- `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_tests.rs`

Required gates:
- `npm run verify:stopless-invalid-schema-blackbox`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Stopless is not an outbound owner and not an SSE owner. Request-side stopless belongs to the ReqChatProcess entry boundary after `/v1/responses` continuation restore and before normal request governance; response-side stopless belongs to the RespChatProcess exit boundary before continuation save and before RespOutbound.
- Response-side stopless projection is a standard `ServertoolRespHook` skeleton step inside `HubRespChatProcess03Governed`, not an inline outbound/SSE patch; TS may only apply Rust effect plans such as MetadataCenter writes.
- servertool-core owns stopless CLI continuation planning; stopless must project client-visible exec_command and must not call reenterPipeline.
- req_chatprocess must always inject the stop hook contract for stopless-managed turns; missing injection is treated as a lifecycle failure and the loop-guard path must still be able to terminate after 3 no-schema stop attempts.
- Stopless is a dual-gate stop contract: `finish_reason=stop` is only the trigger to evaluate stop; terminal stop additionally requires either a valid terminal stop schema or the temporary three-round safety guard.
- Response hook gate must cover both `finish_reason=stop` text/fence schema and `finish_reason=tool_calls` registered internal servertool calls. For stopless, stop schema fence may arrive as `<rcc_stop_schema>...</rcc_stop_schema>` or standalone stop-schema JSON code fence, while `reasoningStop.arguments` remains the schema source for the tool-call trigger arm.
- `reasoningStop` is a model-facing/internal servertool name, not a client-executable tool. It must be intercepted by the response hook gate; clients may only receive shell `exec_command(routecodex hook run reasoningStop ...)` when the schema gate requires client execution/feedback.
- Stopless must not activate on same-protocol direct/provider-direct response paths; existing runtime metadata routeName is the only allowed discriminator for this bypass.
- If `finish_reason=stop` arrives without schema, RouteCodex must auto-project the same stop hook (internal `stop_message_auto`, public CLI alias `reasoningStop`) with no schema input and use the hook result to tell the model it must provide the schema / call the same hook before terminal stop.
- If `finish_reason=stop` arrives with schema but the schema is non-terminal, invalid, or argument-malformed, RouteCodex must auto-project the same stop hook with schema-derived input so the hook can explain why stop is denied and what must be fixed.
- Stop schema fields are conditionally required, not globally required: `stopreason` is the only unconditional field; `stopreason=0` requires `has_evidence=1` plus non-empty `evidence`; `stopreason=1` requires non-empty `reason` and may stop with reason only; `stopreason=2` requires `next_step`; diagnostic fields are optional unless a future rule explicitly makes them conditional.
- For `stopreason=2`, the provider-facing continuation text must be the `next_step` content itself. For `blocked + needs_user_input=true`, the finalized client response must include the summary plus the user decision question and stop with `finish_reason=stop`.
- For invalid/malformed schema, the stop hook must return concise structured feedback (`reasonCode`, `missingFields`) plus schemaGuidance, and req_chatprocess must rewrite the paired tool result into natural-language corrective guidance instead of replaying raw tool history.
- If `finish_reason=stop` arrives with schema and the schema satisfies terminal stop conditions, RouteCodex may allow final stop whether or not the model proactively called the stop hook.
- When stopless auto-projects the stop hook because the model did not proactively call it, the returned CLI result must be rewritten during req_chatprocess into text guidance for the next model turn, not preserved as model-owned tool-call history.
- When the client executes the shell projection and submits the result, request-side hooks must restore model-visible history as `reasoningStop -> function_call_output`; raw `exec_command` shell history must not become model truth.
- For `/v1/responses`, req-side stopless contract cannot rely on `messages` only: the request mainline must preserve the contract in `instructions`, and the responses bridge must materialize that contract back into the outbound chat/system message before provider wire build.
- CLI command input stays concise/status-only: `flowId/repeatCount/maxRepeats/triggerHint` plus optional structured `schemaFeedback{reasonCode,missingFields}`; continuationPrompt/schemaGuidance are CLI-result-side material and must not be embedded in the command string.
- Client-visible exec_command must use the public stopless alias `reasoningStop`; the client payload must not leak internal marker `__servertool_cli_projection`.
- NoSchema is not a schema-less stop contract: model-facing schema guidance is locked by the provider-visible stopless system instruction and the `reasoningStop` tool description/schema; CLI stdout must keep the public `input.triggerHint=no_schema`, while `schemaGuidance` is not a required stdout field.
- NoSchema stopless progression must advance `used/repeatCount` from current request tool_output/runtime metadata truth, not through file persistence or tmux/sessionDir fallback.
- Response-side stopless activation must read the current request-scoped control slot `MetadataCenter.runtime_control.stopless.active`; tests must cover this live shape, not legacy `requestTruth.runtimeControl` or top-level metadata mirrors.
- Once the standard `reasoningStop` tool is exposed on the request, legacy shell-projected stop history such as `exec_command(cmd="reasoningStop")`, `reasoning_stop`, and their paired `command not found` tool outputs must be physically removed during req-side normalization instead of replayed into later provider requests.
- Model side must stay unaware of stopless identity. Stopless identity comes from write-once `request_truth.sessionId/requestId`; stopless control and progression come from Rust-produced `MetadataCenter.runtime_control.stopless` plus current request tool_output. `sessionDir`/persisted writeback and `requestTruth.runtimeControl` are forbidden.
- ReqChatProcess is the standard write origin for stopless runtime control: Rust request governance emits `metadata.runtime_control.stopless`, and the TS request-stage shell may only commit that Rust plan into the bound MetadataCenter with fail-fast binding checks.
- Stopless execution/control composition and orchestration planning are owned by the Rust Chat Process engine; TS may only expose unavoidable external IO/native-call shells and must not build stopless context/requestTruth/session truth or reenter for stopless CLI flows.
- The builtin TS catalog may only call the Rust materialized bridge `runStoplessBuiltinHandlerForRuntimeJson`; it must not interpret stopless runtime actions or construct finalize/error handler semantics locally.
- Do not restore tmux/conversation/inject scope fallback, file persistence, or server-side stopless followup/reenter.
- `responsesRequestContext.sessionId/conversationId` is continuation-only context for `/v1/responses`; it must never be promoted into request session truth, stopless activation input, stop-message session scope, or routing state key material.

## hub.servertool_auto_hook_execution

Summary: servertool auto-hook runtime attempt, trace, and caller finalization planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_runtime_contract.rs`
Owner scope: servertool auto-hook runtime attempt, trace, and caller finalization planning

Canonical types:
- `AutoHookRuntimeAttemptInput`
- `AutoHookRuntimeAttemptPlan`
- `AutoHookCallerFinalizationInput`
- `AutoHookCallerFinalizationPlan`
- `AutoHookTraceEventPlan`

Canonical builders:
- `plan_auto_hook_runtime_attempt`
- `plan_auto_hook_caller_finalization`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_execution_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_runtime_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts`
- `tests/servertool/servertool-auto-hook-trace.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/servertool-auto-hook-trace.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns auto-hook attempt disposition, trace planning, and optional-to-mandatory queue finalization.

## hub.servertool_engine_preflight_contract

Summary: servertool engine preflight early-return planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs`
Owner scope: servertool engine preflight early-return planning

Canonical types:
- `ServertoolEnginePreflightInput`
- `ServertoolEnginePreflightAction`
- `ServertoolEnginePreflightPlan`

Canonical builders:
- `plan_servertool_engine_preflight`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/engine.stopless-session-thin-shell.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns engine preflight action planning.

## hub.servertool_engine_runtime_action_contract

Summary: servertool engine runtime action planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`
Owner scope: servertool engine runtime action planning

Canonical types:
- `ServertoolEngineRuntimeActionInput`
- `ServertoolEngineRuntimeAction`
- `ServertoolEngineRuntimeActionPlan`

Canonical builders:
- `plan_servertool_engine_runtime_action`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/engine.stopless-session-thin-shell.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns engine runtime action selection.

## hub.servertool_engine_skip_contract

Summary: servertool engine skip planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs`
Owner scope: servertool engine skip planning

Canonical types:
- `ServertoolEngineSkipInput`
- `ServertoolEngineSkipAction`
- `ServertoolEngineSkipPlan`

Canonical builders:
- `plan_servertool_engine_skip`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/engine.stopless-session-thin-shell.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns engine skip planning.

## hub.servertool_execution_branch_contract

Summary: servertool execution branch and CLI projection target planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`
Owner scope: servertool execution branch and CLI projection target planning

Canonical types:
- `ServertoolExecutableToolCall`
- `ServertoolExecutionBranchPlanInput`
- `ServertoolExecutionBranchAction`
- `ServertoolExecutionBranchPlan`

Canonical builders:
- `plan_servertool_execution_branch`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns execution branch selection and projected tool index planning.

## hub.servertool_execution_dispatch_contract

Summary: servertool execution dispatch error and followup contract planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_dispatch_contract.rs`
Owner scope: servertool execution dispatch error and followup contract planning

Canonical types:
- `ServertoolDispatchSpecMismatchErrorInput`
- `ServertoolInvalidMixedClientToolsOutcomeErrorInput`
- `ServertoolMissingExecutionContractErrorInput`

Canonical builders:
- `plan_servertool_dispatch_spec_mismatch_error`
- `plan_servertool_invalid_mixed_client_tools_outcome_error`
- `plan_servertool_missing_execution_contract_error`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_dispatch_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns dispatch mismatch and missing execution-contract error planning.

## hub.servertool_execution_handler_contract

Summary: servertool handler materialization planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`
Owner scope: servertool handler materialization planning

Canonical types:
- `ServertoolHandlerMaterializationInput`
- `ServertoolHandlerMaterializationPlan`

Canonical builders:
- `plan_servertool_handler_materialization`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
- `tests/servertool/execution-shell.backend-failfast.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-shell.backend-failfast.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns handler materialization action and error-plan composition; retired progress/runtime public bridges must stay absent.

## hub.servertool_execution_loop_effect_contract

Summary: servertool execution loop effect planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs`
Owner scope: servertool execution loop effect planning

Canonical types:
- `ServertoolExecutionLoopEffectInput`
- `ServertoolExecutionLoopEffectPlan`

Canonical builders:
- `plan_servertool_execution_loop_effect`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts`
- `tests/servertool/execution-shell.backend-failfast.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-shell.backend-failfast.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns execution loop effect planning; TS must not mutate loop state as a second owner.

## hub.servertool_execution_loop_runtime_action_contract

Summary: servertool execution loop runtime action planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs`
Owner scope: servertool execution loop runtime action planning

Canonical types:
- `ServertoolExecutionLoopRuntimeActionInput`
- `ServertoolExecutionLoopRuntimeActionPlan`

Canonical builders:
- `plan_servertool_execution_loop_runtime_action`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts`
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns execution loop runtime action planning.

## hub.servertool_execution_outcome_runtime_action_contract

Summary: servertool execution outcome runtime action planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`
Owner scope: servertool execution outcome runtime action planning

Canonical types:
- `ServertoolExecutionOutcomeRuntimeActionInput`
- `ServertoolExecutionOutcomeRuntimeActionPlan`

Canonical builders:
- `plan_servertool_execution_outcome_runtime_action`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-dispatch-outcome-shell.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns execution outcome runtime action planning.

## hub.servertool_execution_state_contract

Summary: servertool execution loop state creation and append planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs`
Owner scope: servertool execution loop state creation and append planning

Canonical types:
- `ServertoolExecutionSummary`
- `ServertoolExecutedToolCall`
- `ServertoolExecutedRecord`
- `ServertoolExecutionLoopStateValue`
- `ServertoolAppendExecutedRecordInput`

Canonical builders:
- `create_servertool_execution_loop_state`
- `append_executed_tool_record`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
- `tests/servertool/execution-shell.backend-failfast.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/execution-shell.backend-failfast.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns execution state create/append semantics.

## hub.servertool_registry_contract

Summary: servertool registry lookup, auto-hook descriptor, and projection planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`
Owner scope: servertool registry lookup, auto-hook descriptor, and projection planning

Canonical types:
- `ServertoolRegistryLookupActionInput`
- `ServertoolRegistryAutoHookDescriptorInput`
- `ServertoolRegistryProjectionInput`
- `ServertoolRegistryProjectionPlan`
- `ServertoolRegistrySourceProjectionInput`
- `ServertoolRegistrySourceProjectionPlan`

Canonical builders:
- `plan_servertool_registry_lookup_action`
- `plan_servertool_registry_auto_hook_descriptors`
- `plan_servertool_registry_projection`
- `plan_servertool_registry_source_projection`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts`
- `tests/servertool/registry-orchestration-shell.spec.ts`
- `tests/servertool/server-side-tools.auto-hook-config.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/registry-orchestration-shell.spec.ts`
- `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns registry lookup, ordering, and projection planning.

## hub.servertool_response_stage_runtime_action_contract

Summary: servertool response-stage runtime action planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/response_stage_runtime_action_contract.rs`
Owner scope: servertool response-stage runtime action planning

Canonical types:
- `ServertoolResponseStageRuntimeActionInput`
- `ServertoolResponseStageRuntimeAction`
- `ServertoolResponseStageRuntimeActionPlan`

Canonical builders:
- `plan_servertool_response_stage_runtime_action`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/response_stage_runtime_action_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/response-stage-orchestration-shell.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns response-stage runtime action planning.

## hub.servertool_server_side_tool_entry_contract

Summary: servertool entry preflight action planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs`
Owner scope: servertool entry preflight action planning

Canonical types:
- `ServertoolEntryPreflightInput`
- `ServertoolEntryPreflightAction`
- `ServertoolEntryPreflightPlan`

Canonical builders:
- `plan_servertool_entry_preflight`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/entry-context-shell.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/entry-context-shell.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns non-object passthrough / disconnected fail-fast / continue entry preflight decisions.

## hub.servertool_stopless_cli_projection_context

Summary: stopless CLI projection context planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`
Owner scope: stopless CLI projection context planning

Canonical types:
- `StoplessCliProjectionRuntimeSnapshotInput`
- `StoplessCliProjectionContextInput`
- `StoplessCliProjectionContextPlan`

Canonical builders:
- `plan_stopless_cli_projection_context`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `tests/servertool/engine.stopless-session-thin-shell.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`

Required tests:
- `tests/servertool/engine.stopless-session-thin-shell.spec.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns stopless CLI projection context planning; TS engine remains a thin shell.

## hub.servertool_flow_presentation

Summary: servertool progress log tool-name and highlight presentation policy

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
Owner scope: file-scoped Rust owner for servertool progress log tool-name and highlight presentation policy

Canonical types:
- `ServertoolProgressPresentationInput`
- `ServertoolProgressPresentationDecision`

Canonical builders:
- `resolve_servertool_progress_tool_name_json`
- `should_use_servertool_gold_progress_highlight_json`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts`
- `sharedmodule/llmswitch-core/tests/servertool/followup-flow-policy.test.ts`
- `tests/servertool/servertool-progress-logging.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/servertool-progress-logging.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust skeleton config owns flow id normalization, progress tool-name resolution, and gold highlight decisions.
- progress-log-block.ts may only call native flow presentation wrappers.
- TS skeleton-config is physically deleted; progress presentation must stay in Rust/native wrappers.
- Do not restore local `normalizeFlowId`, `buildServertoolProgressConfig`, `toolNameByFlowId`, `goldHighlightFlowIds`, or Set-based highlight policy in TS.

## hub.servertool_loop_warning

Summary: stop-message loop warning text/count injection and seed payload bridge

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/followup-core/src`
Owner scope: stop-message loop warning text/count injection and seed payload bridge

Canonical types:
- `LoopWarningInput`
- `ServertoolReq04FollowupPayload`

Canonical builders:
- `inject_loop_warning`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/followup-core/src`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/followup_mainline_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/servertool/stopless-cli-continuation.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Loop warning text and repeat-count policy stay Rust-owned in followup-core.
- Deleted TS loop-state/scope/loop-warning shells must not be restored; Rust/followup-core and Chat Process native bridge own this path.
- `appendStopMessageLoopWarning` must not return as a TS semantic owner/export.

## hub.servertool_rust_only_closeout

Summary: servertool hook skeleton closeout gate; proves remaining TS orchestration has been reduced to thin shells before physical deletion and anchors the Rust hook skeleton contract

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs`
Owner scope: servertool rust-only closeout gate and Rust hook skeleton contract anchors (validate, scheduler, phase contract)

Canonical types:
- `ServertoolHookSpec`
- `ServertoolHookSchedulerInput`
- `ServertoolHookEvent`
- `ServertoolHookProjection`
- `ServertoolHookEffectPlan`
- `ServertoolHookSkeletonError`

Canonical builders:
- `validate_servertool_hook_spec`
- `plan_servertool_hook_schedule`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`
- `tests/servertool/response-stage-prepass-shell.spec.ts`
- `tests/servertool/execution-queue-shell.spec.ts`
- `tests/servertool/execution-stage-shell.spec.ts`
- `tests/servertool/entry-context-shell.spec.ts`
- `tests/servertool/run-server-side-tool-engine-shell.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/servertool-cli-native-bridge.spec.ts`
- `tests/servertool/server-side-tools.dispatch-native.spec.ts`
- `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
- `tests/servertool/servertool-auto-hook-trace.spec.ts`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`
- `tests/servertool/response-stage-prepass-shell.spec.ts`
- `tests/servertool/execution-queue-shell.spec.ts`
- `tests/servertool/execution-stage-shell.spec.ts`
- `tests/servertool/entry-context-shell.spec.ts`
- `tests/servertool/run-server-side-tool-engine-shell.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
- `tests/servertool/servertool-auto-hook-trace.spec.ts`
- `tests/servertool/server-side-tools.dispatch-native.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`

Notes:
- This feature registers the closeout gate only; it does not declare `servertool.hook_skeleton.mainline` anchored.
- `docs/architecture/mainline-call-map.yml` `chain_id: servertool.hook_skeleton.mainline` must remain `binding pending` until Rust owner symbols and blackbox gates exist for runtime owners.
- Re-introducing TS business semantics in any of the listed allowed shell files is fail-fast.

## hub.servertool_orchestration_policy

Summary: servertool timeout, client-inject, followup error, and adapter provider-key policy

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs`
Owner scope: servertool timeout, client-inject, followup error, and adapter provider-key policy

Canonical types:
- `ServertoolTimeoutPolicyInput`
- `ServertoolTimeoutWatcherPlan`
- `ServertoolClientDisconnectWatcherPlan`
- `ServertoolErrorPlan`
- `ServertoolClientInjectTextInput`
- `ServertoolProviderKeyInput`

Canonical builders:
- `parse_servertool_timeout_ms`
- `plan_servertool_timeout_watcher`
- `is_adapter_client_disconnected`
- `plan_client_disconnect_watcher`
- `plan_servertool_client_disconnected_error`
- `plan_servertool_timeout_error`
- `plan_stop_message_fetch_failed_error`
- `read_client_inject_only`
- `normalize_client_inject_text`
- `compact_followup_error_reason`
- `resolve_adapter_context_provider_key`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts`
- `tests/servertool/engine-preflight-shell.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/timeout-error-block.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/engine-preflight-shell.spec.ts`
- `tests/servertool/timeout-error-block.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns timeout parsing, timeout watcher planning, client disconnect detection/watcher planning, and servertool error payload planning.
- Deleted TS orchestration-policy-block must stay absent; active engine timeout env IO lives in engine-orchestration-shell and synthetic control detection calls native directly from engine-preflight-shell.
- TS server-side-tools may only consume `isAdapterClientDisconnected` from the native timeout-error shell; it must not restore local adapter disconnect scanning.
- TS timeout-error-block may only execute timer/AbortController/Error-object glue from native plans.
- Do not restore local `parseTimeoutMs`, `parseBooleanLike`, text sanitizer, error regex compaction, providerKey walker, stop-gateway wrapper, local disconnect watcher policy, or timeout/error payload builders.
