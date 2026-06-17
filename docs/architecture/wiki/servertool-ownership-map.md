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
| `hub.servertool_pending_session` | servertool pending-session store and pending injection persist planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_pre_command_hooks` | servertool pre-command hook config and rule normalization | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_engine_selection` | servertool primary auto-hook first pass and rerun selection planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_cli_projection` | servertool execution migrates to client-visible exec_command CLI projection with status-only CLI input | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src` | `npm run build:min`<br/>`npm run verify:architecture-ci` |
| `hub.servertool_stopless_cli_continuation` | stop_message_auto runtime-metadata-only CLI continuation planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_flow_presentation` | servertool progress log tool-name and highlight presentation policy | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_loop_warning` | stop-message loop warning text/count injection and seed payload bridge | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/followup-core/src` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_orchestration_policy` | servertool timeout, client-inject, followup error, and adapter provider-key policy | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |
| `hub.servertool_backend_route_runtime` | servertool backend-route followup endpoint, payload, injection, metadata, error envelope, and bootstrap replay planning | `rust_ssot` | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs` | `npm run verify:servertool-rust-only`<br/>`npm run verify:function-map-compile-gate` |

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
- `tests/sharedmodule/servertool-pending-session.spec.ts`
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`
- `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
- `tests/red-tests/hub_pipeline_reasoning_tool_parser_shell_deleted.test.ts`

Required gates:
- `npm run verify:servertool-rust-only`

Notes:
- Rust owns orchestration semantics; TS only bridge/reentry/IO.
- Zero-consumer TS reasoning tool parser shell must stay physically deleted; native reasoning tool extraction is exposed through the text-markup native wrapper owner.

## hub.servertool_pending_session

Summary: servertool pending-session store and pending injection persist planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs`
Owner scope: servertool pending-session store and pending injection persist planning

Canonical types:
- `PendingServerToolInjectionPlan`
- `PendingInjectionPersistPlan`
- `PendingInjectionPersistErrorPlan`
- `PendingSessionLoadPlan`

Canonical builders:
- `resolve_pending_file_name`
- `resolve_pending_max_age_ms`
- `plan_pending_session_save`
- `plan_pending_session_load`
- `plan_pending_injection_persist`
- `plan_pending_injection_persist_error`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/pending-session.ts`
- `sharedmodule/llmswitch-core/src/servertool/pending-injection-block.ts`
- `tests/sharedmodule/servertool-pending-session.spec.ts`
- `tests/servertool/pending-session.spec.ts`
- `tests/servertool/pending-injection-block.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/sharedmodule/servertool-pending-session.spec.ts`
- `tests/servertool/pending-session.spec.ts`
- `tests/servertool/pending-injection-block.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns pending file-name sanitization, max-age parsing/defaulting, save/load payload coercion, stale/malformed/drop decisions, pending injection session dedupe, persist record planning, and persistence error envelope construction.
- TS pending-session may only consume explicit runtime workdir/sessionDir input and execute file IO using native plans; do not recover session identity from env/top-level fallback.
- TS pending-injection-block may only call native persist/error planners and execute save IO.
- Do not restore local max-age parsing, segment sanitization, payload coercion, stale/malformed drop policy, aliasSessionIds dedupe, pending injection payload construction, or `SERVERTOOL_PENDING_INJECTION_FAILED` envelope assembly in TS.

## hub.servertool_pre_command_hooks

Summary: servertool pre-command hook config and rule normalization

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`
Owner scope: servertool pre-command hook config and runtime-rule normalization

Canonical types:
- `PreCommandHooksConfigPlanInput`
- `PreCommandHooksConfigPlan`
- `PreCommandHookRulePlan`
- `PreCommandRegexPlan`
- `RuntimePreCommandRulePlanInput`

Canonical builders:
- `plan_pre_command_hooks_config`
- `plan_runtime_pre_command_rule`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.ts`
- `tests/servertool/pre-command-hooks.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/pre-command-hooks.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns pre-command config enable/disable, hook rule normalization, hook id sanitization, tool-set default/dedupe/normalize, regex source/flags planning, timeout clamp/default, priority parsing, and runtime pre-command rule planning.
- TS pre-command-hooks may only read config/env/cache, materialize Rust regex plans, parse current tool args, and run jq/shell/runtime script IO.
- Do not restore local normalize/sanitize/timeout/priority/tool-set policy in TS.

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
- `tests/servertool/servertool-cli-projection.spec.ts`
- `tests/servertool/servertool-cli-result-restore.spec.ts`
- `tests/cli/servertool-command.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`

Required gates:
- `npm run build:min`
- `npm run verify:architecture-ci`

Notes:
- Phase 1 keeps existing injection/interception but projects execution to real client exec_command.
- CLI command is `routecodex hook run <toolName> --input-json <json>`; no opaque state handle is used.
- stop_message_auto CLI input must include only flowId, repeatCount, and maxRepeats when stopless state is available; continuationPrompt/schema guidance/prompt preview are request-side internal material and must not be client-visible.
- CLI execution path must not call server-side followup/reenter for migrated flows.
- `apply_patch` is excluded; it remains native/freeform client tooling.
- `servertool_fixture` CLI projection dispatch is Rust-owned; the old TS fixture handler file must stay physically deleted.

## hub.servertool_stopless_cli_continuation

Summary: stop_message_auto runtime-metadata-only CLI continuation planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`
Owner scope: stop_message_auto runtime metadata + current tool_output continuation planning

Canonical types:
- `StoplessOrchestrationPlanInput`
- `StoplessOrchestrationPlan`
- `RuntimeStopMessageStateFromAdapterContextInput`
- `RuntimeStopMessageStateSnapshot`

Canonical builders:
- `plan_stopless_orchestration_action`
- `resolve_runtime_stop_message_state_from_adapter_context`
- `plan_client_exec_cli_projection_output`
- `resolve_stop_message_session_scope`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `tests/servertool/stop-message-auto.goal-default.spec.ts`
- `tests/servertool/stopless-cli-continuation.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/stopless-cli-continuation.spec.ts`
- `tests/servertool/servertool-cli-projection.spec.ts`
- `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns stopless CLI continuation planning; stopless must project client-visible exec_command and must not call reenterPipeline.
- req_chatprocess must always inject the stop hook contract for stopless-managed turns; missing injection is treated as a lifecycle failure and the loop-guard path must still be able to terminate after 3 no-schema stop attempts.
- Stopless is a dual-gate stop contract: `finish_reason=stop` is only the trigger to evaluate stop; terminal stop additionally requires either a valid terminal stop schema or the temporary three-round safety guard.
- Stopless must not activate on same-protocol direct/provider-direct response paths; existing runtime metadata routeName is the only allowed discriminator for this bypass.
- If `finish_reason=stop` arrives without schema, RouteCodex must auto-project the same stop hook (internal `stop_message_auto`, public CLI alias `reasoning_stop`) with no schema input and use the hook result to tell the model it must provide the schema / call the same hook before terminal stop.
- If `finish_reason=stop` arrives with schema but the schema is non-terminal, invalid, or argument-malformed, RouteCodex must auto-project the same stop hook with schema-derived input so the hook can explain why stop is denied and what must be fixed.
- For invalid/malformed schema, the stop hook must return the parse/interpretation result itself plus field/value/shape errors, so the model receives a corrective guidance loop instead of a bare rejection.
- If `finish_reason=stop` arrives with schema and the schema satisfies terminal stop conditions, RouteCodex may allow final stop whether or not the model proactively called the stop hook.
- When stopless auto-projects the stop hook because the model did not proactively call it, the returned CLI result must be rewritten during req_chatprocess into text guidance for the next model turn, not preserved as model-owned tool-call history.
- CLI command input stays status-only (`flowId/repeatCount/maxRepeats`); continuationPrompt/schemaGuidance are CLI-result-side material and must not be embedded in the command string.
- Client-visible exec_command must use the public stopless alias `reasoning_stop`; the client payload must not leak internal marker `__servertool_cli_projection`.
- NoSchema is not a schema-less stop contract: the projected CLI stdout must always carry schemaGuidance, while the command string itself must remain status-only.
- NoSchema stopless progression must advance `used/repeatCount` from current request tool_output/runtime metadata truth, not through file persistence or tmux/sessionDir fallback.
- Model side must stay unaware of stopless identity; stopless CLI command and CLI stdout no longer require `sessionId/requestId/sessionDir`, and persisted writeback must stay absent.
- TS `engine.ts` may only call `planStoplessOrchestrationActionWithNative` and `buildServertoolCliProjectionForAutoFlow`; it must not reenter for stopless CLI flows.
- Do not restore tmux/conversation/inject scope fallback, file persistence, or server-side stopless followup/reenter.

## hub.servertool_flow_presentation

Summary: servertool progress log tool-name and highlight presentation policy

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
Owner scope: servertool progress log tool-name and highlight presentation policy

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
- `sharedmodule/llmswitch-core/src/servertool/flow-presentation-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts`
- `sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts`
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
- TS flow-presentation-block may only call native wrappers.
- TS skeleton-config must not expose progress presentation projection helpers.
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
- `sharedmodule/llmswitch-core/src/servertool/stop-message-loop-payload-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-mainline-block.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/servertool/stop-message-auto.goal-default.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Loop warning text and repeat-count policy stay Rust-owned in followup-core.
- TS may only build the native seed payload and pass the native warning injector as callback glue.
- `appendStopMessageLoopWarning` must not return as a TS semantic owner/export.

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
- `sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
- `sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts`
- `tests/servertool/followup-runtime-provider-pin.spec.ts`
- `tests/servertool/server-side-tools.failfast.spec.ts`
- `tests/servertool/timeout-error-block.spec.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/followup-runtime-provider-pin.spec.ts`
- `tests/servertool/timeout-error-block.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- servertool-core owns timeout parsing, timeout watcher planning, client disconnect detection/watcher planning, servertool error payload planning, clientInjectOnly parsing, client inject text normalization, followup error compaction, and adapter provider key resolution.
- TS orchestration-policy-block may only read env/arguments and call native wrappers.
- TS server-side-tools may only consume `isAdapterClientDisconnected` from the native timeout-error shell; it must not restore local adapter disconnect scanning.
- TS timeout-error-block may only execute timer/AbortController/Error-object glue from native plans.
- Do not restore local `parseTimeoutMs`, `parseBooleanLike`, text sanitizer, error regex compaction, providerKey walker, stop-gateway wrapper, local disconnect watcher policy, or timeout/error payload builders.

## hub.servertool_backend_route_runtime

Summary: servertool backend-route followup endpoint, payload, injection, metadata, error envelope, and bootstrap replay planning

Owner kind: `rust_ssot`
Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`
Owner scope: servertool backend-route followup endpoint, payload, injection, runtime metadata, error envelope, and bootstrap replay planning

Canonical types:
- `ServertoolFollowupMaterializationInput`
- `ServertoolFollowupMaterializationPlan`
- `ServertoolFollowupRuntimeActionPlan`
- `ServertoolFollowupRuntimeMetadataPlan`
- `ServertoolFollowupErrorEnvelopePlan`
- `ServertoolBootstrapReplayPlan`

Canonical builders:
- `plan_followup_materialization`
- `plan_followup_runtime_action`
- `plan_followup_runtime_metadata`
- `plan_followup_error_envelope`
- `plan_bootstrap_replay`

Allowed paths:
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-mainline-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-bootstrap-replay-block.ts`
- `docs`

Forbidden paths:
- `src/providers`
- `src/server/runtime/http-server/executor`
- `sharedmodule/llmswitch-core/src/servertool/handlers`

Required tests:
- `tests/servertool/server-side-web-search.spec.ts`
- `tests/servertool/vision-flow.spec.ts`
- `tests/servertool/servertool-mixed-tools.spec.ts`
- `tests/servertool/followup-bootstrap-replay.spec.ts`

Required gates:
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`

Notes:
- Rust owns followupPlan `entryEndpoint` precedence and payload/injection source recognition.
- Rust owns followup terminal error envelope classification and transparent bootstrap replay preflight/replay payload planning.
- TS backend-route runtime may only call native, invoke injection IO builders, mutate metadata from Rust plans, and throw Rust-described errors.
- Do not restore local `followupPlan.payload` / `followupPlan.injection` / `entryEndpoint` scanning, chat endpoint defaults, followup terminal classification, preflight status parsing, or replay payload building in TS.
