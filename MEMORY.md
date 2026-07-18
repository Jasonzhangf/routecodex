# 2026-07-18: direct provider.model runtimes bypass scope during init; V3 compat profile loads via provider-compat-core

- In `src/server/runtime/http-server/http-server-runtime-providers.ts`, `targetRuntime` direct candidates must bypass `routingProviderScope` when initializing provider runtimes. Only base `runtime` remains scope-filtered. This prevents direct routes from failing with `Provider runtime <runtimeKey> not found`.
- V3 provider compat profile loading now uses the adjacent Rust crate `sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core`, imported from `v3/crates/routecodex-v3-runtime/src/hub_v1.rs`. The crate preserves the existing profile behavior instead of rewriting it in TS or config.
- Verified with `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/http-server-runtime-providers.create-provider-handle.spec.ts`, `npm run test:v3-provider-compat-profile-loading`, `routecodex restart --port 5520`, and live `POST /v1/responses {"model":"1token.gpt-5.5","input":"hi","stream":false}` returning upstream `HTTP_403 Insufficient account balance` instead of `ERR_PROVIDER_NOT_FOUND` / `PROVIDER_NOT_AVAILABLE`.

# 2026-07-12: Hub/runtime rustification rounds require live install/restart

- For Hub Pipeline / runtime rustification work, each implementation round must compile/build, install the target globally/release-side, restart the managed port with `routecodex restart --port <port>`, verify `routecodex --version` / `~/.rcc/install/current/package.json` / `/health.version`, inspect target server logs and samples for errors, and fix any new failures before reporting the round complete.
- Unit tests, Rust tests, `build:native-hotpath`, `build:base`, and architecture gates remain necessary preflight gates, but they are not completion evidence without the global install/restart/log check.

# 2026-07-12: function-map required gates must be package scripts

- For new function-map / verification-map features, `required_gates` and verification `smoke` entries must use queryable `npm run <script>` commands. Raw `cargo test ...` or long `npm run jest:run -- ...` entries fail `verify:architecture-owner-queryability`; add package scripts first, then bind maps to those scripts.
- Evidence: `hub.responses_request_pipeline_metadata_plan` was fixed by adding `test:responses-pipeline-metadata-plan-cargo` and `test:responses-pipeline-metadata-plan-bridge`, after which `npm run verify:function-map-compile-gate` passed.

# 2026-07-12: Responses request pipeline metadata plan is Rust-owned

- `/v1/responses` request-side pipeline metadata/control assembly is owned by `shared_responses_conversation_utils.rs::build_responses_pipeline_metadata_for_http_json`: `runtime_control.streamIntent`, `runtime_control.providerProtocol`, `runtime_control.clientAbort`, `continuation_context.responsesResume`, and direct-only `runtime_control.retryProviderKey`.
- TS bridge may only call the native planner, attach `MetadataCenter`, preserve non-serializable `clientConnectionState`, and apply returned writes; it must not locally decide provider protocol, stream intent, resume control, abort state, or direct continuation provider pin.
- Evidence: Rust focused tests, bridge metadata-center Jest, `verify:function-map-compile-gate`, `verify:hub-pipeline-native-reference-gate`, `verify:llmswitch-rustification-audit`, `build:native-hotpath`, and `build:base` passed on 2026-07-12.

# 2026-07-12: 5555 route pool excludes spark/asxs and prefers cc/free GPT

- Live 5555 routing policy group is `gateway_priority_5555`; active 5555 route pools must not reference `gpt-5.3-codex-spark` or asxs targets.
- `coding` / `thinking` / `longcontext` primary pools are weighted `fwd.glm.glm-5.2` + `fwd.free.gpt-5.5`; thinking levels are `low` / `high` / `medium`.
- 5555 `tools` / `search` / `web_search` / `multimodal` should prefer `fwd.free.gpt-5.5` before paid/minimax fallback; paid GPT fallback is `fwd.paid.gpt-5.5` (`55ai` / `1token`) and not asxs.
- `routecodex port dry-run 5555 ... --metadata-json '{"metadataCenterSnapshot":{}}'` is the fastest black-box check: a normal `gpt-5.5` request selected `cc.key1.gpt-5.5`; route status for 5555 pools had no asxs/spark. Global diagnostics may still list unrelated asxs forwarders or old spark health keys; judge the route-specific `gateway_priority_5555:*` pools and dry-run decision, not global health text.

# 2026-07-12: Provider-response timing breakdown projection is Rust-owned

- `convertProviderResponseIfNeeded` must not locally compute provider-response `timingBreakdown.clientInjectWaitMs` or default `hubResponseExcludedMs` in TS. It calls `buildProviderResponseTimingBreakdownWithNative(...)`, backed by Rust/NAPI `buildProviderResponseTimingBreakdownJson`.
- Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_response_shared_pure_blocks/payload_extraction.rs::build_provider_response_timing_breakdown`; NAPI entry: `buildProviderResponseTimingBreakdownJson`.
- Required lock: Rust unit covers positive projection, negative clamp to zero, and no-op without `usageLogInfo.clientInjectWaitMs`; Jest source scan rejects reintroduced local TS `attachTimingBreakdown`, `clientInjectWaitMsRaw`, and local `hubResponseExcludedMs` projection.
- Native JSON boundary rule: TS wrapper must not send live `sseStream` objects through native JSON serialization; it strips `sseStream` before the native call and reattaches the exact original reference afterward.
- This closes only timing projection. `convertProviderResponseIfNeeded` still has TS host glue for SSE wrapper error remap, MetadataCenter sync, stage recorder, usage extraction / finish reason, stream/body capture, and provider context/error mapping; those remain separate owner slices.

# 2026-07-12: Provider-response timing breakdown projection is Rust-owned

- `convertProviderResponseIfNeeded` must not locally rebuild `timingBreakdown.clientInjectWaitMs` or default `hubResponseExcludedMs` in TS. It calls `buildProviderResponseTimingBreakdownWithNative(...)`, backed by Rust/NAPI `buildProviderResponseTimingBreakdownJson`.
- Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_response_shared_pure_blocks/payload_extraction.rs::build_provider_response_timing_breakdown`.
- Required lock: Rust unit and Jest source scan must reject local TS `function attachTimingBreakdown`, `clientInjectWaitMsRaw`, and `hubResponseExcludedMs: response.timingBreakdown?.hubResponseExcludedMs ?? clientInjectWaitMs`; tests must also prove `sseStream` identity remains TS host IO and does not enter the native JSON payload.
- This closes only a timing projection sub-slice. `convertProviderResponseIfNeeded` still has TS host glue for SSE wrapper error remap, MetadataCenter sync, stage recorder, and stream/body capture; those remain separate owner slices.

# 2026-07-12: Provider-response choices-array bridge debug details are Rust-owned

- `convertProviderResponseIfNeeded` must not locally rebuild `choices array` bridge debug details in TS. It calls `buildChoicesArrayBridgeDebugDetailsWithNative(...)` and spreads that Rust-owned projection into error log details.
- Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_response_shared_pure_blocks/payload_extraction.rs::build_choices_array_bridge_debug_details`; NAPI entry: `buildChoicesArrayBridgeDebugDetailsJson`.
- Required lock: Rust unit covers positive `choices array` diagnostics and negative non-choices errors; Jest source scan rejects reintroduced local TS `function buildChoicesArrayBridgeDebugDetails`, `args.message.toLowerCase().includes('choices array')`, and local `bridgePayloadHasDataChoices: Array.isArray(...)`.
- This closes only a diagnostic projection sub-slice. `convertProviderResponseIfNeeded` still has TS host glue for SSE wrapper error remap, MetadataCenter sync, stage recorder, usage/timing, and stream/body capture; those remain separate owner slices.

# 2026-07-12: Provider-response direct prebuilt SSE passthrough predicate is Rust-owned

- `shouldAllowDirectResponsesPrebuiltSsePassthrough` in `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts` must stay a TS shell over Rust/NAPI; it calls `shouldAllowDirectResponsesPrebuiltSsePassthroughJson` through `provider-response-native-calls.ts`.
- Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/provider_response_shared_pure_blocks/payload_extraction.rs::should_allow_direct_responses_prebuilt_sse_passthrough`.
- Required lock: Rust unit must cover the allowed direct same-protocol `/v1/responses` prebuilt SSE case and negative relay/wrong-endpoint/wrong-provider/no-stream cases; Jest source scan must reject local TS predicate branches returning the same decision.
- This closes one small runtime host conversion handoff sub-slice only. `convertProviderResponseIfNeeded` still has TS host glue for SSE wrapper error remap, MetadataCenter sync, stage logging, and stream/body capture; those need separate red/dry-run samples before migration.

# 2026-07-12: Provider-response host split checker closeout

- `hub.provider_response_host_split` closeout evidence must treat `src/modules/llmswitch/bridge/provider-response-converter-host.ts` as orchestration-only; implementation assertions for native call wrapping, metadata effect projection, and runtime effects belong to `provider-response-native-calls.ts`, `provider-response-metadata-effects.ts`, and `provider-response-effects.ts`.
- Focused provider-response stopless behavior is Rust-owned: when a continue schema response is missing `current_goal`, the projected `reasoningStop` command uses `triggerHint:"invalid_schema"` with `schemaFeedback.reasonCode:"stop_schema_current_goal_missing"` and `missingFields:["current_goal"]`; tests must not force `non_terminal_schema` for that malformed payload.

# 2026-07-12: Responses relay resume strips route/provider pins before handler pipeline truth

- Rust `build_responses_resume_control_for_continuation_context_for_http_json` preserves `providerKey` only for `continuationOwner=direct`; relay resume strips `routeHint`, `providerKey`, session/conversation mirrors, payload mirrors, and full input mirrors.
- Handler/request-executor tests that migrate from broad `native-exports` mocks to owner-specific hosts must assert relay `routeHint` / `providerKey` absence rather than reintroducing those pins through `MetadataCenter` or test fixtures.

# 2026-07-12: Hub Pipeline native reference gate is the first closeout layer

- `hub.pipeline_rust_residual_reference_closeout` is the gate/doc/test-design owner for broad `native-exports`, retired TS stage bridge, aggregate host, old helper wrapper, and direct-native helper reference boundaries. It is not a runtime behavior owner.
- `npm run verify:hub-pipeline-native-reference-gate` checks broad runtime native imports, monitored white-box broad native mocks/`createNativeExportsMock`, runtime direct-native helper imports, stale wiki/doc owner wording, and required map/package script bindings.
- `npm run test:hub-pipeline-native-reference-gate-red-fixtures` red-locks broad runtime native import, broad monitored white-box mock, runtime direct-native helper import, stale doc owner surface, and missing function-map owner.
- Broad `native-exports.ts` may be mentioned as private loader or forbidden legacy surface, but docs/wiki must not present it as a Hub Pipeline semantic owner. White-box host wiring tests should mock owner-specific hosts; direct-native helpers are test/script evidence only.

# 2026-07-09: exec_command/tool governance only blocks dangerous operations

- Verified rule: response-side tool governance must not silently drop client-visible tool calls only because they are absent from `requestedToolNames`; preserve them so client execution or client error becomes the next-turn model feedback.
- Verified rule: `exec_command` guard must not classify ordinary shell writes (`>`, heredoc, `tee`, `sed -i`, `ed -s`) as dangerous. Dangerous intercept remains for destructive/broad operations such as `rm -rf`, `pkill/killall`, `git clean -f`, `git reset --hard`, and scoped `git checkout` violations.
- Verified rule: apply_patch shell fallback attempts must not be rewritten into `APPLY_PATCH_ERROR` by response governance; if the command is not dangerous, let the client execute it and carry the result back to the model.
- Evidence: Rust focused `resp_process_stage1_tool_governance` passed 215/215 selected; touched-file `rustfmt --check`; touched-file `git diff --check`; `verify:servertool-rust-only` passed; `npm run build:native-hotpath` passed; `npm run build:min` passed; `npm run install:global` passed and restarted port 5555; `routecodex --version`, `rcc --version`, `~/.rcc/install/current/package.json`, and `http://127.0.0.1:5555/health` all reported version `0.90.3683`.

# 2026-07-08: servertool server-side registry defaults are retired

- Verified rule: CLI-owned servertools must not remain in the default server-side skeleton registry. Default `servertool_skeleton_config.rs` keeps `internalTools`, primary auto-hook order, progress flow map, and followup profiles empty.
- Verified rule: missing servertool followup profile means skip/no-followup, not reenter/client-inject. `continue_execution` noop dispatch/outcome/effect bridge is retired and must stay physically absent.
- Gate rule: `verify:servertool-rust-only` forbids `planServertoolNoop*`, `noopResult`, `noopEffectPlan`, and default skeleton registry/profile resurrection markers for `continue_execution`, `stop_message_auto`, `reasoningstop`, `web_search`, `vision_auto`, `exec_command`, and old flow ids.
- Evidence: Rust focused tests for `execution_loop_effect_contract` 3/3, `servertool_skeleton_config` 17/17, `chat_servertool_orchestration` 44/44, and `plans_servertool_execution_loop_effect_via_servertool_core_bridge` 1/1 passed; native hotpath build passed; focused servertool Jest passed 123/123; `verify:servertool-rust-only`, root `tsc --noEmit`, function-map compile gate, mainline call-map, and mainline manifest sync passed.

# 2026-07-09: Hub request-stage TS shell is retired

- Verified rule: `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` is physically deleted and must stay deleted; request/chat_process execution evidence now uses direct Rust/NAPI helper `tests/sharedmodule/helpers/request-stage-direct-native.ts`, which is test-only and not a runtime owner.
- Verified rule: request-side stopless provider guidance requires both `runtimeControl.stopMessageEnabled=true` and `requestTruth.sessionId`; tests must provide real entry session truth such as `body.metadata.sessionId`, not hand-write nested `runtimeControl.stopMessage` as compensation.
- Evidence: focused request-stage/residue Jest passed 217/217; `verify-route-metadata-preselected-route-owner`, `verify-metadata-center-dualwrite-api`, `verify:function-map-compile-gate`, strict shell audit (`prodTsShellCount=60`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`), zero-ts closeout, minimal TS surface, rustification audit, sharedmodule/root `tsc`, source/package exact ref scan, and `git diff --check` passed.

# 2026-07-06: rcc start defaults foreground, daemon is explicit

- Correction: `rcc start` / `rcc start --snap` must default to foreground startup logs, not a silent daemon supervisor summary. It still performs managed takeover/restart by default; daemon mode requires explicit `ROUTECODEX_START_DAEMON=1` / `RCC_START_DAEMON=1`.
- Verified rule: startup readiness polling must not warn-spam transient `daemon_supervisor_health_probe network_error`; those are normal until the child opens `/health`. Surface only final timeout/exit/startupError.
- Evidence: focused CLI Jest 24/24 and root TypeScript passed; `build:base` and `pack:rcc` passed; global npm-owned `rcc` installed as `0.90.3613`; real `rcc start --snap` printed foreground runtime logs including `RouteCodex version: 0.90.3613`, port registration, active listeners, and no `daemon_supervisor_health_probe network_error`; explicit `ROUTECODEX_START_DAEMON=1 rcc start --snap` restored background service; 4444/5520/5555/10000 `/health.version=0.90.3613`.

# 2026-07-06: rcc start takeover lock must be observable and health-gated

- Verified rule: plain `rcc start` / `rcc start --snap` owns the managed runtime slot and must not look hung when another start is already taking over the same port group. The lock contention path must first attach to live `/health`, then retry acquiring a released/dead-owner start lock when health is not ready, and emit waiting progress before timeout.
- Global install truth: closeout for lifecycle fixes must check `rcc --version`, `routecodex --version`, both release snapshot `install/current` roots, `/opt/homebrew/lib/node_modules/rcc/package.json` when `/opt/homebrew/bin/rcc` exists, and `/health.version` on all configured ports.
- Evidence: source lifecycle Jest 23/23, root TypeScript, `verify:runtime-lifecycle-pid-rebase`, `verify:function-map-compile-gate`, `build:base`, release install, `pack:rcc`, npm global `rcc@0.90.3611`, real single `rcc start --snap`, real concurrent `rcc start --snap` pair, and 4444/5520/5555/10000 `/health.version=0.90.3611` all passed. The concurrent second start returned successfully after seeing takeover lock instead of hanging.

# 2026-07-05: Responses SSE terminal closeout is transport sentinel, not business event

- Direct `/v1/responses` provider passthrough must append final `data: [DONE]\n\n` after a valid terminal Responses SSE event when upstream omits it. It must not synthesize `response.done`, request id, required_action, continuation, stopless/servertool state, or tool history.
- Relay/JSON-to-SSE projection closeout belongs in Rust `build_responses_sse_stream_frames_json`; the Rust/native encoder must end its frame list with `data: [DONE]\n\n`.
- Handler/SSE remains transport-only. Do not move terminal parsing, continuation repair, or protocol business semantics into `handler-response-sse.ts`.
- Current config fact from 2026-07-05: 5520/5555/4444 are explicit `sameProtocolBehavior="direct"` and 10000 defaults to direct. Do not call 5520 symptoms relay without a relay-configured port or relay ownership sample.
- Verified evidence: focused Rust tests for Responses SSE frame closeout passed; focused direct provider Jest passed; `build:base`, `pack:rcc`, release install verification, global install `routecodex/rcc@0.90.3583`, managed restart, and `/health.version` on all configured ports passed. Live 5520 smoke and latest sample `req_1783240882820_e055cb52` ended with `response.completed` plus `data: [DONE]`. Installed native probe proved global Rust encoder returns `last="data: [DONE]\n\n"`.

# 2026-07-05: Responses store finalize retention plan is Rust-owned

- Verified rule: `finalizeResponsesConversationRequestRetention()` in `responses-conversation-store.ts` must not own retention lifecycle decisions. Rust `shared_responses_conversation_utils.rs` owns the decision via `planResponsesConversationRetentionJson`; TS store only executes the returned `clear` / `release` IO action and debug logging.
- Locked semantics: missing `lastResponseId` clears request, `keepForSubmitToolOutputs=true` releases payload for submit continuation, missing scope clears request, valid scoped continuation releases retained payload.
- Evidence: Rust retention unit passed, focused store Jest passed, `verify:responses-history-protocol-contract` passed with 58 Rust tests, native hotpath build passed, rustification audit passed with `nonNativeLocTotal=8296`.

# 2026-07-05: Responses store lifecycle decisions are Rust native helpers

- Verified rule: `responses-conversation-store.ts` must not own continuation allow, entry isolation, or pending tool-call calculation. Those decisions are Rust-owned in `shared_responses_conversation_utils.rs` via `shouldAllowResponsesConversationContinuationJson`, `responsesConversationEntryMatchesIsolationJson`, and `collectResponsesPendingToolCallIdsJson`; TS may only call the native facade while doing map/index/persistence IO.
- Build rule: after adding or renaming router-hotpath NAPI exports, run `npm run build:native-hotpath` before Jest that imports sharedmodule `src` with real native bindings. TypeScript passing is insufficient because tests load the existing `.node` addon and will fail native-required exports until rebuilt.
- Evidence: focused store Jest 198/198 passed after native rebuild; `verify:responses-history-protocol-contract`, `verify:llmswitch-rustification-audit`, architecture mainline gates, and `verify:function-map-compile-gate` passed.

# 2026-07-05: architecture modularity/control-data audit baseline

- Audit scope: read-only architecture review for modularity, module boundaries, mainline clarity, and control/data separation.
- Green baseline: `verify:architecture-mainline-call-map`, `verify:architecture-mainline-binding-pending-gate`, `verify:architecture-metadata-center-write-boundaries`, `verify:architecture-provider-specific-leaks`, `verify:architecture-metadata-leak-boundary`, `verify:architecture-nonadjacent-conversion`, `verify:architecture-thin-wrapper-only`, and `verify:llmswitch-rustification-audit` passed during the audit.
- Remaining high-signal architecture debt:
  - Function-map compile gate fails on `config.virtual_router_builder` and `config.virtual_router_types` source anchors existing without function-map / verification-map entries.
  - Mainline binding gate has no `binding pending`, but one `partial` remains: `error.mainline` `err-03` (`ErrorErr03RuntimeClassified -> ErrorErr05ExecutionDecision`).
  - TS owner ban still flags TS-owned/transitional surfaces: runtime key resolution, MetadataCenter dualwrite API, debug surfaces, manager health runtime, and Responses continuation bridge.
  - Forbidden-path growth still flags Hub typed nodes / MetadataCenter / continuation lookup terms appearing in server/provider/TS store paths and needs per-hit owner-vs-allowlist triage.
  - Duplicate DTO gate still flags TS mirror `ErrorErr05RouteAvailabilityDecisionInput` in `request-executor-core-utils.ts` against Rust truth in `error_err05_availability.rs`.
  - Custom payload carrier containment still flags debug `response.metadata` example usage plus `__routecodex*` route-control sentinels.
- Useful prioritization: fix map/anchor drift first because it blocks function-map compile truth; then close the single `error.mainline` partial and duplicate DTO because they are both on the provider-error reroute/mainline boundary; then reduce TS owner transitional surfaces and forbidden-path hits.

# 2026-07-04: Responses store released prefix is not live input
- Verified rule: `responses-conversation-store-native.ts` must pass current live `entry.input` to Rust and keep `releasedInputPrefix` as a separate side-channel. Treating released prefix as current input hides the store's released/pending branch truth and can let duplicate pending function_call batches or stale stopless tool history survive.
- Rust owner: `shared_responses_conversation_utils.rs` owns materialize/resume collapse for replayed pending tool batches, duplicate output batches, and completed stopless auto-hook pairs. TS store/bridge may marshal opaque payloads only; it must not reconstruct continuation history or use released prefix as a semantic fallback input.
- Verified evidence: Rust `shared_responses_conversation_utils` tests passed 48/48; `tests/sharedmodule/responses-continuation-store.spec.ts` passed 39/39 including duplicate pending batch collapse and third submit stopless latest-guidance-only collapse; response history protocol, function-map, mainline-call-map, sharedmodule tsc, native hotpath build, and `build:base` passed.
- Closure caveat: runtime closeout is not current. A resumed-turn recheck found source/CLI at `0.90.3562` but live 5520/5555 `/health.version=0.90.3561`; any earlier live report for `0.90.3562` is stale until rerun. Full runtime closeout still needs live version match plus an installed-runtime/same-entry replay that directly proves released prefix + duplicate pending collapse + latest-guidance-only behavior.

# 2026-07-04: Retry providerProtocol must survive provider reroute metadata cleanup
- Verified root cause: `decorateMetadataForAttempt()` released `runtime_control.providerProtocol` on retry together with single-use route pins. The next Hub attempt reads providerProtocol before VR can commit the backup route, so the retry failed with `HubPipeline requires metadata center runtime_control.providerProtocol` after `exclude_and_reroute`.
- Fix rule: retry cleanup releases `preselectedRoute` and `retryProviderKey`, but preserves `providerProtocol`; only the request-route owner may later replace providerProtocol atomically for the current selected target.
- Verification evidence: providerProtocol focused red/green Jest passed, `request-executor.metadata-center.contract.spec.ts` passed 12/12, sharedmodule/root `tsc` passed, `verify:function-map-compile-gate` passed, and `verify:provider-failure-ban-blackbox` passed with backup reroute for 503/401/403/429.

# 2026-07-03: Responses capture must preserve entry payload across Hub body rewrite
- Verified root cause: when `/v1/responses` uses `hubBody`, server execution replaces `input.body` with provider wire shape before `HubRequestExecutor` captures Responses conversation context. Capture must therefore read the same-request raw entry payload, not reconstruct from provider wire body or from debug snapshots.
- Durable rule: when `buildHubPipelineInput()` swaps `body=hubBody`, it must carry the original body as request-scoped data-plane truth (`__raw_request_body`) for Chat Process capture only. Do not fix missing Responses context by scope fallback, by guessing from provider response, or by stuffing request context into MetadataCenter control state.
- Verified closure: focused capture Jest passed, function-map gate passed, root `tsc --noEmit` passed, `build:base` passed, global `routecodex 0.90.3527` installed, 5555 restarted healthy, live first `/v1/responses` turn and live `submit_tool_outputs` continuation both succeeded without new `RESPONSES_STORE_MISSING_REQUEST_CONTEXT` / `record.missing_request_context` logs.

# 2026-07-04: plain start is non-disruptive; fixed package installed as 0.90.3546
- Verified root cause: global 0.90.3542 `dist/cli/commands/start.js` still had `const shouldRestart = options.restart !== false || options.exclusive === true`, so plain start behaved like restart and could stop a live service.
- Fix truth: source and installed global 0.90.3546 now use `const shouldRestart = options.restart === true || options.exclusive === true`; `start` no longer sends shutdown unless the caller explicitly passes `--restart` / `--exclusive`.
- Verification evidence: focused CLI lifecycle Jest passed 32/32; sharedmodule `tsc --noEmit` passed; `build-core`, `build:min`, and `pack:rcc` passed; both `routecodex-0.90.3546.tgz` and `rcc-0.90.3546.tgz` installed globally; `routecodex --version` and `rcc --version` report 0.90.3546; global `dist/cli/commands/start.js` contains `options.restart === true`; live `routecodex start --port 5555` returned `already_running_unmanaged` and 5520/5555 `/health` stayed OK.
- Live caveat: the running managed server still reports 0.90.3542 because no intentional restart was executed after install, to avoid interrupting current traffic.

# 2026-07-02: router-direct hook clone can drop provider runtime carrier
- Verified root cause: router-direct attaches provider runtime metadata as a non-enumerable symbol, so later `{ ...payload }` clones in direct hooks drop `requestId` / MetadataCenter port truth before `processIncomingDirect()`. This caused direct Responses raw SSE provider snapshot writes to use local `req_...` and fail `entryPort required`.
- Durable rule: after direct-route hooks or any direct-path clone, reattach the provider runtime carrier to the exact payload object sent to provider. Do not fix this in snapshot writer by guessing ports or reading client payload metadata.
- Verified closure: global `routecodex 0.90.3510`, managed `routecodex restart --port 5520`, `/health` ready, live `/v1/responses` stream returned `routecodex-smoke-5520-3510`, and the post-restart log slice had zero new `entryPort required` / `UPSTREAM_STREAM_IDLE_TIMEOUT`.

# 2026-07-02: servertool auto-hook attempt result cast removed
- `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts` no longer returns `result as ServerToolHandlerResult` after native `attemptPlan.action === 'return_result'`; TS now only fail-fast checks `result == null` and returns the materialized result directly.
- `tests/servertool/servertool-auto-hook-trace.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the cast marker and require the direct return path.
- Verified slice: red focused Jest and `verify:servertool-rust-only` failed on the old cast; green focused Jest PASS 53/53; sharedmodule `tsc` PASS; `verify:servertool-rust-only` PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `git diff --check` PASS.

# 2026-07-02: provider-request replay snapshot capture is explicit-only
- Provider-request replay artifacts are no longer blanket-rejected by provider/debug snapshot writer, but they remain excluded from default snapshots; full provider wire body may be persisted only through explicit `--snap-stages provider-request` or force-local failure replay capture.
- `src/providers/core/runtime/http-request-executor.ts` captures the final `PreparedHttpRequest` body, and router-direct captures request replay artifacts before direct provider send plus force-captures request payload on failure snapshots.
- Verified slice: focused Jest `snapshot-writer.error-spill + local-mirror + queue + release-gating + router-direct-failure-snapshot + http-request-executor.snapshot-entry-port` PASS 17/17; `tsc -p tsconfig.json` PASS; `verify:architecture-snapshot-stage-contract` PASS; `verify:architecture-snapshot-stage-owners` PASS; `build:base` PASS; `git diff --check` PASS.
- Known unrelated gap: `tests/providers/core/runtime/protocol-http-providers.unit.test.ts` currently fails at suite load due missing mapped `transport/oauth-recovery-handler.js` when added to the focused command; it was excluded from this verified snapshot slice.

# 2026-07-02: servertool auto-hook caller queue-result cast removed
- `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts` no longer casts `queueResult as ServerToolHandlerResult` after native finalization; `return_result` now uses an explicit `queueResult == null` fail-fast guard and then reads the narrowed result directly.
- `tests/servertool/servertool-auto-hook-trace.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the cast marker and require direct `queueResult.*` reads plus null guard.
- Verified slice: focused Jest `servertool-auto-hook-trace + execution-shell.auto-hook-failfast + servertool-active-orchestration-audit` PASS 53/53; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `verify:servertool-rust-only` PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `git diff --check` PASS.

# 2026-07-02: servertool engine selection rerun overrides fallback removed
- `sharedmodule/llmswitch-core/src/servertool/engine-selection-block.ts` no longer calls `args.runEngine(afterRunPlan.overrides ?? {})`; Rust/native wrapper now requires `rerun_excluding_primary_hooks` to carry explicit overrides and rejects `return_current` with overrides.
- `tests/servertool/engine-selection-block.spec.ts`, `tests/servertool/servertool-cli-native-bridge.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the TS empty-object fallback and require direct native overrides.
- Verified slice: focused Jest `engine-selection-block + servertool-cli-native-bridge + servertool-active-orchestration-audit` PASS 78/78; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `verify:servertool-rust-only` PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `git diff --check` PASS.

# 2026-07-02: servertool response-stage auto-hook presence helper removed
- `sharedmodule/llmswitch-core/src/servertool/response-stage-auto-hook-shell.ts` no longer keeps a local `hasServerSideToolEngineResult()` type-guard helper; it now uses `autoHookResult != null` as the only presence check and `autoHookResult == null` as the fail-fast guard.
- `tests/servertool/response-stage-auto-hook-shell.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` now forbid the helper marker and require the nullish presence check.
- Verified slice: focused Jest `response-stage-auto-hook-shell + servertool-active-orchestration-audit` PASS 50/50; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `verify:servertool-rust-only` PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `git diff --check` PASS.

# 2026-07-02: servertool postflight flowIdSource payload read removed
- `sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts` no longer reads `String((args.runtimeAction as { flowIdSource: unknown }).flowIdSource)` in TS; unknown native `flowIdSource` now fails fast with a fixed error message.
- `tests/servertool/engine-observation-shell.spec.ts` locks the behavior with a negative test, and `tests/servertool/servertool-active-orchestration-audit.spec.ts` plus `scripts/verify-servertool-rust-only.mjs` forbid the TS payload-read marker.
- Verified slice: focused Jest `engine-observation-shell + servertool-active-orchestration-audit` PASS 53/53; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `verify:servertool-rust-only` PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `git diff --check` PASS.
- Commit: `d60173f` `fix(servertool): close postflight flow source cast`

# 2026-07-01: Responses JSON->SSE top-level response shape is Rust-owned
- SSE JSON->SSE converter/sequencer must not keep local `validateResponse()` or synthesize top-level Responses fields such as `object:"response"` / empty `output`; top-level response shape fail-fast belongs to Rust `responses_sse_event_payload::normalize_responses_sse_response_payload()`.
- Gate: `verify:sse-architecture-boundary` forbids the retired converter/sequencer validation markers. Verification for the slice passed focused Rust/Jest, SSE gates, function-map gate, sharedmodule/root TS checks, native hotpath build, `build:base`, and source replay; local 4444 provider-response samples still lacked success SSE wire fields.

# 2026-07-01: 5520 longcontext now uses weighted gpt-5.5 forwarder
- `gateway_priority_5520.routing.longcontext` now targets `fwd.gpt.gpt-5.5`, so longcontext joins the `ykk:cc = 1:1` weighted forwarder instead of the paid priority chain.
- `routecodex config show -c ~/.rcc/config.toml` confirms one longcontext entry with target `fwd.gpt.gpt-5.5`; `routecodex restart --port 5520` and `/health` passed.

# 2026-07-01: cc auth now has two usable keys
- `cc` provider auth uses `selectionMode = "priority"` with `key1 = ${CC_OAI_KEY}` and a second verified key stored outside git (`<redacted>`).
- Direct upstream `/openai/v1/models` with the new key returned `HTTP 200` and still exposed only `gpt-5.5`.

# 2026-07-01: cc provider baseline narrowed to gpt-5.5
- `~/.rcc/provider/cc/config.v2.toml` is the cc provider SSOT, using `https://api.anyint.ai/openai/v1` and `CC_OAI_KEY`, and only exposes `gpt-5.5` until other models are实测.
- `~/.rcc/config.toml` routes `gpt-5.5` with `cc` as top-priority target in `fwd.paid.gpt-5.5`, and keeps the weighted `fwd.gpt.gpt-5.5` split at `ykk:cc = 1:1`.

# 2026-07-01: provider-direct must carry live client abort signal
- provider-direct path must thread `getClientConnectionAbortSignal(metadata)` into attached provider runtime metadata before direct send; otherwise client close can leave direct provider running because this path bypasses request-executor's abort propagation.
- Verification: focused `tests/server/runtime/http-server/direct-server-contract.red.spec.ts -t 'provider-direct forwards the live client abort signal into provider runtime metadata'` passed, and the original provider-direct passthrough test still passed.
- Scope note: router-direct already carried abortSignal through the request payload; this slice closes the provider-direct gap only.

# 2026-07-01: 4444 502 samples are upstream gateway failures, not context overflow
- Verified 4444 502 samples for `ykk.ykk.gpt-5.4-mini` and `asxs.crsa.gpt-5.4-mini` return HTTP 502 / `upstream_error` or Cloudflare-style HTML `502: Bad gateway`.
- The examined 502 request shape is a normal OpenAI Responses payload with `input.count=617` and `estimatedTextChars=320470`; `~/.rcc/provider/ykk/config.v2.toml` sets `maxContext=900000` for `gpt-5.4-mini`, so this sample does not show context overflow.
- Separate 4444 request-field failure still exists: HTTP 400 `unsupported_parameter` on `reasoning.summary` for `gpt-5.3-codex-spark`.
- Evidence: `~/.rcc/logs/server-4444.log`, `~/.rcc/provider/ykk/config.v2.toml`, `~/.rcc/provider/XL/config.v2.toml`, and `~/.rcc/codex-samples/openai-responses/ports/4444/`.

# 2026-07-01: Responses JSON->SSE converter must not keep request context cache
- `ResponsesJsonToSseConverterRefactored` must not maintain converter-level `contexts` maps, TTL pruning, `getContext`, `clearContext`, or `getActiveContexts`. Responses JSON->SSE encode is a finite projection stream; per-request stats may live in the returned stream context, but long-lived converter state is not an owner.
- Gate: `verify:sse-architecture-boundary` forbids `CONTEXT_TTL_MS`, `MAX_CONTEXTS`, `pruneResponsesContexts`, and the active-context APIs in the Responses JSON->SSE converter.
- Verification: focused Responses SSE/context Jest 40/40, `verify:sse-architecture-boundary`, `verify:responses-sse-business-module`, sharedmodule/root TypeScript checks, and `git diff --check` passed. No live replay was run for this slice.

# 2026-07-01: Responses JSON->SSE validation cannot be disabled
- `responses-sequencer.ts` must not expose an `enableValidation` / validation-disable switch. Responses JSON->SSE encode projection must always fail fast for missing response fields, unknown output item types, and content-part limit violations.
- Red evidence: before the fix, `sequenceResponse(..., { enableValidation:false })` silently skipped an unknown output item and still emitted `response.completed` / `response.done`.
- Gate: `verify:sse-architecture-boundary` forbids the old validation-disable markers in the Responses sequencer. Verification passed for focused Responses SSE Jest 37/37, SSE architecture/business gates, sharedmodule/root TypeScript checks, and `git diff --check`. `build:base` is currently blocked by an unrelated servertool wiki sync drift, and no live replay was run for this slice.

# 2026-07-01: Responses JSON->SSE encode errors must fail fast
- `responses-sequencer.ts` must not catch serializer/conversion failures and synthesize `event: response.error`; `buildErrorEvent`, `planResponsesSseErrorRecoveryWithNative`, `buildResponsesSseErrorPayloadWithNative`, and their Rust/NAPI exports must stay removed for Responses JSON->SSE encode.
- Invalid usage, missing `created_at` / `status`, invalid output item, missing output text/function arguments, and malformed reasoning summary/text now reject the conversion stream instead of producing `response.error` without terminal frames.
- Verification: focused Responses SSE Jest 35/35, Rust `responses_sse_event_payload` 47/47, `verify:sse-architecture-boundary`, `verify:responses-sse-business-module`, sharedmodule/root TypeScript checks, native hotpath build, `build:base`, and `git diff --check` passed. No live 4444 replay was run for this slice; full SSE closeout still needs live replay.

# 2026-07-01: Handler apply_patch SSE projection spec is obsolete
- `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts` must stay deleted; it asserted handler-side apply_patch/freeform SSE projection (`function_call -> custom_tool_call`, argument unwrap, delta aggregation, done de-duplication, direct-passthrough repair), which belongs to Rust/native `hub.response_responses_client_projection`.
- Function-map / verification-map / SSE bridge wiki anchors now point to native/Rust projection coverage instead, and `verify:responses-handler-single-bridge-surface` fails if the stale handler spec path is restored.
- Verification: focused native projection Jest 7/7, handler single-bridge gate, SSE architecture/business gates, Rust projection cargo gate, sharedmodule/root TypeScript checks, wiki sync/html sync, focused function-map gates, and `git diff --check` passed. No server restart or live replay was performed for this slice.

# 2026-07-01: Provider response streamPipe must carry explicit native payload
- `provider-response.ts` must not cast malformed `runtimeEffects.streamPipe.codec/requestId` or fall back from missing `streamPipe.payload` to `hubRespOutbound04ClientSemantic`.
- Stream pipe effects now require explicit `codec`, `requestId`, and `payload`; malformed stream pipe shape fails fast with `Rust HubPipeline response path returned malformed stream pipe effect`.
- Verification: focused mocked provider-response Jest, real native `provider-response-rust-plan` streaming path, `verify:sse-architecture-boundary`, `verify:hub-response-provider-sse-materialization`, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, and `build:base` passed.

# 2026-07-01: Provider response servertool runtime actions must not default to empty
- `provider-response.ts::executeProviderResponseNativeServertoolEffects()` must not convert malformed `runtimeEffects.servertoolRuntimeActions` into an empty action list.
- The TS shell now requires Rust-normalized `servertoolRuntimeActions` to be an array and fails fast with `Rust HubPipeline response path returned malformed servertool runtime actions` before planning servertool effects.
- Verification: focused mocked provider-response Jest, `verify:sse-architecture-boundary`, `verify:hub-response-provider-sse-materialization`, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, and `build:base` passed.

# 2026-07-01: Provider response native effect plan must fail fast when malformed
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` must not synthesize empty `servertoolRuntimeActions` / `streamPipe` / `runtimeStateWrite` / `stoplessMetadataCenterWrite` when Rust returns a malformed `nativeResponsePlan.effectPlan.effects`.
- Missing or non-array effects now fail fast with `Rust HubPipeline response path returned malformed effect plan`; the TS shell only normalizes a valid Rust-provided effects array.
- Verification: focused mocked provider-response Jest, `verify:sse-architecture-boundary`, `verify:hub-response-provider-sse-materialization`, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `git diff --check`, and `build:base` passed.

# 2026-07-01: Gemini SSE done candidates are required
- `gemini-sse-to-json-converter.ts` must not treat missing `gemini.done.candidates` as an optional metadata absence; that materializes a partial response with undefined finish metadata.
- Missing or non-array done candidates now fail fast with `Invalid Gemini done event: missing candidates`; valid explicit candidates replay remains unchanged.
- Verification: focused `sse-parser-no-recovery` Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `git diff --check`, and source replay passed. No real Gemini provider-response sample was found in current sample stores.

# 2026-07-01: Gemini SSE data role must not default to model
- `gemini-sse-to-json-converter.ts` must not synthesize `role='model'` when a `gemini.data` frame omits role metadata.
- Missing or blank role now fails fast with `Invalid Gemini data event: missing role`; valid explicit role replay remains unchanged.
- Verification: focused `sse-parser-no-recovery` Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, `git diff --check`, and source replay passed. No real Gemini provider-response sample was found in current sample stores.

# 2026-07-01: Gemini SSE data candidateIndex must not default to zero
- `gemini-sse-to-json-converter.ts` must not synthesize `candidateIndex=0` when a `gemini.data` frame omits candidate metadata.
- Missing `candidateIndex` now fails fast with `Invalid Gemini data event: missing candidateIndex`; valid explicit index replay remains unchanged.
- Verification: focused `sse-parser-no-recovery` Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, `git diff --check`, and source replay passed. No real Gemini provider-response sample was found in current sample stores.

# 2026-07-01: Gemini SSE done metadata must fail fast on malformed candidates
- Valid Gemini `gemini.data` / `gemini.done` replay remains intact, but malformed `gemini.done.candidates` must not be silently skipped.
- `gemini-sse-to-json-converter.ts` now fails fast on invalid done-frame candidate metadata with `Invalid Gemini done event: invalid candidate at index <n>`.
- Verification: focused `sse-parser-no-recovery` Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, `git diff --check`, and source replay all passed. No real Gemini provider-response sample was found in current sample stores.

# 2026-07-01: SSE decode must fail malformed semantic chunks, not skip them
- Gemini SSE decode must not `return` past `gemini.data` frames with missing `part`; malformed data frames fail fast with `Invalid Gemini data event: missing part`.
- Chat SSE decode may allow proven inert tail chunks after response truth is established, but non-object `chat_chunk` payloads are malformed and must fail fast with `Invalid chat_chunk payload`; never use `continue` to silently skip malformed semantic chunks.
- Gates: `tests/sharedmodule/sse-parser-no-recovery.spec.ts`, `tests/sharedmodule/chat-sse-no-salvage.spec.ts`, and `npm run verify:sse-architecture-boundary` lock these boundaries.

# 2026-07-01: Responses SSE function_call arguments must not be skipped by TS
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts` must not gate function-call argument emission with `if (item.arguments)`.
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` must not use `if (!functionCall.arguments) return;`; malformed function_call arguments must enter the native text chunk/payload path and fail fast there.
- Verification included focused Jest `responses-sse-output-item-descriptor-native`, `verify:sse-architecture-boundary`, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, and source replay proving missing arguments emits `response.error` with no `function_call_arguments.done` or terminal completed/done.

# 2026-07-01: Responses SSE reasoning summary entries must not be silently skipped
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_sse_event_payload.rs::normalize_responses_sse_reasoning_summary()` is the owner for reasoning summary entry validation. Null/missing summary may produce no summary events, but non-array summary, invalid entries, missing text, or empty text must fail fast.
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` must not use `normalizeResponsesSseReasoningSummaryWithNative(reasoning.summary) ?? []` or `if (!text) continue;` to hide invalid summary entries.
- Verification included Rust focused `responses_sse_reasoning_summary`, native hotpath build, focused Jest `responses-sse-reasoning-summary-no-normalize`, `verify:sse-architecture-boundary`, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, and source replay proving missing summary text emits `response.error` with no completed/done.

# 2026-07-01: Responses SSE reasoning delta missing value fails in Rust
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_sse_event_payload.rs` is the owner for Responses reasoning delta payload validation; missing `value` must fail fast with `Responses reasoning delta payload missing value`.
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` must not silently skip `if (!content.text) continue;` for reasoning text content.
- Verification for this slice included focused Jest `responses-sse-reasoning-summary-no-normalize`, `npm run verify:sse-architecture-boundary`, sharedmodule/root TypeScript checks, `npm run verify:responses-sse-business-module`, `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`, `npm run build:base`, and source replay proving invalid reasoning text emits `response.error` with no completed/done.

# 2026-07-01: Responses SSE terminal status must come from response.status
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` must not synthesize terminal status with `response.status ?? 'completed'` or required-action status with `response.status ?? 'requires_action'`.
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts::validateResponse()` now fails missing/blank `response.status` with `Invalid Responses response: missing status`, preventing silent `in_progress/completed` terminal frames.
- Verification included focused `responses-sse-usage-no-fallback`, `verify:sse-architecture-boundary`, sharedmodule/root `tsc --noEmit`, `verify:responses-sse-business-module`, `build:base`, and source replay proving valid completed/done still emit while missing status emits `response.error` and no completed/done.

# 2026-07-01: Gemini SSE scalar candidate part must fail fast
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not return scalar `part` values from `normalizeReasoningPart()`; non-object candidate parts are invalid provider shape and fail fast with `Invalid Gemini candidate part at index <n>`.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` now lock the scalar-part boundary.
- Verification for this slice included focused Gemini Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, and source replay with `eventCount=2`, `dataEvents=1`, `doneEvents=1`, and `scalarPartFailed=true`. Real Gemini provider-response replay remains unavailable.

# 2026-07-01: Gemini SSE null candidate must fail fast
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not coerce `candidates[candidateIndex]` through `|| {}`; null/undefined candidate is invalid provider shape and fails fast with `Invalid Gemini candidate at index <n>`.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` now lock the null-candidate boundary.
- Verification for this slice included focused Gemini Jest, SSE architecture gate, sharedmodule/root TypeScript checks, `verify:responses-sse-business-module`, `build:base`, and source replay with `eventCount=2`, `dataEvents=1`, `doneEvents=1`, and `nullCandidateFailed=true`. Real Gemini provider-response replay remains unavailable.

# 2026-07-01: Gemini SSE candidate parts must not default to an empty candidate
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts::getCandidateParts()` must not `return []` when `candidate.content.parts` is missing or malformed; missing parts fail fast with `Invalid Gemini candidate: missing parts`.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` lock this no-empty-candidate boundary.
- Verification for this slice included focused Gemini Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `build:base`, and source replay with `eventCount=2`, `dataEvents=1`, `doneEvents=1`, and `missingPartsFailed=true`. Real Gemini provider-response replay remains unavailable.

# 2026-07-01: Gemini SSE candidates must not default to an empty success stream
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not use `Array.isArray(response.candidates) ? response.candidates : []`; missing/non-array candidates are invalid provider response shape and fail fast with `Invalid Gemini response: missing candidates`.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` lock this no-empty-success boundary.
- Verification for this slice included focused Gemini Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `build:base`, and source replay with `eventCount=2`, `dataEvents=1`, `doneEvents=1`, and `missingCandidatesFailed=true`. Real Gemini provider-response replay remains unavailable.

# 2026-07-01: Anthropic SSE tool_result must not emit missing tool_use_id
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must fail fast when `tool_result.tool_use_id` is missing or blank; emitting `tool_use_id: undefined` is invalid provider-shape projection.
- `verify:sse-architecture-boundary` now requires the fail-fast marker `Invalid Anthropic tool_result block: missing tool_use_id`, and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` locks the reverse path.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `build:base`, and source replay with `hasToolResult=true`, `hasToolUseId=true`, and `missingToolResultIdFailed=true`. Real Anthropic success replay remains unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE tool_use input must not default to empty object
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not use `block.input ?? {}` or `JSON.stringify(input ?? {})`; missing/null `tool_use.input` is invalid provider shape and fails fast with `Invalid Anthropic tool_use block: missing input`.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` lock this no-empty-object fallback boundary.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `build:base`, and source replay with `hasInputJsonDelta=true` plus `missingInputFailed=true`. Real Anthropic success replay remains unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE response content must not default to empty array
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not use `response.content || []`; missing or non-array content is invalid provider shape and fails fast.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` lock this no-empty-content fallback boundary.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, and source replay with `missingContentFailed=true`. Real Anthropic success replay remains unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE redacted_thinking data must not be silently skipped
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not convert missing `redacted_thinking.data` to an empty string or `continue` past it. Missing/blank data fails fast.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` lock this no-silent-skip boundary.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, and source replay with `missingRedactedFailed=true`. Real Anthropic success replay remains unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE text blocks must not default missing text to empty
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not use `block.text ?? ''`; missing text in a `text` block is provider-shape corruption and fails fast.
- `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` lock the no-empty-fallback boundary.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `git diff --check`, and source replay with `missingTextFailed=true`. Real Anthropic success replay remains unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE content blocks must fail fast on invalid entries
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not silently skip invalid `content` entries. Null/undefined/non-object blocks now fail fast with the block index.
- Reintroducing `if (!block || typeof block !== 'object') continue;` is locked by `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts`.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `git diff --check`, and source replay. Real Anthropic success replay is still unavailable; only 429 provider-error samples exist.

# 2026-07-01: Anthropic SSE event envelope must not synthesize timestamps
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not write local event timestamps; Anthropic SSE wire framing only needs explicit `event` / `type` and provider payload data.
- `AnthropicSseEventBase` intentionally does not extend `BaseSseEvent`; reintroducing `timestamp: Date.now()` is locked by `verify:sse-architecture-boundary` and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts`.
- Verification for this slice included focused Anthropic Jest, SSE architecture gate, sharedmodule/root TypeScript, responses SSE business gate, `build:base`, `git diff --check`, and source replay with `hasTimestamp=false`. Current real Anthropic samples are 429 error snapshots only, so no successful live Anthropic replay sample exists yet.

# 2026-06-30: Responses SSE canonical payload owner moved to Rust
- Responses JSON->SSE canonical event payload materialization is now native-owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_sse_event_payload.rs` via `canonicalizeResponsesSseEventPayloadJson`.
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts` must not locally inject `data.type` or `sequence_number`; it may only call `canonicalizeResponsesSseEventPayloadWithNative`.
- Verification includes Rust focused test, native hotpath build, focused Responses SSE Jest, SSE gates, sharedmodule/root TS, and real 4444 replay with no missing type/sequence.

# 2026-06-30: Responses event serializer is canonical-payload only
- `sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts` must not synthesize Responses event payload semantics. It now only serializes allowlisted event types when `data` is an object and `data.type` exactly matches the event type.
- Removed serializer-owned wildcard `response.*` handling, missing `type` injection, scalar `{ value }` wrapping, and `sequence_number` injection. Canonical payload materialization currently happens at the Responses sequencer boundary and should be the next Rustification target.
- Gates/tests: `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts` and `npm run verify:sse-architecture-boundary` lock this boundary; real 4444 replay `req_1782794868950_3m64se1xv` re-encodes with no missing `type`.

# 2026-06-30: 4444 stream_closed triage restart boundary
- Verified: the latest `4444 /v1/responses` `stream closed before response.completed` failures were all logged before the latest `routecodex restart --port 4444` marker; after `npm run build:base && npm run install:global && routecodex restart --port 4444`, 4444 health is ready and no new post-restart failure line has been observed yet.
- Verified: `routecodex --version` now reports `0.90.3340`, while the 4444 health endpoint still reports server version `0.90.3337`. Keep treating the health endpoint as the live server truth for runtime verification.

# 2026-06-30: Responses SSE bridge dead facade surface retired
- Verified: `resolveResponsesRequestContextForHttp`, `shouldDispatchResponsesSseToClientForHttp`, `prepareResponsesJsonSseDispatchPlanForHttp`, and `resolveResponsesConversationClearReasonForHttp` are retired from `responses-response-bridge` / `responses-sse-bridge` TS source plus checked-in JS/DTS mirrors. Handler dispatch now reads `forceSSE || result.sseStream !== undefined` and `options.responsesRequestContext` directly; keepalive framing remains transport-owned in `responses-sse-transport`.
- Verification: focused SSE/handler Jest 23 passed, `verify:responses-sse-business-module`, `verify:responses-handler-single-bridge-surface`, `verify:sse-architecture-boundary`, sharedmodule/root TypeScript, and real chat SSE sample replay all passed.

# 2026-06-30: priority 选择语义纠偏
- priority 语义 = 每次新请求都重新从最高优先级开始尝试；错误只影响当前请求链内的切换与计数，不应把 provider 永久降级到后面。
- 同一请求内出错时，标准动作仍是 switch provider + 计数；若本次成功，则不再看下一个候选。
- 任何跨请求的长期排除/降级都不能由 priority 本身承担，必须由独立健康/额度真源决定，且恢复后要允许重新从头命中。

# 2026-06-30: priority 场景网络错误处理结论
- `priority` 只决定路由排序，不改变错误主链；临时网络错（`fetch failed` / `socket hang up` / `network timeout` / SSE decode）按 provider failure policy 走 `recoverable`，再由 ErrorErr05 决定是否 reroute。
- 只要当前 route pool 还有剩余候选，或者 default pool 仍可用，`mayProject` 就应保持 false；当前请求链先排除/切换，不能直接投影成客户端错误。
- 失败 provider 的排除主要是当前请求链内状态；后续新请求是否再命中，取决于 VR health/quota/default truth 是否恢复，而不是 priority 分支本身有特殊复活逻辑。

# 2026-06-30: Responses SSE handler/bridge fallback surface removed
- `/v1/responses` force-SSE 路径不得在 TS handler/bridge 中把 JSON/chat body 现场转换成 SSE；缺 Rust/Hub-produced `sseStream` 必须 fail-fast 走 missing-stream error path。
- `responses-sse-bridge` / `responses-response-bridge` 不再是 SSE error payload builder owner；`buildResponsesSseErrorPayloadForHttp`、`buildResponsesStructuredSseErrorPayloadForHttp`、`buildResponsesMissingSseBridgeErrorPayloadForHttp` 已从 bridge surface / d.ts / function-map canonical builders 删除。
- SSE handler 不得扫描 `response.completed` / `response.done` / `response.error` 业务帧来判断 terminal；`hasResponsesTerminalSseMarker`、`sawTerminalEvent`、`terminalScanBuffer` 已删除，closeout 只按 transport stream end / close / error。
- SSE handler 不得从 JSON `body.error` 重组 structured SSE error；`buildStructuredSseErrorPayloadForHttp`、`extractStructuredSseErrorPayload`、`sendStructuredSseError` 已删除，force-SSE 缺 stream 统一 missing-stream fail-fast。
- SSE error event payload builder 已收口到 ErrorErr06 client projection owner：`src/server/utils/http-error-mapper.ts::projectSseErrorEventPayload`；handler 不得恢复本地 `buildTransportLocalSseErrorPayload`。
- 防复活门禁：`verify:responses-sse-business-module`、`verify:responses-handler-single-bridge-surface`、`server_responses_sse_business_module_contract`、`server_responses_sse_surface_single_owner`。
- 剩余迁移边界：handler 仍保留 keepalive、timeout、本地最小 error frame 写出和 transport closeout；下一步应由 Rust response outbound / ErrorErr06 frame planner 产出 timeout/error frame plan，TS 只写帧。

# 2026-06-30: projectPath is also first-source raw metadata in request-executor
- Verified: `RequestExecutorInitialRequestState` returns `projectPath` from raw initial metadata (`clientWorkdir / client_workdir / workdir / cwd`) and `request-executor.ts` passes that explicit value into `buildProviderExecutionSuccessResult()`.
- Verified: `buildProviderExecutionSuccessResult()` no longer derives `projectPath` from `mergedMetadata`; usage log info now consumes the explicit request-side value.
- Verification: `npx tsc -p tsconfig.json --noEmit --pretty false` plus focused `request-executor-request-state.spec.ts`, `request-executor-provider-response.metadata-propagation.spec.ts`, and `request-executor.metadata-center.contract.spec.ts` all pass.

# 2026-06-30: request-executor raw metadata is first source for stats-adjacent request context
- Verified: `initializeRequestExecutorRequestState()` uses initial request metadata directly for session / conversation log context, and `resolveResponsesConversationRequestCaptureArgsForChatProcessEntry()` reads `matchedPort` from raw metadata fields first (`portScope` / `matchedPort` / `routecodexLocalPort` / `localPort` / `entryPort` / `routecodexPort`).
- Verified: `MetadataCenter` stays for control semantics, but it is no longer the first source for these data-plane fields in request-executor capture/log context.
- Verification: `npx tsc -p tsconfig.json --noEmit --pretty false`, `tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts`, and `tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts` all pass.

# 2026-06-30: request-executor priority backoff wait test needs fake-timer tick flush
- Verified: the runtime backoff path already records `provider.transport_backoff.recorded` and emits `server.global_error_backoff_wait` for the same provider scope; the flaky Jest was asserting before the async boundary finished under fake timers.
- Rule: when testing this wait path with fake timers, advance by `0ms` after starting the second request so the executor can reach the wait log before the `1s` timer is advanced.
- Verification: `tests/server/runtime/http-server/request-executor.spec.ts -t "records transport backoff and waits before the same priority provider is hit again"` now passes.

# 2026-06-30: stats data plane still split; unify before UI
- Verified data-plane split: `StatsManager` owns historical provider + periods, `token-stats-store` owns token alltime/daily/per-provider, and `usage-logger` still keeps a local-day per-provider call counter for log lines. `/daemon/stats` currently merges multiple sources; it is not a single owner.
- Verified day-boundary mismatch: token daily stats use local date (`getTodayKey()` / `resolveLocalDayKey()`), but `StatsManager.mergeSnapshotIntoPeriods()` still buckets daily periods with UTC day keys (`toUtcDayKey()`), so call-count daily periods and token daily periods do not share the same 00:00 cutoff yet.
- Verified residue: `src/tools/stats-request-events.ts` and `src/tools/stats-usage.ts` have no runtime consumers; they are standalone stats-file helpers, not part of the live `/daemon/stats` call path.
- Verified coverage gap: stats-related owner/queryability entries are absent from `docs/architecture/function-map.yml`, `docs/architecture/mainline-call-map.yml`, and `docs/architecture/verification-map.yml`, so the stats data plane is not yet locked as a single queryable owner surface.

# 2026-06-30: stats local-day bucket test stabilization
- Fixed unstable day-boundary test by mocking `Date.now` in `tests/server/runtime/http-server/stats-manager.periods.spec.ts` local-boundary case, because `StatsManager.snapshot()` uses `Date.now()` not its `uptimeMs` argument for `generatedAt`.
- Verification: `tests/server/runtime/http-server/stats-manager.periods.spec.ts` now passes; full compile `npx tsc -p tsconfig.json --noEmit --pretty false` and related stats tests pass.
- Residual: UI 未开始建设，数据面口径统一（token 和 provider daily cutoff 一致性）仍待上层收口前置后处理再进行。

# 2026-06-30: servertool execution followup contract retired

- Verified: servertool execution outcome no longer owns a followup/pending-injection contract. Runtime outcome input/output and execution materialization now reduce to execution contract fields (`outcomeMode`, `flowId`, `requiresPendingInjection`, `remainingToolCallIds`, `primaryExecutionMode`) and `ServerToolExecution.flowId`; old fields such as `followupStrategy`, `resolvedFollowup`, `pendingSessionId`, `aliasSessionIds`, `pendingInjectionMessageKinds`, `hasLastExecutionFollowup`, and `pendingInjectionMessagesResolved` are absent from active runtime output and remain only as negative assertions in Rust/Jest tests.
- Boundary: stopless still uses current request/session identity (`requestTruth.sessionId` and CLI command payload session/request ids). Do not restore retired `pending-session`, `sessionDir`, or `servertool-pending/*` file persistence to solve stopless progression.
- Verification evidence: root/sharedmodule TypeScript PASS; focused servertool Jest 52 passed; `servertool-core execution_outcome_runtime_action_contract` 6 passed; `router-hotpath-napi` bridge/skeleton focused Rust tests passed; native hotpath build PASS; `verify:servertool-rust-only`, `verify:function-map-compile-gate`, and `verify:architecture-mainline-call-map` PASS.

# 2026-06-30: servertool precommand/pending-session retired
- `pre-command-hooks` / `pending-session` / `pending-injection` 已从 servertool runtime 物理退役；对应 Rust contract、TS wrapper、spec 已删除。
- stopless 的 session truth 仍是当前 request 的 `requestTruth.sessionId`，并由 `MetadataCenter.runtime_control.stopless` + current request tool output 推进；`sessionDir` / `servertool-pending/*` 不再是必需持久化真源。
- `hub.servertool_followup` 仍是 active Rust owner，不能把它当成已经删除的死语义；如果未来要移除，需要单独的主链重构和 gate 收口。

# 2026-06-30: foundation contract added before routing
- Added `docs/agent-routing/05-foundation-contract.md` as the top-level completion contract.
- `docs/agent-routing/00-entry-routing.md` now points to foundation contract before any route split.
- `AGENTS.md`, `coding-principals`, `feature-dev`, and `dev-flow` now all share the same default runtime-change closure loop: `red/failing sample -> unique owner fix -> build/install -> restart -> health/smoke -> old-sample replay -> full gate`.
- Evidence: docs readback + `git diff --check` pass.

# 2026-06-30: 10000/5555 routing fallback should prefer minimax-m3
- `~/.rcc/config.toml` (`/Volumes/extension/.rcc/config.toml`) 的 `gateway_coding_10000` 与 `gateway_priority_5555` 路由兜底已统一为 `fwd.minimax.MiniMax-M3`。
- 10000 已去掉 `mimo.mimo-v2.5` 作为 fallback；5555 已去掉 `fwd.minimax.MiniMax-M2.7` 作为后续 fallback，tools/search/web_search/default 仅保留优先主模型 + minimax-m3。
- 验证链：`routecodex config validate`；`routecodex restart --port 5520`；`/health` on 5520/10000/5555 全部 ready。

# 2026-06-30: 4444 tools/search also require minimax-m3 fallback
- `gateway_glm_4444` tools/search/web_search/multimodal/default must include `fwd.minimax.MiniMax-M3` after `fwd.gpt.gpt-5.3-codex-spark`. Without M3, `cc` transport failure plus `ykk` 503 `system_memory_overloaded` exhausts the Spark pool and `/v1/responses` fails at routing with `PROVIDER_NOT_AVAILABLE` projected as 502.
- Runtime config truth: `~/.rcc/config.toml` now sets those 4444 routes to `["fwd.gpt.gpt-5.3-codex-spark", "fwd.minimax.MiniMax-M3"]`; `routecodex config validate` and `127.0.0.1:4444/health` passed on RouteCodex `0.90.3313`.
- Validation sample: user failure `openai-responses-router-gpt-5.5-20260630T082343839-424714-4997` was preceded by Spark pool exhaustion; after config fix, a real 4444 `/v1/responses` probe returned `response.completed` with `4444 fallback probe ok` and logs no longer showed immediate `PROVIDER_NOT_AVAILABLE` for tools/search requests.

# 2026-06-29: Anthropic tool_result turn boundary
- Rust `anthropic_openai_codec` must not merge a user `tool_result` turn with the following ordinary user text / placeholder text turn; only adjacent `tool_result`-only user turns may merge.
- This prevents tool execution results from absorbing later user-facing continuation text into the same Anthropic user turn, which can corrupt provider-facing tool history. Keep the whitebox tests `build_anthropic_from_openai_chat_keeps_tool_result_separate_*` as the regression lock.
- Stopless Anthropic provider payload tests must use `metadataCenterSnapshot.runtimeControl.stopMessage.enabled=true`; flat `metadata.stopMessageEnabled` is not a valid stopless truth source.

# 2026-06-30: provider wire metadata allowlist hard gate
- Provider wire body must never carry internal metadata carriers. `metadata` and `__metadataCenter` are both internal-control fields at provider-boundary time; OpenAI SDK call options and Anthropic provider wire executor must fail-fast if either key is present.
- `MetadataCenter` may keep a JS compatibility mirror named `__metadataCenter`, but it must be non-enumerable; enumerable mirrors can leak through object spread / JSON snapshot into provider request samples.
- Runtime bug verification requires checking canonical samples under `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/provider-request*.json`, not just transport logs. Regression sample `req_1782777285968_648ee193` on port 10000 proves both first and retry provider requests omit `__metadataCenter` and return HTTP 200.
- After global install, sample `req_1782778804787_45cbed3f` on port 10000 with RouteCodex `0.90.3312` re-proved both provider requests omit `metadata` / `__metadataCenter` and provider responses are HTTP 200.

# 2026-06-30: internal debug error numbering boundary
- `debug.internal_error_numbering` is the sole owner for RouteCodex internal debug `500-1xx/2xx/3xx` codes and envelope construction; call sites must not scatter `500-*` literals or wrap external/provider/upstream/client errors as internal envelopes.
- External transport/provider failures such as `ECONNRESET` / `fetch failed` should log as `source=external_transport` with a compact reason and optional `ExternalErrorLink`; only RouteCodex-owned internal failures, such as VR retry route failure, should print an internal code like `internalCode=500-130`.
- When diagnosing `fetch failed`, verify DNS/route first: on 2026-06-30 `xlapis.com` and `api2.orangeai.cc` resolved locally to `198.18.*` reserved addresses while public DNS returned public IPs, proving the visible transport error was caused by DNS/proxy routing rather than an internal `500-*` failure.

# 2026-06-29: SSE partial-stream salvage fallback removed
- Chat/Responses SSE decode projection 不允许在 stream terminated / timeout 后把已收到的 partial chunks salvage 成成功响应；错误必须显式进入 SSE decode error path。
- `chat-sse-to-json-converter.ts` 的 `isTerminatedError` / `trySalvageResponse` 和 `responses-sse-to-json-converter.ts` 的 `tryMaterializeFinalResponse` 已删除；`verify:sse-architecture-boundary` 防止 `const salvaged =` / `return salvaged` 类 fallback 复活。
- 回归测试分别锁住 chat partial stream termination 与 responses missing terminal done timeout，证明不会把未完整终止的流投影为成功。

# 2026-06-29: chat SSE projection provider-specific residue removed
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts` 已物理删除 DeepSeek-web patch/error/control 兼容逻辑；通用 chat SSE 转换器只保留标准 chat chunk / done / error / ping 处理。
- `verify:sse-architecture-boundary` 已扩展到 provider-neutral SSE projection files，禁止 `deepseek/glm/lmstudio/minimax/qwen/kimi/siliconflow` 等 provider-specific marker 复活。
- 旧 DeepSeek patch 样本应在通用 chat SSE 转换器中 fail-fast，不再被当成可重用的 provider-neutral 语义帧。

# RouteCodex Project Memory

# 2026-07-01: Gemini SSE decode scalar parts must fail fast
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.ts` must not pass non-object `gemini.data.part` through as a candidate content part. Scalar/null malformed semantic parts fail fast with `Invalid Gemini data event: invalid part at index <n>`.
- Gate truth: `verify:sse-architecture-boundary` blocks the old decode-side `return [part]` marker, and `tests/sharedmodule/sse-parser-no-recovery.spec.ts` locks malformed frame, missing part, and scalar part reverse paths. Real Gemini provider-response replay remains unavailable in current sample stores.

# 2026-07-01: Anthropic SSE empty text must fail fast
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not use `if (!chunk) continue` to silently skip empty text/thinking chunks. Empty Anthropic text is invalid provider shape and must fail fast with `Invalid Anthropic text block: missing text`.
- Gate truth: `verify:sse-architecture-boundary` now blocks the old chunk-skip marker, and `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` locks valid event flow plus empty-text reverse coverage. Real Anthropic success replay remains unavailable; current sample stores only contain 429 provider-error snapshots.

# 2026-07-01: Anthropic/Gemini SSE serializers must not synthesize event types
- `serializeAnthropicEventToSSE` and `serializeGeminiEventToSSE` are wire framing shells only; they must require explicit `event` or `type` and fail fast when missing. Do not restore Anthropic payload-derived / default `message` fallback or Gemini default `gemini.data` fallback in serializer code.
- Gate truth: `verify:sse-architecture-boundary` blocks the old Anthropic/Gemini serializer fallback markers, and `tests/sharedmodule/anthropic-gemini-sse-serializer-no-fallback.spec.ts` locks positive explicit-event serialization plus reverse missing-event fail-fast.

# 2026-07-01: Chat SSE finish/usage payload is Rust-owned
- Chat JSON->SSE final chunk payload and strict usage normalization are native-owned by `buildChatSseFinishPayloadJson`; `event-generators/chat.ts` must not restore local `normalizeChatUsage()` / `readNonNegativeInteger()` or local `{ choices: [{ delta: {}, finish_reason }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old Chat finish/usage markers. Rust requires valid `finish_reason`, positive `created`, non-negative `choice_index`, and explicit `prompt_tokens` / `completion_tokens` / `total_tokens` when usage is present; missing usage remains omitted, invalid usage fails fast.

# 2026-07-01: Chat SSE tool-call start payload is Rust-owned
- Chat JSON->SSE tool-call start chunk payload is native-owned by `buildChatSseToolCallStartPayloadJson`; `event-generators/chat.ts` must not restore local `{ choices: [{ delta: { tool_calls: [{ id, type, function: { name, arguments: "" } }] } }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old `arguments: ''` marker. TS-side `toolCall.type || 'function'` fallback is removed; Rust requires `tool_call_type === "function"` and fails fast on missing or invalid type.

# 2026-07-01: Chat SSE tool-call args delta payload is Rust-owned
- Chat JSON->SSE tool-call arguments delta chunk payload is native-owned by `buildChatSseToolCallArgsDeltaPayloadJson`; `event-generators/chat.ts` must not restore local `{ choices: [{ delta: { tool_calls: [{ function: { arguments } }] } }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old `function: { arguments: args }` marker; Rust tests cover missing arguments fail-fast, and real chat replay must preserve tool-call args chunks without malformed wire.

# 2026-07-01: Chat SSE reasoning delta payload is Rust-owned
- Chat JSON->SSE reasoning delta chat completion chunk payload is native-owned by `buildChatSseReasoningDeltaPayloadJson`; `event-generators/chat.ts` must not restore local `{ choices: [{ delta: { reasoning, reasoning_content } }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old `delta: { reasoning, reasoning_content: reasoning }` marker; Rust tests cover missing reasoning fail-fast, and focused chat SSE tests preserve reasoning roundtrip compatibility.

# 2026-07-01: Chat SSE content delta payload is Rust-owned
- Chat JSON->SSE content delta chat completion chunk payload is native-owned by `buildChatSseContentDeltaPayloadJson`; `event-generators/chat.ts` must not restore local `{ choices: [{ delta: { content } }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old `delta: { content }` marker; Rust tests cover missing content fail-fast, and focused chat SSE tests preserve data-only Chat SSE wire compatibility.

# 2026-07-01: Chat SSE role delta payload is Rust-owned
- Chat JSON->SSE role delta chat completion chunk payload is native-owned by `buildChatSseRoleDeltaPayloadJson`; `event-generators/chat.ts` must not restore local `{ choices: [{ delta: { role } }] }` payload synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks the old `delta: { role: role as ... }` marker; focused chat SSE tests and real chat replay must preserve data-only Chat SSE wire compatibility.

# 2026-07-01: Chat SSE error payload is Rust-owned
- Chat JSON->SSE error payload shape (`error.message`, `error.type=internal_error`, `error.code=generation_error`) is native-owned by `buildChatSseErrorPayloadJson`; `event-generators/chat.ts` must not restore local error object synthesis.
- Gate truth: `verify:sse-architecture-boundary` blocks `type: 'internal_error'` and `code: 'generation_error'` inside the Chat SSE generator; invalid usage tests lock error projection without successful `[DONE]`.

# 2026-07-01: Chat SSE event envelope is Rust-owned
- Chat JSON->SSE event envelope fields (`timestamp`, `sequenceNumber`, `nextSequenceCounter`, `protocol`, `direction`) are native-owned by `buildChatSseEventEnvelopeJson`; `event-generators/chat.ts` must not restore `TimeUtils.now()` or fixed `sequenceNumber: 0`.
- `chat-sequencer.ts` must not overwrite Chat SSE event sequence numbers locally after generator output; sequencing advances through the native envelope owner and `ChatEventGeneratorContext.sequenceCounter`.
- Gate truth: `verify:sse-architecture-boundary` blocks the old Chat TS envelope markers; focused chat SSE tests plus real chat sample replay lock wire compatibility.

# 2026-07-01: Responses SSE event envelope and metadata stripping are Rust-owned
- Responses JSON->SSE event envelope fields (`timestamp`, `sequenceNumber`, `nextSequenceCounter`, `protocol`, `direction`) are native-owned by `buildResponsesSseEventEnvelopeJson`; `responses.ts` must not restore `TimeUtils`, local sequence advancement, or `createBaseEvent()` semantics.
- Client-visible Responses SSE response payload normalization must strip internal `metadata` in Rust `normalize_responses_sse_response_payload`; do not add TS-side metadata filtering fallback in the SSE generator or handler.
- Gate truth: `verify:sse-architecture-boundary` blocks the old TS envelope owner markers, and metadata boundary tests must prove internal metadata does not leak into re-encoded SSE payloads.

# 2026-07-01: Responses SSE error recovery policy is Rust-owned
- `responses-sequencer.ts` must not expose `enableRecovery` or recover per-output-item errors locally; item errors bubble to response-level policy, and response-level `response.error` projection is planned by Rust `planResponsesSseErrorRecoveryJson`.
- Gate truth: `verify:sse-architecture-boundary` blocks local `enableRecovery` and item-level `yield buildErrorEvent(error as Error, context, config)` recovery from returning; focused Jest must prove invalid output items do not continue to `response.completed` / `response.done`.

# 2026-06-29: servertool CLI projection TS facade deleted
- `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 与旧 `tests/servertool/servertool-cli-projection.spec.ts` 已物理删除；generic servertool CLI projection 的活入口是 `cli-projection-runtime-shell.ts` 调 Rust/native `buildClientExecCliProjectionOutputWithNative`、`buildClientVisibleProjectionShellWithNative`、`buildServertoolCliProjectionExecutionContextWithNative`。
- `tests/servertool/cli-projection-runtime-shell.spec.ts` 取代旧 projection spec；function/verification map、wiki/html 与设计文档应指向 runtime shell 和 Rust/native owner。`verify:servertool-rust-only` 必须防止旧 facade/test 复活，并禁止 TS runtime shell 手拼 `exec_command` shape 或 CLI command string。
- Stopless CLI stdout 不再暴露 `schemaGuidance`；相关测试应保持 `schemaGuidance` undefined，schema guidance 只能走下一轮模型侧修复材料，不进入 client-visible CLI stdout。

# 2026-06-29: chat-process session usage Rust-owned
- `saveChatProcessSessionActualUsage` 的 request counter、local-day reset、tmux session usage scope、token/message usage writeback 已收口到 Rust `virtual_router_engine::chat_process_session_usage` + `routing_state_store::GlobalRequestCounter`。
- TS `chat-process-session-usage.ts` 只允许调用 `planChatProcessSessionUsage` native shell；禁止恢复 TS scope resolver、usage normalization、routing state load/write、`Date.now()` timestamp owner。
- counter 持久化真源是 `~/.rcc/state/global-request-counter.json`；Rust tests 必须用 `with_session_dir_override` 隔离临时 counter，禁止污染真实 `~/.rcc` 状态；counter 读/解析/写入失败必须 fail-fast，不能重置成新 counter 继续成功。

# 2026-06-29: provider-response duplicate V2 orchestration owner rejected
- Provider response orchestration 主线当前 Rust 真源是 `hub_pipeline_lib/engine.rs` 产出的 response effect plan，以及 `hub_pipeline_lib/effect_plan.rs` 的 native effect plan normalizer / servertool runtime action planner。
- 禁止新增独立 `provider_response_orchestration_v2` / `native-provider-response-orchestration-v2` / `native-provider-response-sse-materialize-fallback` 第二 owner；这类未接入 planner 会复制 SSE materialization、usage normalization、servertool plan、streamPipe 和 metadata write semantics，必须物理删除并用 residue audit 防复活。

# 2026-06-30: provider-response streamPipe timestamp and stopMessage action gates
- Provider-response stream encode 的 `created/created_at` 必须由 Rust client projection owner 在进入 SSE codec 前保证为正数；`created_at:0` / missing timestamp 不能在 TS SSE codec 或 handler 中补 fallback，应该在 `responses_payload.rs` / chat projection owner 修。
- `servertoolRuntimeAction` 只能在 stopMessage/stopless runtime 明确 active 时由 Rust response planning 生成；普通 `finish_reason:"stop"` streaming path 不得生成 action，否则 TS IO shell 可能把 action payload 当 post-governance payload 覆盖 Rust `streamPipe.payload`。
- TS `provider-response.ts` 只允许在 servertool orchestration 实际 `executed` 后做 post-servertool client projection；未执行 action plan 不得改变 payload。正反测试应同时覆盖普通 stream 无 action、stopMessage active 有 action、Responses existing payload `created_at:0` 被 Rust 修正。

# 2026-06-29: stopless followup-flow skip branch removed
- `serverToolFollowup` 不再是 stop-message auto handler 的 skip / recursion guard truth；stopless 决策不得读取 `followup_flow_id` 或 `runtime_control.serverToolFollowup` 来返回 `skip_servertool_followup_hop`。
- `serverToolFollowup` 仍可作为 routing/metadata control 使用，但 stopless lifecycle 的继续/终止真源是 Chat Process request/response boundary、MetadataCenter `runtime_control.stopless` 和当前请求 tool output。
- `verify:servertool-rust-only` 与 residue audit 已锁住 `followupFlowId`、`read_servertool_followup_flow_id`、`STOP_MESSAGE_FOLLOWUP_FLOW_ID`、`skip_servertool_followup_hop` 不复活。

# 2026-06-29: stopless runtime-state MetadataCenter-only closeout
- stopless runtime-state restore 真源已收口到 Rust `servertool-core/src/persisted_lookup.rs::resolve_runtime_stop_message_state_from_metadata_center`，只读取 `MetadataCenter.runtime_control.stopless`（或同语义 snake-case carrier）；旧 adapter-context surface、`stopMessageState`、`serverToolLoopState`、`responsesRequestContext` data-plane restore 均不是合法 runtime-state truth。
- NAPI/TS surface 名称必须使用 `resolveRuntimeStopMessageStateFromMetadataCenter*`；`resolveRuntimeStopMessageStateFromAdapterContext*` / `RuntimeStopMessageStateFromAdapterContext*` 属于已删 surface，`verify:servertool-rust-only` 必须防复活。
- `tests/servertool/stop-message-runtime-utils.continuation.spec.ts` 已删除；`hub.metadata_center_mainline` required tests 改由 `tests/servertool/stopless-cli-continuation.spec.ts` 和 `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 锁住。

# 2026-06-29: servertool backend-route public surface retirement
- `backend_route_contract.rs` / `BackendRouteReenter` / `ServertoolBackendRouteHint01Planned` / `planServertoolBackendRoutePolicy*` 已从 servertool public surface 退役；`verify:servertool-rust-only` 现在应检查旧文件物理缺失与 forbidden marker，而不是要求旧 backend-route owner 符号存在。
- 退役 gate 不能用 `return` 后不可达旧断言保留历史合同；旧 “must exist” 检查必须物理删除，否则会误导后续 agent 复活已删 surface。
- `extractTextFromChatLikeWithNative` 是合法 thin wrapper：TS 只 JSON stringify/parse 并调用 `extractServertoolTextFromChatLikeJson`，文本抽取真源仍是 Rust `servertool-core/src/text_extraction.rs`。

# 2026-06-29: req-outbound provider wire compat TS actions closeout
- `HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload` 的 provider wire compat 真源是 Rust `req_outbound_stage3_compat`；旧 `sharedmodule/llmswitch-core/src/conversion/compat/actions/*` TS action 与自测已物理删除，并由 `verify:responses-request-compat-rust-only` 防复活。
- compat shell 测试必须绑定 `MetadataCenter.runtime_control.providerProtocol`；flat `adapterContext.providerProtocol` 只能作为测试输入辅助，不是 req-outbound compat owner 真源。
- 最新 MiniMax `tool id() not found` error-only 样本缺 `client-request.json` 时不能宣称完整在线复打；可用最近 replayable `/v1/responses` client sample 补充验证，但剩余风险必须明确。

# 2026-06-29: Responses request context capture must use current provider request label
- `/v1/responses` request context capture belongs at request Chat Process entry and response capture at response Chat Process exit; handler/inbound/outbound must not own continuation context repair.
# 2026-06-30: Chat JSON->SSE usage aliases are forbidden in encode projection

- Verified: `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/chat.ts` only accepts canonical chat usage fields during JSON->SSE projection: `prompt_tokens`, `completion_tokens`, and `total_tokens`.
- Removed compatibility/fallback paths: Responses-style `input_tokens/output_tokens`, camelCase `promptTokens/completionTokens/inputTokens/outputTokens/totalTokens`, and computed `total_tokens = prompt + completion` are no longer accepted in the Chat encode owner.
- Gate: `npm run verify:sse-architecture-boundary` forbids those legacy usage markers and total-token synthesis in the Chat SSE generator; `tests/sharedmodule/chat-sse-usage-no-fallback.spec.ts` locks alias and missing-total input as `generation_error`.
- Replay evidence: real chat SSE sample `req_1782778465399_hrxbpl3tz/provider-response_1.json` materializes via native-backed chat parser, then re-encodes through Chat JSON->SSE with `[DONE]`, no generation error, and canonical chat usage preserved.

# 2026-06-30: Responses JSON->SSE usage aliases are forbidden in encode projection

- Verified: `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` only accepts canonical Responses usage fields during JSON->SSE projection: `input_tokens`, `output_tokens`, `total_tokens`, and optional `input_tokens_details.cached_tokens`.
- Removed compatibility/fallback paths: `prompt_tokens`, `completion_tokens`, `cache_read_input_tokens`, and computed `total_tokens = input + output` are no longer accepted in the Responses encode owner.
- Gate: `npm run verify:sse-architecture-boundary` forbids those legacy usage markers in the Responses SSE generator; `tests/sharedmodule/responses-sse-usage-no-fallback.spec.ts` locks legacy alias input as `response.error` rather than silent normalization.
- Replay evidence: real 4444 `/v1/responses` SSE sample `req_1782794773576_s7okhowx0/provider-response_1.json` materializes via native Responses SSE parser, then re-encodes through JSON->SSE with `response.completed` and `response.done`, no `response.error`, and canonical usage preserved.

- If request-executor rebinds `input.requestId` to a provider request id, response-side store writes must use the current `requestLabel` first; stale `MetadataCenter.requestTruth.requestId` is only a fallback. Otherwise `recordResponsesResponse` can look up the old router id after the store was re-bound to the provider id and throw `missing_request_context`.
- Regression lock: `tests/sharedmodule/provider-response.metadata-center-provider-protocol.spec.ts` expects provider-response to record with provider request id even when `requestTruth.requestId` contains the old router id; live replay sample `req_1782692128504_59e1d218` on port 5555 must return HTTP 200 with `response.completed`.

# 2026-06-29: MetadataCenter dualwrite gate / stopMessageEnabled flat truth closeout
- `hub.metadata_center_dualwrite_api` 的 closeout gate 必须在 `docs/architecture/metadata-center-manifest.yml` required gates 中可查询；`verify:metadata-center-dualwrite-api` 已锁住 manifest gate 绑定和 direct Rust truth residue。
- Req governance 的 stopless instruction injection 只能读 `MetadataCenter.stop_message_enabled()`；flat `metadata.stopMessageEnabled` 不再是合法 truth source，gate 禁止其复活。
- 本切片已验证 metadata dualwrite gate、metadata manifest/code sync、write-boundary、leak-boundary、function-map/mainline/wiki gates、metadata dualwrite Jest、Rust non-test check/native build、TS typecheck、stopless invalid-schema blackbox。当前 cargo lib tests 仍被并行 servertool test-only missing export blocker 拦住，`verify:servertool-rust-only` 仍被脚本 ReferenceError 拦住，二者不能作为本切片闭环证据。

# 2026-06-29: MetadataCenter bridge projection node sync
- `metadata.center.mainline` 必须显式区分 `MetaResp07BridgeMetadataBound` 与 read-only `MetaResp07ServertoolContextProjected`：bridge 绑定由 `buildBridgeAdapterContext -> readRuntimeServerToolProjection` 锚定，servertool context projection 由 `runProviderResponseRustHubPipeline -> readRuntimeControlFromBoundMetadataCenter` 锚定，closeout 继续由 `releaseMetadataCenterForHttpResponse -> markReleased` 负责。
- `MetaResp07ServertoolContextProjected` 在 `metadata-center-manifest.yml` 中只能是 read-only stage，不允许 `write_families`；`verify:architecture-metadata-center-write-boundaries` 已锁住该规则。
- 已提交 `8aa2fec8d docs(metadata): split servertool bridge node`，并在 clean worktree 验证 metadata write-boundary、manifest-code-sync、mainline-call-map、mainline-manifest-sync、wiki-sync、mainline node consistency、function-map compile gate 与 `git diff --check` 通过。主工作树的后续 function-map gate 可能被并行 `hub.chat_process_session_usage` 脏改阻塞，需按独立 slice 处理。

# 2026-06-29: virtual router rustification audit 结论
- virtual router 核心选路、metadata surface、route availability floor、primary_exhausted plan 已是 Rust 真源；TS 侧主要残留在 bootstrap/wrapper、host effects、hit-log、bridge/tests/docs。
- 收口顺序应先做纯薄壳删除，再做 metadata/routeHint 相关桥接收口，最后清理测试与文档残留；vra-04 仍是 TS consumer 边，不是 VR 真源。
- 2026-06-29 thin-wrapper slice：VR bootstrap wrapper 禁止本地 `loadNativeRouterHotpathBinding` / error plumbing，统一走 `callNativeJson`；executor singleton route-pool exhaustion 只能消费 Rust `evaluateSingletonRoutePoolExhaustionNative`，不得在 TS 重算 hold/floor 语义。

- 2026-06-28: provider error 处理必须走统一 ErrorErr01-06 链，错误中心消费 `ErrorErr05ExecutionDecision` 后才能决定 reroute / project；`error.backoff_action_queue` 只负责 1s -> 3s -> 5s 的 blocking wait，不负责 provider 冷却。`priority` 模式是 strict ordered failover，`ykk` 仍可选时不得落到 `asxs` / `XL`。
- 2026-06-28: 已按架构移除的不合规 TS owner 不得因为 build/map 缺失而恢复。遇到 `servertool-adapter-context.ts` 这类已删 TS owner 被 mainline/function-map 引用时，应把调用边和 docs 收到当前合法 owner（如 bridge 本地 adapterContext 组装或 Rust/native owner），并保持旧 TS 文件物理删除。
- 2026-06-28: `provider-traffic-governor.ts` 旧 server runtime owner/test 属于已迁移 TS 面；`error.backoff_action_queue` 的 map/gate 应指向 `src/modules/traffic-governor/index.ts`、native traffic governor binding 和 executor 现有单测，不得恢复旧 `tests/server/runtime/http-server/provider-traffic-governor.spec.ts`。
- 2026-06-28: runtime bug 修复不能只用单测、编译或泛化 smoke 宣称闭环；必须用触发该问题的原始出错请求样本在线重放，确认同一个样本不再复现。若样本复打仍失败，继续追唯一真源修复，不能把“修了代码”当完成。
- 2026-06-28: 10000 长上下文 routing 中，`longcontext:token-threshold` 必须优先于 `search:last-tool-search`，否则超大上下文会被 search continuation 抢到小/search provider 并触发 provider context 400。修复 owner 是 Rust `virtual_router_engine::classifier`，不是 req/resp outbound 或 SSE。
- 2026-06-28: provider HTTP 200 business error 不是 malformed response，不能包成 502。`base_resp.status_code` / `error.code` / `error.type` 等上游业务错误应保留为 `PROVIDER_BUSINESS_ERROR` + upstream code/message；容量/限流类投影 429，普通业务拒绝投影 400，除非有明确合同不得改写成 generic upstream 502。
- 2026-06-27: `providerProtocol` 唯一真源是 provider config/init 后的 provider handle，并只能在 VR/provider selection 后写入 `MetadataCenter.runtime_control.providerProtocol`；禁止从 client entry endpoint、payload shape、`providerTypeToProtocol`、flat `metadata.providerProtocol` 或 `adapterContext.providerProtocol` 推导/兜底。响应解析和 servertool/usage 等内部消费者只读 MetadataCenter，冲突必须 fail-fast。
- 2026-06-27: `/v1/responses` 续接/恢复的响应侧清理必须在 Rust owner 内把 `function_call` 和 `function_call_output` 的 `id` 统一规范化为 `fc_*`；只清 meta 或只保留 `call_id` 不够，会把 `call_servertool_cli_*` 原样带回上游并触发 Responses upstream 校验失败。
- 2026-06-27: tmux/session-binding 相关 server 残留可以物理删除，但 Metadata Center 本体不能删；只允许移除 `client_attachment_scope`、`stopMessageClientInject` 这类 attachment/control 语义槽位。该类清理后必须先过 `tsc` 和 `npm run build:base`，若 wiki 门禁失败则先重渲 `render-architecture-wiki-pages.mjs` 与 `render-architecture-wiki-html` 再复验。
- 2026-06-28: stopless 多轮闭环的标准骨架是 Rust ReqChatProcess 产出 `metadata.runtime_control.stopless`，TS request-stage shell 只把该 Rust plan 写入同一请求绑定的 `MetadataCenter.runtime_control.stopless`，Response ChatProcess 读取同一 control slot 拦截 stop。`requestTruth.runtimeControl`、top-level metadata、file persistence、sessionDir writeback、SSE/outbound 修补都不是合法 stopless control owner。已用 5555 live probe 验证 `repeatCount=1 -> repeatCount=2 -> stopless budget exhausted`，并用 `stopless-followup-blackbox` 验证 3 次 upstream 命中后第三轮 stop。
- 2026-06-28: stopless stop schema 是条件必填合同，不是全字段必填。`stopreason/reason/has_evidence` 是 attempted schema 基线；`has_evidence=1` 时 `evidence` 必填；terminal `stopreason=0|1` 必须 `has_evidence=1` 且 `evidence` 非空；continue `stopreason=2` 必须 `next_step`，且下一轮模型续跑文本就是 `next_step`；`blocked + needs_user_input=true` 必须把 summary 和用户决策问题返回客户端并以 `finish_reason=stop` 停止等待。已用 `verify:stopless-invalid-schema-blackbox` 验证 missingFields 收敛 `["has_evidence","next_step"] -> ["next_step"]`，并用 `stopless-followup-blackbox` 回归多轮闭环。
- 2026-06-28: Anthropic provider 400 `function name or parameters is empty (2013)` 可能是 provider outbound 把 OpenAI chat tool wrapper 发到 Anthropic `/v1/messages`，而不是工具名/参数本身为空。先查 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/provider-request*.json` 的 provider-facing body。修复 owner 是 Rust `hub_protocol_spec_semantics::normalize_provider_outbound_tools` 复用 `anthropic_openai_codec::map_chat_tools_to_anthropic_tools`；禁止在 TS handler/provider runtime 再做第二套协议 mapper。
- 2026-06-29: Anthropic provider 400 `tool result's tool id() not found (2013)` 的优先判断是 outbound 映射缺失，不是清洗缺失：若 provider-facing `messages` 仍有 OpenAI `assistant.tool_calls` / `role:"tool"` / top-level `tool_call_id`，必须先在 Rust provider outbound policy 对 `anthropic-messages` 执行 whole-payload OpenAI chat history -> Anthropic `tool_use/tool_result` 映射，再进入清洗/allowlist。修复 owner 是 `hub_protocol_spec_semantics::apply_provider_outbound_policy` 调用 `anthropic_openai_codec::build_anthropic_request_from_openai_chat_value`。
- 2026-06-29 token estimator wrapper slice：`native-virtual-router-runtime.ts` 的 `countRequestTokens` / `computeRequestTokens` 已改为共享 `callNativeJson('estimateVirtualRouterRequestTokensJson', ...)`；本地 `loadNativeRouterHotpathBindingForInternalUse` / `readNativeFunction` 已移除，empty / invalid / invalid-token-count 仍 fail-fast。
- 新门禁：`verify-vr-no-ts-runtime` 现在同时锁 `native-virtual-router-runtime.ts`，禁止 token estimator wrapper 重新长回本地 native binding plumbing。
- 已验证：`npm run verify:vr-no-ts-runtime`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p tsconfig.json --pretty false`、`node ../../node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath tests/router/token-counter-media-ignore.test.ts`、`git diff --check`。
# 2026-07-01: Gemini SSE sequencer must not synthesize timestamps
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not write `timestamp: Date.now()`; Gemini wire serialization only needs `event` and `data`, and local timestamp truth must stay absent unless moved to a real native owner.
- Gate truth: `verify:sse-architecture-boundary` blocks `timestamp: Date.now()` in the Gemini sequencer. Focused spec: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts`.
- Replay gap: no Gemini provider-response samples were found under `~/.rcc/codex-samples` or `/Volumes/extension/.rcc/codex-samples`; source replay is the substitute evidence for this slice.

# 2026-07-01: Gemini SSE sequencer must not synthesize fixed sequence numbers
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not write `sequenceNumber: 0`; Gemini wire serialization only needs explicit `event` and `data`, and fake sequence truth must stay absent.
- Gate truth: `verify:sse-architecture-boundary` blocks `sequenceNumber: 0` in the Gemini sequencer. Focused spec: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts`.
- Replay gap: no Gemini provider-response samples were found under `~/.rcc/codex-samples` or `/Volumes/extension/.rcc/codex-samples`; source replay is the substitute evidence for this slice.

# 2026-07-01: Gemini SSE content parts must not be silently dropped
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts` must not use `parts.filter(Boolean)` or equivalent silent cleanup for candidate content parts; null/undefined parts are provider truth errors and must fail fast.
- Gate truth: `verify:sse-architecture-boundary` blocks `parts.filter((part): part is GeminiContentPart => Boolean(part))`. Focused spec: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts`.
- Replay gap: current `~/.rcc/codex-samples` and `/Volumes/extension/.rcc/codex-samples` contain no Gemini provider-response samples; source replay is the substitute evidence for this slice.

# 2026-07-01: Anthropic SSE stop_reason must be explicit
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts` must not synthesize `stop_reason: 'end_turn'`; `message_delta.delta.stop_reason` is provider truth and missing `response.stop_reason` is fail-fast.
- Gate truth: `verify:sse-architecture-boundary` blocks `response.stop_reason ?? 'end_turn'`. Focused spec: `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts`.
- Replay gap: current Anthropic samples under `~/.rcc/codex-samples/anthropic-messages` and `/Volumes/extension/.rcc/codex-samples/anthropic-messages` are 429 error snapshots, not successful provider-response SSE/JSON samples; source replay is the substitute evidence for this slice.

# 2026-07-01: Responses SSE output_text text is Rust-required
- Responses JSON->SSE 不允许 TS 或 Rust payload owner 把缺失 `output_text.text` 合成为 `""`；`responses_sse_event_payload` / `shared_output_content_normalizer` 必须 fail-fast，由 sequencer 投影为 `response.error`，并禁止继续输出 `response.output_text.done` / `response.completed` / `response.done`。
- Gate 口径：`verify:sse-architecture-boundary` 必须禁止 `if (!text) return;`、`&& !!content.text`、`if (isTextContent && content.text)`、Responses generator 内 `if (!chunk) continue;` 这类 TS silent skip 门。

# 2026-06-30: route entry hard query gate added
- 项目入口与调试技能已补硬查询门槛：每个改实现任务必须先读 `docs/agent-routing/05-foundation-contract.md`，再查 `docs/architecture/function-map.yml`、`docs/architecture/mainline-call-map.yml`、`docs/architecture/verification-map.yml` 和对应 wiki/mainline source。
- 入口、运行时路由、`rcc-dev-skills` 现在都明确要求：1-2 次内定位不到唯一 owner / 唯一主线边，就先补 map/contract，再动实现；验证后必须做 architecture review，排查 fallback、临时绕路、补丁式修复和错层修复。

# 2026-06-30: Responses SSE terminal detection must be chunk-safe
- 若 `/v1/responses` 客户端报 `stream closed before response.completed`，先对照 provider snapshot 与 client snapshot：upstream `provider-response_*.json` 已有 `event: response.completed` 时，不要补 synthetic terminal，应查 server SSE transport 是否把终态识别绑在单 chunk 文本上。
- `handler-response-sse.ts` 的终态状态机必须跨 chunk 扫描 `event: response.completed/response.done/response.error` 与 `data.type` 终态；SSE chunk 边界不可作为协议语义边界。

# 2026-07-01: Responses response bridge toolsRaw truth is explicit context only
- `responses-response-bridge.ts::normalizeResponsesClientPayloadForHttp()` must not reconstruct client projection tools from `context.clientToolsRaw`, `payload.tools`, or `[]`.
- The only legal response-bridge input for `/v1/responses` client projection is explicit `requestContext.context.toolsRaw`; if it is missing or malformed, fail fast with `Responses client projection requires requestContext.context.toolsRaw`.
- Gate: `verify:responses-handler-single-bridge-surface` forbids `contextClientToolsRaw`, `payloadTools`, and `requestContext?.payload?.tools` in the response bridge.

# 2026-06-30: servertool rustification audit snapshot
- `docs/architecture/function-map.yml` 已把 servertool 主要语义 owner 挂到 Rust `servertool-core` / `router-hotpath-napi`，但 `docs/architecture/mainline-call-map.yml` 的 `servertool.hook_skeleton.mainline` 仍是 `binding pending`，说明 runtime 主线还没完全锚定。
- 仍含明显 TS 语义的重点模块：`engine-orchestration-shell.ts`（stopless 本地 JSON parse）、`pending-session.ts`（文件 IO + JSON parse/write）、`pre-command-hooks.ts`（config IO + shell/jq/runtime 编排）、`response-stage-orchestration-shell.ts`（response-stage gate + runtime control 写回）、`execution-stage-shell.ts` / `execution-queue-shell.ts` / `execution-handler-materialization-shell.ts`（执行编排 glue）。
- 现阶段最稳妥的 rust 化顺序：先收 `pending-session` / `pre-command-hooks` / `engine-orchestration` 三块真语义，再继续收 execution/response orchestration glue，最后把 registry / selection / preflight / runtime-action / skip / outcome / handler / state 逐块压成最小 native wrapper。

# 2026-06-30: VR default floor diagnostics boundary
- Virtual Router 的 default pool 最后目标是硬保护：即使 `excludedProviderKeys` 包含该 default singleton，也不能把 default 池排空后返回 `PROVIDER_NOT_AVAILABLE`。
- 在线 diagnostics / dry-run 不能用“排除所有 default 目标”来制造问题样本；正确做法是返回命中 default singleton，并显式标记 `defaultFloorProtected=true`，说明这是 default floor 保护，而不是 provider 切换失败。
- 修改 VR selection / retry exclusion 逻辑前必须检查 default route object 和 default pool singleton 保护，不能把 provider exclusion 当成物理移除 default target。

# 2026-06-30: snapshot entryPort SSOT
- provider/client snapshot 的端口真源必须收口到显式 `entryPort` 或绑定的 `MetadataCenter.requestTruth.portScope`，`getCurrentPortRequestContext()`、flat metadata、`__rt`、`portContext`、`localPort`、`matchedPort` 都不能再作为解析路径。
- 对 `provider-*` / `client-*` 这类端口敏感快照，缺少真源要 fail-fast，不能靠兼容回退继续写盘；同类问题先查 writer 和 request-executor 的真源链，再做在线样本重放确认。

# 2026-06-30: stats source truth rule tightened
- Stats/data fields must prefer the raw request/response payload as the first and only source when the field is present there; do not re-derive it from intermediate context or scattered propagation paths.
- `MetadataCenter` remains the owner for control semantics only, not for data extraction when the original payload already contains the needed field.
- This rule means stats/usage/port/session fields need a source-truth audit to remove duplicate derivation and fallback reads from metadata/context carriers.

# 2026-06-30: Responses SSE error projection Rust truth
- SSE error event payload projection is Rust/native truth via `projectSseErrorEventPayloadJson`; `src/server/utils/http-error-mapper.ts::projectSseErrorEventPayload` may only call the `src/modules/llmswitch/bridge` native facade and must not locally construct `{ type:"error", status, error }`.
- When deleting TS bridge surface in this repo, also delete checked-in `src/modules/llmswitch/bridge/*.js` and `.d.ts` mirrors; Jest can load those `.js` mirrors directly and otherwise revive removed JSON->SSE fallback or bridge-owned SSE error helper logic.
- Verified slice: Rust focused test, native hotpath build, root/sharedmodule typecheck, focused SSE/Jest regression, SSE architecture gates, function-map compile gate, residue scan, and `git diff --check` all passed. No install/restart/live replay was done in this slice.
# 2026-06-30: Responses SSE serializer static factories retired

- Verified: `sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts` no longer exposes static `createResponse*` / `createRequiredActionEvent` helpers that synthesize Responses SSE events with `timestamp ?? Date.now()`.
- Gate: `verify:sse-architecture-boundary` now forbids those static factory markers and timestamp fallback in the serializer source; `responses-event-serializer-no-salvage.spec.ts` asserts the runtime static surface is absent.
- Reusable lesson: when an SSE serializer owns only wire formatting, delete dead event-factory helpers instead of keeping “convenient” timestamp synthesis in TS; lock the deletion with a source gate plus a runtime-surface test.
# 2026-06-30: chat SSE usage normalization is Rust-owned

- Verified: `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts` no longer owns local Chat usage normalization; it now calls Rust/NAPI `normalizeChatUsageJson` through `normalizeChatUsageWithNative`.
- Verified boundary: `input_tokens_details` / `prompt_tokens_details` may be `null` in real provider SSE chunks and must be treated as absent details, not as schema errors. Non-null invalid nested shapes still fail-fast.
- Reusable lesson: when Chat SSE decode and Responses/chat outbound already share a usage normalization family, move the remaining decode-side helper to Rust rather than keeping a second TS normalizer. Lock it with a source gate plus a positive native-owner regression.
# 2026-06-30: chat SSE tail empty chunks are transport noise after response truth is established

- Verified with real sample `~/.rcc/codex-samples/openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json`: provider chat SSE may append tail chunks with `choices: []` and empty `id/object/created` after a valid response has already established canonical `id/created/model`.
- Rule: `chat-sse-to-json-converter` must still fail-fast when the first meaningful chunk lacks `id/created/model`, but it must not reject already-established streams because of inert tail / usage-only noise chunks before `[DONE]`.
- Replay evidence after fix: same sample now materializes `id=487e5ebc-ef2c-49d6-a81a-ce555c424a69`, `finish_reason=tool_calls`, one tool call, and usage totals without `Invalid chat completion chunk id`.
# 2026-06-30: Responses JSON->SSE context must not carry fake request/state fields
- `ResponsesJsonToSseContext` 不再包含未消费的 `responsesRequest` / `outputItemStates`；`responses-json-to-sse-converter.ts` 禁止用 `{}` / `new Map()` 撑类型。
- Gate: `npm run verify:sse-architecture-boundary` forbids `responsesRequest: {} as any` and `outputItemStates: new Map()` in the Responses JSON->SSE converter.
- Verification: focused `responses-json-to-sse-context-no-dead-state + responses-json-to-sse-usage` passed, root/sharedmodule TS passed, and real 4444 Responses replay succeeded.

# 2026-06-30: Responses reasoning summary projection is verbatim-only
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts` 的 reasoning summary encode 不能再做 markdown compact / prefix strip / `**Thinking**` 注入。
- canonical rule: 只投影原始 `summary[].text`；TS SSE generator 不承担 reasoning summary 语义修复或格式整形。
- verification: focused Jest `responses-sse-reasoning-summary-no-normalize + responses-sse-metadata-boundary` 通过，真实 4444 Responses 样本重放成功并保留 `reasoning_items=1`。
# 2026-06-30: servertool registry registered-name wrapper removed
- `sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts` no longer exports `isRegisteredServerToolNameViaNativeConfig`; `registry-orchestration-shell.ts` directly calls `skeleton-config.ts::isServertoolRegisteredNameByConfig`.
- `tests/servertool/registry-registration-shell.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the deleted wrapper and lock the direct skeleton/native config path.
- Verification: focused Jest `registry-registration-shell + servertool-registry-casing + server-side-tools.auto-hook-config + servertool-active-orchestration-audit`, sharedmodule TS, `verify:servertool-rust-only`, function-map/mainline gates, and `git diff --check` passed.

# 2026-06-30: servertool dispatch-plan wrapper removed
- `sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts` no longer exports `buildServertoolDispatchPlanInput`; `dispatch-preparation-shell.ts` now calls `buildServertoolDispatchPlanInputWithNative` directly.
- `tests/servertool/servertool-active-orchestration-audit.spec.ts`, `tests/servertool/server-side-tools.dispatch-native.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the deleted wrapper and lock dispatch-preparation to the native input constructor.
- Verification: focused Jest `server-side-tools.dispatch-native + servertool-active-orchestration-audit`, sharedmodule TS, `verify:servertool-rust-only`, `verify:architecture-mainline-call-map`, and `git diff --check` passed.

# 2026-07-03: Codex `tool_mode=code_mode_only` must not be advertised accidentally

# 2026-07-04: 5555 SSE and cooldown restart facts

- `/v1/responses` SSE dispatch from TS to Rust must accept snake_case `request_id` and `body_text`; installed-release replay is required because source can already contain the alias while the live/global package is stale.
- Superseded on 2026-07-07: provider cooldown persistence/import/prune is forbidden. Do not clean expired persisted cooldown during startup; ignore/delete that design and use the later "Provider cooldown persistence is forbidden" entry.
- 5555 is served by serverId 5520 in the current config; live runtime used global `rcc`, so release validation must install and check both `routecodex` and `rcc` before restart/smoke.

- Verified root cause: advertising `tool_mode: "code_mode_only"` from `/v1/models` for `gpt-5.5` changed Codex tool planning. Codex hides direct nested tools under `ToolMode::CodeModeOnly`, so upstream models can emit tool-call transcripts as ordinary text instead of structured tool calls.
- Fix rule: do not expose `tool_mode` from RouteCodex model metadata unless intentionally switching the client into code-mode executor semantics. For current Codex direct/native tool behavior, keep model metadata capability fields such as `apply_patch_tool_type: "freeform"`, `experimental_supported_tools`, `supports_parallel_tool_calls`, and `input_modalities`, but omit `tool_mode`.
- Verification evidence: `routes.invalid-json.spec.ts` passed after removing the expectation; Rust leak regressions passed; `verify:architecture-review-surface-light`, `build:min`, `pack:rcc`, and `verify:rcc-release-install` passed; synchronized global `routecodex/rcc@0.90.3537` installed; live 5555 `/v1/models` has no `tool_mode`; latest 5555 samples and logs contain no tool-call transcript leak markers or missing-context errors after the release startup marker.

# 2026-07-04: rcc lifecycle stop/start must use config port group and HTTP truth

- Verified root cause: `rcc stop` only stopped 5520 because `resolvePortGroupFromConfig({ targetPort })` collapsed a matched multi-port config to `[targetPort]`; `rcc start --snap` then saw 4444 still healthy and exited as `already_running_unmanaged`.
# 2026-07-04: provider model-capacity text is retryable HTTP_429
- Verified rule: provider text `Selected model is at capacity. Please try a different model.` is transient capacity/rate pressure and belongs to recoverable `HTTP_429` (`429.1000`), not `INSUFFICIENT_QUOTA`.
- Owner: `error.provider_failure_policy` via `src/providers/core/runtime/provider-error-catalog.ts`; executors and router should consume the catalog/policy result instead of adding caller-side string patches.
- Evidence: catalog red/green plus policy and HTTP projection Jest passed 45/45; source replay produced `statusCode=429`, `code=HTTP_429`, `shouldRetry=true`, `action=reroute_explicit_alternative`, `decisionLabel=exclude_and_reroute`.
- Current closure gap: build/live install not claimed because existing unrelated llmswitch-core/servertool TS errors block `build:base`, and existing native hotpath issue blocks `verify:provider-failure-ban-blackbox`.

- Lifecycle truth: PID cache/listener PID discovery is not authoritative. If `/shutdown` is accepted on any port in a multi-port RouteCodex process, it can stop the whole group; subsequent sibling ports may correctly report no listener.
- Fix rule: stop/restart/start release lifecycle commands must expand a matched configured port to the full port group when operating on managed config, and `stop` must try HTTP `/shutdown` even when PID discovery returns empty. Guardian finalize/report failures are lifecycle telemetry and must not turn an already-stopped port into a failed stop.
- Installed/live evidence: focused CLI Jest passed, `build:min` and `pack:rcc` passed, both global `routecodex` and `rcc` installed at 0.90.3542, live `rcc stop` on down group exits 0, and live `rcc start --snap` with existing service running shuts down the old group then restores 4444/5520/5555/10000 `/health` at 0.90.3542.

# 2026-07-04 correction: plain start must not stop live servers

- Corrected rule: `rcc start` / `routecodex start` is non-disruptive by default. It may expand the config port group for occupancy checks, but it must not send `/shutdown`, SIGTERM, or restart signals unless the caller passes explicit `--restart` / `--exclusive` or uses the dedicated `restart` command.
- Root cause of the observed unexpected stop: a dirty lifecycle change made `start` default to restart semantics, and an earlier stop-command test without mocked `fetchImpl` touched live `/shutdown`. The test is now isolated, and start tests lock default `restart=false`, explicit `--restart=true`.

# 2026-06-30: servertool engine/response dead carriers removed
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts` no longer carries `effectiveServerToolTimeoutMs`; the engine timeout shell passes a single `serverToolTimeoutMs` truth into `withTimeout()` and timeout error construction.
- `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` no longer accepts explicit `providerProtocol` options; response-stage provider protocol truth stays bound to MetadataCenter runtime_control.
- `tests/servertool/engine-observation-shell.spec.ts`, `tests/servertool/servertool-active-orchestration-audit.spec.ts`, and `scripts/verify-servertool-rust-only.mjs` forbid the removed timeout and response-stage providerProtocol carriers from returning.
- Verification: focused Jest `engine-observation-shell + engine.stopless-session-thin-shell + servertool-active-orchestration-audit + stopless-direct-mode-guard`, sharedmodule TS, `verify:servertool-rust-only`, function-map/mainline gates, and `git diff --check` passed.

# 2026-06-30: servertool response-stage dead runtime-control marker removed
- `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` no longer reads and writes back dead `servertoolResponseOrchestration` runtimeControl residue.
- `tests/servertool/servertool-active-orchestration-audit.spec.ts` and `scripts/verify-servertool-rust-only.mjs` now forbid `writeRuntimeControlToBoundMetadataCenter(` and `servertoolResponseOrchestration` in response-stage orchestration shell; the metadata-center negative test remains the source proving the slot is filtered.
- Verification: focused Jest `servertool-active-orchestration-audit + stopless-direct-mode-guard + request-truth-readers`, sharedmodule TS, `verify:servertool-rust-only`, function-map/mainline gates, and `git diff --check` passed.

# 2026-06-30: servertool outcome-plan wrapper removed
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts` 删除 `buildServertoolOutcomePlanInput` TS wrapper，materialization 直接调用 `buildServertoolOutcomePlanInputWithNative`。
- `tests/servertool/execution-handler-materialization-shell.spec.ts`、`tests/servertool/server-side-tools.dispatch-native.spec.ts`、`tests/servertool/servertool-active-orchestration-audit.spec.ts` 和 `scripts/verify-servertool-rust-only.mjs` 已同步改成 native builder 直连并禁止 wrapper 复活。
- Verification: focused servertool Jest 5 suites passed, sharedmodule TS passed, `npm run verify:servertool-rust-only` passed, `git diff --check` passed.

## 2026-07-01 usage logger detail slimming
- Verified that `logUsageSummary()` should keep the second line only for timing diagnostics (`request.internal`, `hub`, `provider.send`, provider decode tag, `hub.top`) and not print request/sample/attempt/retry/day.calls metadata noise.
- Validation: `tests/server/runtime/http-server/executor/usage-logger.spec.ts` passed 20/20 after the change.

# 2026-07-01: Responses SSE handler/client contracts are transport-only
- `src/server/handlers/handler-response-sse.ts` does not synthesize `response.done`, `upstream_stream_incomplete`, or `response.sse.stream.incomplete`; the SSE layer only transports frames and closes streams.
- Handler/client blackboxes now lock direct provider-specific SSE passthrough, keepalive passthrough, no handler-side `required_action` repair, and no early-close incomplete-error synthesis.
- Verification: `verify:responses-handler-single-bridge-surface`, `verify:responses-sse-business-module`, `verify:sse-architecture-boundary`, `verify:function-map-compile-gate`, sharedmodule/root `tsc`, focused SSE Jest, and `build:base` passed.

# 2026-07-01: Responses reasoning content must not be silently treated as empty
- `ResponsesReasoningItem.content` may be absent, but if present it must be an array; non-array content now fails fast in the Rust SSE event payload descriptor owner with `Invalid Responses reasoning content: expected array`.
- The old TS generator fallback `Array.isArray(reasoning.content) ? reasoning.content : []` is forbidden by `verify:sse-architecture-boundary`.
- Verification: focused Rust/Jest, SSE gates, typechecks, native hotpath build, source replay, and `build:base` passed; current 4444 provider-response samples still lack SSE wire payload fields for real wire replay.
# 2026-07-02: servertool CLI projection branch casts removed
- Verified slice: `execution-stage-shell.ts` no longer casts CLI projection branch `chatResponse` or `execution`; `native-servertool-core-semantics.ts` exposes `ServertoolCliProjectionRuntimeBranchOutput` as `JsonObject` plus `NativeServertoolExecutionSummary`.
- Verification: focused Jest 81/81 passed, sharedmodule `tsc` passed, `verify:servertool-rust-only` passed, `verify:function-map-compile-gate` passed, `verify:architecture-mainline-call-map` passed, `git diff --check` passed.
- Reusable rule: native CLI projection branch wrappers should expose the exact runtime result contract so execution-stage can remain a direct branch dispatcher, not a result-shape caster.

# 2026-07-02: servertool execution loop effect casts removed
- Verified slice: `execution-queue-shell.ts` no longer casts Rust-owned execution loop effect plans into executed-record shapes; `native-servertool-core-semantics.ts` now exposes effect plan `toolCall` / `execution` with the native executed-record types consumed by `appendServertoolExecutedRecordWithNative`.
- Verification: focused Jest 84/84 passed, sharedmodule `tsc` passed, `verify:servertool-rust-only` passed, `verify:function-map-compile-gate` passed, `verify:architecture-mainline-call-map` passed, `git diff --check` passed.
- Reusable rule: if Rust/native wrapper validates a payload shape, type the wrapper output to the consumer contract and remove call-site casts instead of adding TS guard logic.

# 2026-07-02: servertool response-stage context cast removed
- Verified slice: `execution-stage-shell.ts` no longer casts response-stage context with `as ServerToolHandlerContext`; response-stage finalize and auto-hook pass now accept `Omit<ServerToolHandlerContext, 'toolCall'>`.
- Verification: focused Jest 64/64 passed, sharedmodule `tsc` passed, `verify:servertool-rust-only` passed, `verify:function-map-compile-gate` passed, `verify:architecture-mainline-call-map` passed, `git diff --check` passed.
- Reusable rule: response-stage shells should type their context to the actual context-base shape instead of widening to handler context with a fake `toolCall` slot.

# 2026-07-02: servertool execution queue dispatch mismatch fallback removed
- Verified slice: `execution-queue-shell.ts` no longer fabricates `nativeExecutionMode: ''` for dispatch mismatch errors; once Rust returns the mismatch action after `hasHandlerEntry=true`, TS passes `entry.registration.executionMode` directly.
- Verification: focused Jest 54/54 passed, sharedmodule `tsc` passed, `verify:servertool-rust-only` passed, `verify:function-map-compile-gate` passed, `verify:architecture-mainline-call-map` passed, `git diff --check` passed.
- Reusable rule: dispatch error payloads must not be padded in TS after Rust has selected a branch; missing required native fields should surface as contract failure rather than empty-string fallback.

# 2026-07-02: servertool auto-hook planned any cast removed
- Verified slice: `auto-hook-caller.ts` no longer casts `planned as any`; `execution-handler-materialization-shell.ts` now accepts `planned: unknown` and forwards the value to the Rust-owned materialization planner.
- Verification: focused Jest 65/65 passed, sharedmodule `tsc` passed, `verify:servertool-rust-only` passed, `verify:function-map-compile-gate` passed, `verify:architecture-mainline-call-map` passed, `git diff --check` passed.
- Reusable rule: when a TS shell only forwards a planned materialization input into native ownership, keep the shell narrow and forbid cast-based trust expansion at the call site.

# 2026-07-03: routecodex and rcc release artifacts must be synchronized

- Verified root cause: 5555 runtime consumed global `routecodex`, not global `rcc`; installing only `rcc-0.90.3533.tgz` left `routecodex@0.90.3533` on an older buildTime and allowed the same-version/stale-build split to survive.
- Fix rule: release closeout must pack, normal-install verify, globally install, and identity-check both `routecodex-<version>.tgz` and `rcc-<version>.tgz`. Compare package root, symlink status, `dist/build-info.js`, bundled `rcc-llmswitch-core`, and command resolution for both CLIs before live validation.
- Verification evidence: dual tarballs built with identical buildTime `2026-07-03T12:14:43.025Z`; `verify:rcc-release-install` passed normal npm global install checks for both; real global installs passed; 5555 restart and live `/v1/responses` first turn plus `submit_tool_outputs` continuation returned HTTP 200 with no new `RESPONSES_STORE_MISSING_REQUEST_CONTEXT` / `record.missing_request_context` after markers.

# 2026-07-03: LM Studio `/v1/responses` direct path stays Responses direct
- Verified runtime truth: `~/.rcc/provider/lmstudio/config.v2.toml` uses `[provider] type = "responses"` with `defaultModel = "ornith-1.0-397b"`; LM Studio must not be fixed by converting `/v1/responses` to chat.
- Verified 4444 route truth on installed `0.90.3533`: exact old failure sample `openai-responses-router-gpt-5.5-20260703T143914593-454787-1184` dry-run selected `lmstudio.key1.ornith-1.0-397b`, `providerProtocol=openai-responses`, `compatibilityProfile=responses:lmstudio`, and `wouldReturnProviderNotAvailable=false`.
- Verified live replay: same sample with `Accept: text/event-stream` returned HTTP 200, one `response.completed`, no `event:error`, `created.model=ornith-1.0-397b`, and `created.text.format.type=text`; server log request `openai-responses-router-gpt-5.5-20260703T164325715-455233-1630` hit `thinking/gateway-glm-4444-priority-thinking -> lmstudio[key1].ornith-1.0-397b`.
- Durable rule: LM Studio-specific Responses wire compatibility belongs in Rust req_outbound/provider outbound compat (`responses:lmstudio`), while VR only selects the target and direct remains passthrough plus hooks.

# 2026-07-03: rcc release install must pass normal npm global install
- Verified root cause: `esbuild` was a production dependency without runtime imports; release packing bundled it, and normal npm global install failed in bundled `esbuild` postinstall with missing `bin/esbuild`.
- Fix rule: build-time packages such as `esbuild` must stay in `devDependencies`; `rcc` release tarball bundles only true production dependencies and must include `rcc-llmswitch-core` as a real package tree, not a symlink or repo path.
- Gate: `scripts/verify-rcc-release-install.mjs` checks the tarball has no `esbuild`, all production dependencies are bundled, no repo path leaks, and a normal `npm install -g <tgz> --prefix <tmp>` can run `rcc --version`.
- Verification evidence: packed `rcc-0.90.3533.tgz` has 26 dependencies and 26 bundled dependencies, no `esbuild`; temporary-prefix and real global `npm install -g artifacts/pack/rcc-0.90.3533.tgz` passed, installed `rcc-llmswitch-core/dist` exists, and installed package is not repo-linked.

# 2026-07-03: `/v1/responses` tool-call transcript leaks are client projection bugs
- Verified root cause: Codex-visible text `Assistant requested tool calls: ... name=exec_command arguments=...` came from RouteCodex client-visible `/v1/responses` output text, confirmed in Codex session JSONL and `~/.rcc/codex-samples/openai-responses/ports/5555/.../client-response.json`.
- Fix rule: do not treat a green `governResponseJson`/display-sanitize test as closure for `/v1/responses` leaks. The live owner is `hub.response_responses_client_projection`; sanitize only client-visible text fields in Responses client payload/SSE projection and never rewrite structured `function_call.arguments`.
- Verification evidence: focused Rust leak tests passed 3/3; `verify:hub-response-responses-chat-projection`, native hotpath build, sharedmodule `tsc`, function-map gate, `build:min`, and `pack:rcc` passed; synchronized global `routecodex/rcc@0.90.3536` installed; live 5555 replay `routecodex-tool-leak-live-20260703T210111` returned `response.completed` and `LEAK_PRESENT=0`.

# 2026-07-04: stopless `simple_question` schema contract
- Verified contract: canonical stop schema key is `simple_question` only. `simple_question=true` allows natural terminal stop without `stopreason`, evidence, or `next_step`; it takes priority over other schema fields. `simple_question=false` or an absent key still requires the normal stop schema contract, starting with `stopreason`.
- Owner truth remains `hub.servertool_stopless_cli_continuation`; schema gate, CLI contract, visible-text stripping, bridge runtime, docs, function map, and verification map were updated under the Rust-owned stopless/servertool path.
- Verification evidence: focused Rust/Jest stopless gates passed for `simple_question`; native hotpath build passed; sharedmodule `tsc`, `build-core`, `build:min`, `pack:rcc`, `verify:rcc-release-install`, and real global install of `routecodex/rcc@0.90.3549` passed.
- Live gap: 5555 `/health` still reported `0.90.3542`; `routecodex restart --port 5555`, `routecodex restart --port 5520`, and `routecodex restart --port 5520 --host 127.0.0.1` could not discover the managed server even though `routecodex port status 5555 --json` mapped 5555 to `serverId=127.0.0.1:5520`. Do not claim live stopless `simple_question` closure until managed restart discovery is fixed and a same-entry `/v1/responses` probe runs on `0.90.3549`.

# 2026-07-04: VR imported persisted cooldown must not own startup route truth
- Superseded on 2026-07-07: imported persisted provider cooldown must not be read for cleanup/compatibility. Provider cooldown is process-local only; `provider-health.json` / `providerCooldowns` are red-test fixtures only and must not affect startup route truth.
- Owner: Rust Virtual Router only, under `vr.provider_forwarder_runtime` / `vr.route_availability_floor` in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine`.
- Evidence: red/green `forwarder_ignores_unselected_persisted_reprobe_target_under_simple_model`, new health unit `clear_imported_persisted_state_removes_startup_cooldown_truth`, `verify:vr-forwarder-runtime`, `verify:vr-no-ts-runtime`, `verify:vr-route-availability-default-floor`, `verify:llmswitch-rustification-audit`, function-map and mainline-call-map gates passed. Build/live closure was not claimed because unrelated dirty servertool wrapper/export TS errors blocked `build:min`.

# 2026-07-04: build/pack must not mutate global rcc and servertool wrapper exports are gated
- Verified rule: dev/build/pack paths must never run global install/uninstall or delete the already installed `rcc`; global install remains explicit. `build:dev:full` no longer calls `install:global`, and `verify-function-map-build-wiring` rejects build/pack scripts containing global install/uninstall plus install scripts that delete/uninstall global `rcc`.
- Release gate: `verify-rcc-release-install` installs both `routecodex` and `rcc` tarballs into temporary `--prefix` roots, imports installed llmswitch/native modules from both bundled locations, checks `sharedmodule/llmswitch-core/dist`, checks bundled `rcc-llmswitch-core/dist`, and confirms no `esbuild` production bundle.
- Export gate: `verify:servertool-rust-only` now AST-audits `sharedmodule/llmswitch-core/types/servertool-wrapper.d.ts` against active `rcc-llmswitch-core/native/servertool-wrapper` imports/re-exports. Unused package-shim declarations were removed; current verified function declaration count is 74.
- Related runtime fixes: router-direct retry preserves `runtime_control.providerProtocol` while releasing only single-use provider pins; MetadataCenter Rust mirror is rebound across cloned metadata; managed PID trust includes release `dist/cli.js` and global `node_modules/rcc/dist/{index,cli}.js`.
- Evidence: sharedmodule/root `tsc` passed; `verify:function-map-compile-gate` passed; `verify:servertool-rust-only` passed; focused CLI/direct/providerProtocol Jest passed; `pack:rcc` passed; `verify:rcc-release-install` passed for `routecodex-0.90.3553.tgz` and `rcc-0.90.3553.tgz` using temporary prefixes. No real global install or live replay was claimed in this slice.

# 2026-07-04: release install health gate must verify live runtime version

- Verified false-green mode: `install:release` can restart a managed port and pass readiness while the live server is still an older runtime version. CLI/shim `--version` is not enough; `/health.version` must equal the package version being installed.
- Durable gate: release install closeout must check `/health.status`, `ready`, `pipelineReady`, and exact `version`. If ready health reports a different version, expose/adopt through the single-port managed release path and verify again; do not claim runtime closeout from readiness alone.
- Verified P0-1 live replay pattern: `scripts/tests/stopless-5555-live-probe.mjs` is a valid servertool followup lifecycle smoke when it shows first-turn `requires_action`, one or more `submit_tool_outputs` continuations, final `completed`, and no stop schema leakage.

# 2026-07-04: stopless sessionId guard and consecutive counter contract

- Verified stopless rule: response-side stopless requires current request-truth `sessionId`; missing/blank sessionId must pass through naturally, emit `stopless_missing_session_id`, project no CLI, and write no stopless runtime state.
- Verified counter rule: `repeatCount` is same-session consecutive missing/invalid schema budget only. Non-stop progress/tool calls reset it, terminal schema and `simple_question=true` clear it, and a different session starts from `repeatCount=1` instead of inheriting stale state.
- Evidence: `cargo test -p router-hotpath-napi stopless_ --lib -- --nocapture`, `cargo test -p servertool-core stopless|cli_contract|persisted_lookup --lib -- --nocapture`, `cargo test -p stop-message-core --test stop_schema_gate_closure -- --nocapture`, native hotpath build, focused stopless Jest, `verify:stopless-invalid-schema-blackbox`, `verify:servertool-rust-only`, `verify:function-map-compile-gate`, and `verify:architecture-review-surface-light` passed.
- Closure gap: root `tsc` / `build:base` and live replay were not claimed for this stopless slice because unrelated dirty `src/modules/llmswitch/bridge/native-exports.ts` duplicate exports block root typecheck.

# 2026-07-04: review commits closed local code gates, not live runtime adoption

- Review commit evidence: `35549f6a0` committed MetadataCenter stopless `sessionId` projection after `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` passed 10/10; `5c2fafeff` committed Responses store latest stopless guidance collapse after Rust `shared_responses_conversation_utils` passed 48/48, native hotpath build passed, `responses-continuation-store.spec.ts` passed 39/39, and stage residue audit passed 153/153.
- Review commit evidence: `51234d9ed` committed stopless/servertool Rust governance after `verify:servertool-rust-only` passed, Rust `stopless_` passed 70/70, focused stopless/provider-response/req-process Jest passed 50/50, and `servertool-bridge-equivalence.spec.ts` passed 2/2.
- Current boundary: these commits prove local code/gate closure for the reviewed slices. Runtime release closeout is still not claimed until live `/health.version` matches the source/package version and same-entry live replay is rerun on that installed runtime.

# 2026-07-04: provider directory name is config providerId truth

- Verified 5520 `Provider runtime XL.key1 not found` was a `~/.rcc` config identity issue, not a runtime resolver code issue. The provider loader rejects `config.v2.toml` when provider directory name and `providerId` differ, and VR/runtime health canonicalize provider identity into the provider key family used at runtime.
- Correct fix pattern for case-mismatched provider identity: rename the provider directory and update `config.v2.toml` `providerId` / `[provider].id` plus every root forwarder `providerId` target to the same canonical value; do not add resolver fallback/compatibility probing.
- Evidence: `provider/XL` was renamed to `provider/xl`; root XL targets became `providerId="xl"`; `routecodex config validate`, `rcc restart --port 5520`, live `/health`, and `routecodex port dry-run 5520` passed. A temporary priority live probe hit `xl[key1].gpt-5.4`, reached provider send, got upstream quota/reroute instead of `ERR_PROVIDER_NOT_FOUND`, then priority was restored.

# 2026-07-05: runtime key compatibility probing removed

- Runtime key resolution now only accepts exact `providerKey -> runtimeKey` map entries, exact runtime handles, and the VR-provided `runtimeKey` hint. It no longer normalizes `key1 <-> 1`, creates alias-scoped handle aliases, recursively drops model suffixes, or scans runtime handles by prefix/model suffix.
- This closes the config-drift masking path exposed by the 5520 `Provider runtime XL.key1 not found` incident: provider identity mismatches must be fixed in `~/.rcc` config, not hidden in resolver compatibility.
- Evidence: focused provider binding/runtime resolver/runtime manager Jest passed 5/5; root `tsc` passed; `verify:architecture-fallback-denylist`, `verify:function-map-compile-gate`, `git diff --check`, and `routecodex config validate` passed.

# 2026-07-05: Hub Rustification release/live closeout evidence

- Release install build ordering truth: isolated release snapshots exclude `sharedmodule/llmswitch-core/dist`, so `install:release` must generate core dist inside the isolated build root before `build:min` runs gates that require `dist/native/servertool-wrapper.js` and `.d.ts`.
- Direct Responses continuation truth: direct same-protocol tool-call responses must capture the current entry `/v1/responses` request context before recording the direct response. This capture is data-plane store truth (`input/tools` for the same requestId), not provider payload mutation, MetadataCenter control state, or Hub response conversion.
- Verified state for Hub Rustification closeout on `0.90.3570`: `servertool.hook_skeleton.mainline` and `responses.continuation.mainline` both report `partial=0 pending=0`; `verify:llmswitch-rustification-audit`, `verify:servertool-rust-only`, Responses continuation gates, architecture/function-map/wiki gates, full `router-hotpath-napi --lib` cargo tests, release install, strict live `/health.version`, and live stopless first-turn `requires_action` -> submit `completed` replay all passed.
- Reporting boundary: global `error.mainline` and `vr.route_availability` still have non-Hub-adjacent partial edges, so Rustification completion claims must scope them out explicitly instead of calling the whole architecture graph fully closed.

# 2026-07-05: runtime lifecycle L2 gate matrix is machine-gated

- Durable loop truth: `docs/loops/runtime-lifecycle/gate-matrix.md` is the L2 approval matrix for `runtime-lifecycle-release-watch`; L2 remains disabled by default in `STATE.md`.
- Matrix rows: `release_install_sync`, `runtime_lifecycle`, `verification_gate_mapping`, and `worker_collision`. Each row must define owner/mainline, whitebox, blackbox, quality, evidence, and escalation conditions before a loop action is approved.
- Gate: `npm run verify:runtime-lifecycle-loop-gate-matrix` checks the matrix rows, run-log required fields, linked loop docs, package script wiring, and JSONL parseability. It is wired into `verify:architecture-ci-longtail`.
- Current aggregate caveat: `verify:architecture-ci-longtail` is blocked before reaching this new gate by existing `verify:architecture-deleted-path` failures for removed servertool orchestration paths, so the matrix gate should be run directly until that separate map cleanup is closed.

# 2026-07-05: `x-stainless-timeout` seconds fix stopped 5520 self-retry loop

- Root cause: server transport `trackClientConnectionState` parsed `x-stainless-timeout` as milliseconds. Codex sends `x-stainless-timeout: 900`, so RouteCodex marked the client disconnected after about 1.15s and closed `/v1/responses` before stream start, causing the client to retry with growing history every ~2s.
- Owner: `src/server/utils/client-connection-state.ts` under server HTTP transport connection-state parsing. This is not a Virtual Router, Hub Pipeline, Responses continuation, SSE projection, or provider runtime bug.
- Fix: `x-stainless-timeout` is now converted from seconds to milliseconds; `x-request-timeout-ms` remains the explicit millisecond test/override header.
- Evidence: red/green `tests/server/http-server/executor-metadata.spec.ts -t "client connection timeout hint"` proves `x-stainless-timeout: 1` is not disconnected at ~320ms and disconnects after ~1.3s; SSE timeout/prestart close focused tests pass; `build:base`, release snapshot install, `pack:rcc`, `verify:rcc-release-install`, and real global npm install for `routecodex/rcc@0.90.3573` passed; `/Users/fanzhang/.local/bin/rcc`, `/opt/homebrew/bin/rcc`, bare `rcc`, `routecodex`, and live `/health` on 4444/5520/5555/10000 all report `0.90.3573`; installed global import from `/opt/homebrew/lib/node_modules/rcc/dist/server/utils/client-connection-state.js` returns `{early:false,late:true}` for the same timeout check.
- Live replay evidence: post-install 5520 log after request `openai-responses-router-gpt-5.4-20260705T110541731-462969-4740` has no new `response.sse.client_close` / `detectedBeforeStreamStart`; requests complete in multi-second windows (`11187ms`, `70393ms`, `5563ms`, etc.) instead of the previous 160ms/2s rawInputItems growth loop.
- Gate caveat: full `verify:architecture-ci` is still blocked by existing forbidden-path debt unrelated to this timeout diff; do not count that aggregate gate as closed for this slice.

# 2026-07-05: conversion.shared.anthropic is Rust-owned with TS native shells only

- `conversion.shared.anthropic` owner truth is `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`; TS `anthropic-message-utils.ts`, `anthropic-message-utils-core.ts`, and `anthropic-message-utils-tool-schema.ts` are native shells/re-export surfaces only.
- Anthropic tool schema sanitize, tool name/action normalization, text/tool-result normalization, image block validation/order, and OpenAI function `tool_choice` mapping must stay in Rust; TS resurrection is blocked by `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`.
- Verified closeout evidence for this slice: Rust `anthropic_openai_codec` and `hub_protocol_spec_semantics` tests, focused Anthropic Jest, `verify:hub-response-anthropic-native`, sharedmodule tsc, function-map/mainline gates, `verify:llmswitch-rustification-audit` (`57` files / `8481` LOC), native build, and `build:base` passed. Live Anthropic replay remains unclaimed because codex Anthropic samples were absent.

# 2026-07-05: responses-sse-transport-flush-20260705

- `/v1/responses` SSE disconnect hardening belongs to the transport owner only: flush already-finalized SSE bytes after `res.write()` when `res.flush()` exists. Do not tighten timeout to mask buffering and do not add non-Responses protocol events.
- Keepalive remains an SSE comment (`: keepalive\n\n`). Synthetic `event: ping` or `{"type":"ping"}` is forbidden for this path because it adds non-transport semantics to the client-visible protocol stream.
- Verified release state for this slice: global `rcc`/`routecodex` and snapshot install `0.90.3576` contain `flush.call(res)` in `dist/server/handlers/handler-response-sse.js`; live 5520 `/v1/responses` smoke marker `RCC_SSE_FLUSH_3576_OK_1783227434` returned HTTP 200, `response.completed`, and `[DONE]`.
- Boundary caveat: exact historical long-running disconnect sample was not replayed; current claim is transport flush installed and same-entry live smoke, not full reproduction closure for every upstream long stream.

# 2026-07-05: P0 architecture remediation and config materialization boundary

- Marker: p0 architecture provider materialization blackbox 20260705.
- Verified P0 architecture closeout: map/anchor drift for `config.virtual_router_builder` / `config.virtual_router_types`, the duplicate TS `ErrorErr05*` DTO mirror, and the `error.mainline` partial edge were closed. `error.mainline` now includes explicit `ErrorErr04RouterPolicyApplied` before `ErrorErr05ExecutionDecision`.
- Historical correction: Provider v2 file loading stays TS IO, but routing-policy-group flattening, provider-port inclusion, forwarder target providerId/providerKey expansion, and `applyPatch` config normalization are now Rust runtime manifest materialization responsibilities in `compileRouteCodexRuntimeConfigManifest()`. Do not restore `buildVirtualRouterInputV2()` as a TS materialization owner.
- Failure signature: if `verify:provider-failure-ban-blackbox` or startup reports `Virtual Router requires at least one provider in configuration`, inspect the Rust `RouteCodexRuntimeManifest.virtualRouterBootstrapInput.providers` produced by `compileRouteCodexRuntimeConfigManifest()` before changing VR selection/runtime policy.
- Build rule: `verify:provider-failure-ban-blackbox` reads `dist`; after config/runtime source edits, run `npm run build:base` before the blackbox or the harness may execute stale runtime code.
- Verification evidence for this closeout passed: config Jest, root `tsc`, `verify:function-map-compile-gate`, `build:base`, `verify:provider-failure-ban-blackbox`, mainline manifest/wiki sync gates, `verify:error-pipeline-contract`, `verify:architecture-duplicate-dto-patterns`, `verify:vr-route-availability-default-floor`, focused executor retry Jest, and `git diff --check`.
- Boundary: no live managed install/restart or real upstream replay was claimed for this P0 slice; the provider failure proof is local blackbox coverage with mock upstreams.

# 2026-07-05: Responses store scope-match selection is Rust-owned

- `conversion.responses.store` scope continuation selection is now owned by Rust `planResponsesScopeContinuationMatchJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may build requested scope keys, read `scopeIndex`, project minimal candidates, and execute restore/materialize IO; it must not re-own allow-continuation filtering, direct-vs-relay exclusion, dedupe, mixed-owner ambiguity, no-match, or multi-match ambiguity.
- Verified evidence: Rust `scope_match` test, sharedmodule TypeScript check, native hotpath build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` 59/59, `verify:llmswitch-rustification-audit`, function-map gate, mainline binding/call-map gates, and touched-file `git diff --check` passed.

# 2026-07-12: Responses store script regressions use isolated direct-native state

- Script-level Responses store regressions must call `scripts/helpers/llmswitch-direct-native.mjs` and set an isolated temp `ROUTECODEX_RESPONSES_CONVERSATION_STORE`; they must not manually load broad native candidates or read live `~/.rcc/state/responses-conversation-store.json`.
- Verified trigger: `responses-store-orphan-tool-result.mjs` reading the live store path made `build:base` appear stuck after Rust responses-history tests. Moving it to the direct-native helper with a temp store made `node sharedmodule/llmswitch-core/tests/responses-store-orphan-tool-result.mjs`, `npm run verify:responses-history-protocol-contract`, and `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base` exit 0.

# 2026-07-05: Responses submit resume entry selection is Rust-owned

- `resumeConversation()` entry selection for Responses submit_tool_outputs now uses Rust `planResponsesConversationResumeEntryMatchJson`.
- TS store may project response-index/request-map/scope candidates and execute selected IO; it must not own responseIndex precedence, requestMap recovery ambiguity, submit-payload scope fallback matching, port scope matching, entry-kind/owner isolation, or allow-continuation expiry for submit resume.
- Verified evidence: Rust `resume_entry_match` test, sharedmodule TypeScript check, native hotpath build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` 60/60, `verify:llmswitch-rustification-audit`, function-map gate, mainline binding/call-map gates, and touched-file `git diff --check` passed.

# 2026-07-05: Responses lookup-by-response projection gate is Rust-owned

- `lookupContinuationByResponseId()` now uses Rust `planResponsesContinuationLookupByResponseIdJson` for responseId lookup validation and projection.
- TS store may read `responseIndex`, pass entry/options/requested port scope to native, and return the native projection; it must not own lastResponseId existence, responseId match, port scope, entry-kind, continuation-owner, providerKey, or requestId projection semantics for this lookup path.
- Verified evidence: Rust `continuation_lookup_plan` test, sharedmodule TypeScript check, native hotpath build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` 61/61, `verify:llmswitch-rustification-audit`, function-map gate, mainline binding/call-map gates, and touched-file `git diff --check` passed.

# 2026-07-05: Responses persistence eligibility is Rust-owned

- `conversion.responses.store` persistence load/flush eligibility is now owned by Rust `shared_responses_conversation_utils.rs` through `planResponsesConversationPersistenceEligibilityJson`.
- TS `responses-conversation-store.ts` may serialize/deserialize the persistence file and read/write Maps, but must not decide missing-response, direct-owner, `allowContinuation`, load TTL, or persisted `lastResponseId` eligibility. Add/modify Rust plan tests for those rules instead of restoring TS filters.
- Verified evidence: Rust `persistence_eligibility` test, sharedmodule TypeScript check, native hotpath build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` 62/62, rustification audit, function-map gate, and mainline binding/call-map gates passed on 2026-07-05. No live managed install/restart or upstream replay was claimed for this code/gate slice.

# 2026-07-05: Responses isolation helper facade is deleted

- The old `responsesConversationEntryMatchesIsolationJson` / `entryMatchesIsolation` surface has been physically removed after scope-match, submit-resume, and lookup native plans took over entry-kind, continuation-owner, and port-scope isolation.
- Do not reintroduce a generic TS-callable isolation helper in `responses-conversation-store-native.ts`; new isolation decisions must be returned by a concrete Rust action plan for the specific store operation.
- Verified evidence: repository search for the old isolation symbols returned 0 matches; native hotpath and llmswitch-core checked outputs were rebuilt; focused store/residue Jest, responses history protocol contract, rustification audit, function-map gate, mainline call-map gate, and touched-file diff check passed on 2026-07-05.

# 2026-07-05: Responses capture pending cleanup is Rust-owned

- `conversion.responses.store` `captureRequestContext()` pending same-scope cleanup now uses Rust `planResponsesCapturePendingCleanupJson`.
- TS store may project request-map candidates and detach native-selected request ids, but must not decide unresolved-only cleanup, same-request exclusion, requested-scope missing behavior, scope overlap, or duplicate cleanup ids.
- Verified evidence: Rust `capture_pending_cleanup` test, native hotpath rebuild, llmswitch-core checked output build, sharedmodule tsc, focused store/residue Jest, `verify:responses-history-protocol-contract` 63/63, rustification audit, function-map gate, mainline call-map gate, and touched-file diff check passed on 2026-07-05. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: responses-direct-data-only-event-prefix-20260705

- Direct `/v1/responses` provider passthrough may receive upstream SSE blocks that contain only `data: {"type":"response.*",...}` without an `event:` line. Codex tool parsing needs the named SSE event even when the JSON payload is otherwise intact.
- The allowed fix point is `src/providers/core/runtime/responses-provider.ts` direct provider wire normalization: prefix `event: <payload.type>` for data-only JSON blocks whose `type` starts with `response.`. Preserve the original `data:` payload and frame boundaries. Do not synthesize `request_id`, terminal events, `[DONE]`, `required_action`, continuation, stopless/servertool state, or tool history.
- `handler-response-sse.ts` remains transport-only. If a future SSE sample has tool JSON present but no named event, fix direct/provider projection owner, not the server handler or continuation store.
- Verified release: packed and globally installed `routecodex`/`rcc 0.90.3581`; live `/health.version` on 4444/5520/5555/10000 matched `0.90.3581`; live 5520 sample `req_1783235429497_960485c5` contained named `response.*` events plus `apply_patch` / `function_call`; recent post-restart logs had no new `Responses SSE event sequence missing request_id`.

# 2026-07-05: forbidden-path owner names require helper projections

- Marker: forbidden path runtime carrier helper boundary 20260705.
- Verified rule: `verify:architecture-forbidden-path-growth` treats canonical owner names as hard module-boundary signals. Do not fix forbidden-path hits by widening allowlists when provider/runtime/executor code mentions owner names such as `MetadataCenter`, `ResponsesSseEvent`, or `ContinuationLookupResult`.
- MetadataCenter boundary: code outside `src/server/runtime/http-server/metadata-center/` must use helper/projection APIs in `request-truth-readers.ts` for runtime carrier, request truth, continuation, runtime control, and provider observation reads/writes. Provider/runtime/executor files must not import or directly name `MetadataCenter`.
- Naming ownership: Rust/direct SSE owner wording such as `ResponsesSseEvent` must stay in the canonical owner layer; direct provider wire helpers should use local descriptive names. TS Responses store lookup shapes must avoid canonical continuation owner DTO names such as `ContinuationLookupResult`; use store-local projection names instead.
- ErrorErr05 default-pool truth: default pool availability makes provider failure non-terminal. Executor consumers must recompute projection permission from the Rust decision plus local args and only project provider error to client when route pool is empty and `defaultPoolAvailable` is false.
- Verified gates for this boundary passed on 2026-07-05: forbidden-path growth, function-map compile, metadata-center write/dualwrite, responses history protocol, custom payload carrier gates, SSE architecture boundary, error pipeline contract, VR default floor, provider failure blackbox, build/base TypeScript checks, and focused ErrorErr05 Rust/Jest suites. No live managed install/restart was claimed for this slice.

# 2026-07-05: TS owner ban classification is map/gate truth, not automatic runtime migration

- Marker: ts owner ban map classification p1 20260705.
- `verify:architecture-ts-owner-ban` distinguishes forbidden TS semantic owners from allowed TS shells/glue. `server.runtime_key_resolution`, `hub.metadata_center_dualwrite_api`, `debug.unified_surface`, `debug.internal_error_numbering`, and `manager.health_runtime` are explicitly classified as TS transitional/host/debug/manager shells; their migration targets remain tracked, but the gate should not fail while they are the registered shell owner.
- `hub.chat_process_responses_continuation` is Rust-owned in `shared_responses_conversation_utils.rs`, not `src/modules/llmswitch/bridge`. Its function-map canonical builders must use Rust symbols, while TS bridge files remain IO/native facade allowed paths.
- `hub.response_post_servertool_client_projection` is a Rust scope feature spanning `hub_pipeline_lib/effect_plan.rs` and `hub_resp_outbound_client_semantics_blocks/responses_payload.rs`; mapping it to only one file creates false canonical-builder or anchor failures.
- Verified gates for this classification passed on 2026-07-05: `verify:architecture-ts-owner-ban`, `verify:architecture-feature-anchor-coverage`, `verify:function-map-canonical-builder-definitions`, `verify:architecture-mainline-call-map`, and full `verify:function-map-compile-gate`. No runtime/live adoption was claimed.

# 2026-07-05: Responses record-time cleanup and fallback scope entry match are Rust-owned

- `conversion.responses.store` `recordResponse()` same-scope completed-entry cleanup is owned by Rust `planResponsesRecordScopeCleanupJson` in `shared_responses_conversation_utils.rs`.
- `conversion.responses.store` missing-request fallback scope entry selection inside `recordResponse()` is owned by Rust `planResponsesRecordScopeEntryMatchJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may only build requested scope keys, project `scopeIndex` / `requestMap` candidates, and execute native `detachRequestIds` / selected `scopeKey`; it must not regain completed-vs-pending cleanup rules, self exclusion, dedupe, or fallback scope-order selection policy.
- Verified evidence on 2026-07-05: Rust `record_scope_cleanup` and `record_scope_entry` tests, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 65/65, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8334`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses store lifecycle sweep is Rust-owned

- `conversion.responses.store` detach decisions for `clearUnresolvedRequests()` and `prune()` are owned by Rust `planResponsesStoreSweepJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may project `requestMap` candidates and execute native-selected `detachRequestIds`, but it must not regain unresolved-only cleanup, TTL expiry cleanup, invalid-mode fallback, or dedupe rules for lifecycle sweep.
- Verified evidence on 2026-07-05: Rust `store_sweep` test, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 66/66, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8351`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Rustification L1 evidence is source/doc-only

- Rustification L1 audits must not search or cite generated artifacts, local indexes, MemoryPalace output, or generated reports as current code-state evidence.
- Required discovery boundary: start from `git ls-files`, include only source/docs/tests/scripts/architecture/loop/goal/skill docs, and deny `dist/`, `target/`, `coverage/`, `node_modules/`, `.mempalace/`, `.local-index/`, `mempalace/`, generated HTML, backups, snapshots, and generated reports even if tracked.
- Current source/doc-only L1 evidence must distinguish script correctness from package-gate state. The audit discovery is source/doc-only and excludes generated/local paths; the latest package gate can still fail on real tracked source growth.
- 2026-07-06 enforcement update: `scripts/ci/llmswitch-rustification-audit.mjs` now uses `git ls-files -z` instead of recursive directory walking and applies the generated/local-index denylist before reading TS content. `tests/scripts/llmswitch-rustification-audit.spec.ts` proves tracked source TS counts, untracked source TS is ignored, and tracked generated/index artifacts are ignored.
- 2026-07-06 current dirty-worktree blocker: `npm run verify:llmswitch-rustification-audit` fails on real tracked source growth, not generated artifacts: `prodTsFileCount=165`, `prodTsLocTotal=29384`, `nonNativeFileCount=42`, `nonNativeLocTotal=5217`, error `nonNativeLoc increased in topDir=index.ts: baseline=14, current=15`. The triggering source line is `sharedmodule/llmswitch-core/src/index.ts` exporting `./native/router-hotpath/virtual-router-errors.js`; the target file is currently untracked source. Do not claim the package gate is green until that owning slice resolves or explicitly allows the source growth.
- 2026-07-06 later same-run current state: after the dirty worktree shifted the Virtual Router error barrel to native hotpath policy, `npm run verify:llmswitch-rustification-audit` passed again with `prodTsFileCount=165`, `prodTsLocTotal=29403`, `nonNativeFileCount=41`, `nonNativeLocTotal=5221`; the source-only audit fixture and llmswitch-core tsc also passed. This proves the L1 gate is green for the current worktree, not total rustification completion.
- 2026-07-06 deletion-aware update: the source-only audit now ignores tracked files that are deleted in the current working tree. This keeps L1 aligned with current source state during unstaged physical-delete slices and prevents ENOENT from `git ls-files` stale paths. The fixture test covers tracked source, untracked source, generated/local-index artifacts, and tracked-then-deleted source files. Current evidence after compat registry deletion: `verify:llmswitch-rustification-audit` PASS with `prodTsFileCount=160`, `prodTsLocTotal=28882`, `nonNativeFileCount=36`, `nonNativeLocTotal=4700`; compat profile registry TS parallel implementation residue test PASS.

# 2026-07-06: Compat profile registry TS parallel implementation is deleted

- `sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/{registry,types,header-policies,policy-overrides,provider-resolver}.ts` and their local tests are physically deleted from the current working tree.
- Source-only grep after excluding fixtures/samples/reports shows no active source consumers for `loadCompatProfileRegistry`, `applyHeaderPolicies`, `shouldSkipPolicy`, `detectProviderTypeFromConfig`, `resolveOutboundProfileFromConfig`, `resolveDefaultCompatibilityProfileFromConfig`, `CompatProfileRegistry`, `HeaderPolicyRule`, or `PolicyOverrideConfig`.
- Residue gate `compat profile registry TS parallel implementation must stay deleted` blocks those files and symbols from returning. This is code/gate closeout only; runtime/live closeout is not claimed.

# 2026-07-06: Responses conversation store preflight guards are Rust-owned

- `conversion.responses.store` capture/record/resume preflight decisions are owned by Rust `planResponsesConversationPreflightJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may execute Map/FS/global singleton/timer IO, non-blocking logging, and `ProviderProtocolError` projection, but it must not locally decide capture missing request/payload skip, record missing request/response id, or resume missing response id / missing `tool_outputs`.
- Verified on 2026-07-06: Rust focused `conversation_preflight_plan_owns_store_entry_guards` passed; `cargo fmt --check`, native hotpath build, llmswitch-core build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` 74/74, required native export subtest, `verify:llmswitch-rustification-audit` (`prodTsFileCount=160`, `prodTsLocTotal=29008`, `nonNativeFileCount=36`, `nonNativeLocTotal=4753`), function-map gate, mainline call-map gate, and touched-file diff check passed. No managed live restart/replay was claimed.

# 2026-07-05: Responses release request payload is Rust-owned

- `conversion.responses.store` `releaseRequestPayload()` semantics are owned by Rust `planResponsesReleaseRequestPayloadJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may execute store IO after the native plan, but it must not regain stored-context media stripping, `previous_response_id` projection, pending tool-call id extraction, or entry input clearing semantics.
- Verified evidence on 2026-07-05: Rust `release_request_payload` test, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 67/67, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8345`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses attach-scope collision policy is Rust-owned

- `conversion.responses.store` `attachEntryScopes()` scope collision policy is owned by Rust `planResponsesAttachEntryScopesJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may read `scopeIndex`, project candidate `{scopeKey, requestId}` rows, detach native-selected request ids, and write native-returned scope keys; it must not regain scope-key dedupe, same-entry exclusion, conflict detection, or detach selection.
- Verified evidence on 2026-07-05: Rust `attach_entry_scopes` test, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 68/68, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8354`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses continuation meta projection is Rust-owned

- `conversion.responses.store` continuation meta projection is owned by Rust `planResponsesContinuationMetaJson` / `plan_responses_continuation_meta` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may pass returned native resume/restore/materialize meta plus the selected entry into native and return native meta, but it must not locally decide providerKey, continuationOwner, or entryKind fill/override policy.
- Verified evidence on 2026-07-05: Rust `continuation_meta_plan` and `persisted_entry_plan` tests, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 72/72, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8286`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses persisted-entry shaping is Rust-owned

- `conversion.responses.store` persistence serialize/deserialize entry shaping is owned by Rust `planResponsesPersistedEntryJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may JSON-clone disk/Map values and perform file/Map IO, but must not decide persisted entry required fields, canonical field allowlist, entryKind defaults, continuationOwner validity, timestamp defaults, or string/record array cleanup.
- Verified evidence on 2026-07-05: Rust `persisted_entry_plan` tests 2/2, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 71/71, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8297`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses request-id rebind policy is Rust-owned

- `conversion.responses.store` `rebindRequestId()` provider-switch request id rebinding policy is owned by Rust `planResponsesRebindRequestIdJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may read `requestMap` existence and execute the native-selected rebind, but it must not decide missing old/new id, same id, missing old entry, new id conflict, or successful rebind policy.
- Verified evidence on 2026-07-05: Rust `rebind_request_id` test, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 197/197, `verify:responses-history-protocol-contract` 69/69, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=54`, `nonNativeLocTotal=8359`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses store token normalization is Rust-owned

- `conversion.responses.store` scope token, `entryKind`, and `continuationOwner` normalization is owned by Rust `planResponsesStoreTokensJson` in `shared_responses_conversation_utils.rs`.
- TS `responses-conversation-store.ts` may call `planStoreTokens()` and use returned tokens while reading/writing Maps, but must not locally trim scope tokens, default relay/direct entry kinds, or validate continuation owners.
- Verified evidence on 2026-07-05: Rust `store_tokens_plan` test, native hotpath rebuild, llmswitch-core build, focused responses store/residue Jest 198/198, `verify:responses-history-protocol-contract` 73/73, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Bridge policy action descriptor parsing is Rust-owned

- Phase 1-C `conversion.bridge.action_parsing` current residue was not the old deleted `native-hub-bridge-action-semantics-parsers.ts`; it was TS parsing of Rust-returned bridge policy/action descriptor JSON in `native-hub-bridge-policy-semantics.ts`.
- Bridge policy shape, phase selection, action descriptor `name/options`, and unknown policy/stage null projection are owned by Rust `hub_bridge_policies.rs`. TS native policy wrappers may invoke native capabilities and parse JSON through shared native fail-fast helpers, but must not reintroduce local `parseActionDescriptor()`, `parseActionDescriptors()`, `parsePhase()`, `parsePolicy()`, or local parse-failure sentinel/logger policy.
- Verified evidence on 2026-07-05: Rust `hub_bridge_policies` tests 4/4, native hotpath rebuild, llmswitch-core build, residue Jest 160/160 with bridge policy parser ban, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses response_outbound bridge pipeline must call native directly

- `conversion/responses/responses-openai-bridge/response-payload.ts` must not use `createBridgeActionState()` / `runBridgeActionPipeline()` or swallow bridge action pipeline errors for `response_outbound`.
- The allowed TS role is resolving policy actions, calling `runBridgeActionPipelineWithNative()`, and applying the native-returned message shape. Bridge action execution semantics and failure behavior belong to Rust `hub_bridge_actions` plus required native wrapper fail-fast behavior.
- Verified evidence on 2026-07-05: residue Jest 161/161 with the response payload native-pipeline ban, llmswitch-core build, native hotpath rebuild, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses request-side bridge action filtering is Rust-owned

- `conversion/responses/responses-openai-bridge.ts` request-side bridge action filtering is owned by Rust `planResponsesBridgePolicyActionsJson` / `plan_responses_bridge_policy_actions` in `hub_bridge_policies.rs`.
- TS may resolve the bridge policy, pass `stage/actions/messages` to `planResponsesBridgePolicyActionsWithNative()`, and execute `runBridgeActionPipelineWithNative()`, but it must not locally filter `reasoning.extract`, detect tool signals, or drop `tools.normalize-call-ids` / `tools.ensure-placeholders`.
- Verified evidence on 2026-07-05: Rust `responses_bridge_policy_action_plan` tests 2/2, native hotpath rebuild, llmswitch-core build, residue Jest 162/162 with the TS action-filter ban, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses response payload reasoning normalization must be native fail-fast

- `conversion/responses/responses-openai-bridge/response-payload.ts` must not use the shared TS wrapper `normalizeMessageReasoningTools()` or swallow reasoning normalization failures with best-effort `try/catch`.
- Allowed TS role: call `normalizeMessageReasoningToolsWithNative()` directly and apply the returned message object; assistant reasoning/tool-call extraction and normalized message shaping stay owned by Rust `normalizeMessageReasoningToolsJson`.
- Verified evidence on 2026-07-05: llmswitch-core build, focused residue + reasoning-normalizer Jest 164/164, native hotpath rebuild, `verify:llmswitch-rustification-audit` (`nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Dead bridge policy/action TS wrapper files are deleted

- `sharedmodule/llmswitch-core/src/conversion/bridge-policies.ts` and `sharedmodule/llmswitch-core/src/conversion/bridge-actions.ts` are dead TS wrapper layers and must stay physically deleted after the live Responses bridge files move to direct native policy/action facades.
- `responses-openai-bridge.ts` and `responses-openai-bridge/response-payload.ts` may import native bridge policy helpers directly, but they must not reintroduce a separate TS bridge-policy/action wrapper layer in `src/conversion/`.
- Verified evidence on 2026-07-05: llmswitch-core build, residue Jest 165/165 with deletion/import bans, native hotpath rebuild, `verify:llmswitch-rustification-audit` (`prodTsFileCount=172`, `prodTsLocTotal=30840`, `nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Dead reasoning-tool-normalizer TS wrapper file is deleted

- `sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.ts` is deleted after zero production consumers remained. Tests should call native `normalizeMessageReasoningToolsWithNative()` directly and assert returned native message truth, not old TS wrapper in-place mutation.
- Reasoning tool normalization remains owned by Rust `normalizeMessageReasoningToolsJson`; do not reintroduce a shared TS wrapper for it under `conversion/shared/`.
- Verified evidence on 2026-07-05: llmswitch-core build, native hotpath rebuild, `verify:llmswitch-rustification-audit` (`prodTsFileCount=171`, `prodTsLocTotal=30793`, `nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, focused residue/red/native Jest 170/170, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Zero-consumer shared native wrappers are deleted

- `sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-response.ts`, `chat-output-normalizer.ts`, and `output-content-normalizer.ts` are deleted after repository search showed no production/test consumers.
- Do not keep zero-consumer TS native wrapper files merely because they are thin; if live callers need the capability, they should import the native facade directly or add a justified owner-specific shell.
- Verified evidence on 2026-07-05: llmswitch-core build, native hotpath rebuild, `verify:llmswitch-rustification-audit` (`prodTsFileCount=168`, `prodTsLocTotal=30736`, `nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, residue/red Jest 169/169, and touched-file `git diff --check` passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Zero-consumer native router facade files are deleted

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-semantic-mappers.ts` and `native-rcc-fence-semantics.ts` are deleted after repository search showed no production/test consumers outside checked dist, docs/audit baselines, and residue gates.
- Keep Rust/NAPI exports unless separately proven retired; this slice proved only the TS facade files were dead. `native-failure-policy.ts` is not a deletion candidate while bridge/native exports and provider/executor failure policy still consume it.
- Verified evidence on 2026-07-05: llmswitch-core build, native hotpath rebuild, focused residue/red Jest 169/169, `verify:llmswitch-rustification-audit` (`prodTsFileCount=166`, `prodTsLocTotal=30604`, `nonNativeFileCount=49`, `nonNativeLocTotal=7219`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses captured input sanitize is Rust-owned

- `conversion/responses/responses-openai-bridge/utils.ts::sanitizeCapturedResponsesInput` no longer owns function_call/function_call_output cleanup policy in TS. It calls Rust `sanitizeCapturedResponsesInputJson` via `sanitizeCapturedResponsesInputWithNative`.
- Rust `hub_bridge_actions` owns function_call name sanitization, accepted call id collection, invalid function_call drop, orphan `function_call_output` drop when captured function calls exist, and preserving outputs when no function calls were captured.
- Verified evidence on 2026-07-05: Rust focused test 2/2, llmswitch-core build, residue Jest 166/166, native hotpath build, `verify:llmswitch-rustification-audit` (`prodTsFileCount=166`, `prodTsLocTotal=30585`, `nonNativeFileCount=48`, `nonNativeLocTotal=6983`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Responses bridge utility policy is native-owned

- `conversion/responses/responses-openai-bridge/utils.ts` no longer owns request parameter allowlists, tool passthrough allowlists, slim bridge context selection, decision metadata selection, metadata extra-field extraction, tool-control field stripping, data unwrap, or retained request-parameter merge in TS.
- Those policies are delegated to Rust/native `hub_bridge_actions` surfaces: `pickResponsesRequestParametersWithNative`, `pickResponsesToolPassthroughFieldsWithNative`, `pickResponsesBridgeDecisionMetadataWithNative`, `extractResponsesMetadataExtraFieldsWithNative`, `buildSlimResponsesBridgeContextWithNative`, `stripResponsesToolControlFieldsWithNative`, `unwrapResponsesDataWithNative`, and `mergeRetainedResponsesRequestParametersWithNative`.
- `responses-openai-bridge.ts` must not reintroduce `RESPONSES_REQUEST_PARAMETER_KEYS`, `RESPONSES_TOOL_PASSTHROUGH_KEYS`, `pickObjectFields`, or retained-parameter loops; it may call the native-backed wrappers and execute returned plans.
- Verified evidence on 2026-07-05: Rust `hub_bridge_actions` tests 94/94, llmswitch-core build, residue Jest 166/166, native hotpath build, `verify:responses-history-protocol-contract` 73/73, `verify:llmswitch-rustification-audit` (`prodTsFileCount=166`, `prodTsLocTotal=30627`, `nonNativeFileCount=48`, `nonNativeLocTotal=7006`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: OpenAI chat request normalization is Rust-owned at full request level

- `conversion/shared/openai-message-normalize.ts::normalizeChatRequest()` no longer owns package-level message/tool traversal or tool-history validation in TS. It only reads the existing shell-coerce env switch and calls `normalizeOpenaiChatRequestWithNative()`.
- Rust `shared_openai_message_normalize.rs` owns `normalizeOpenaiChatRequestJson`, including request clone, message normalization, tool normalization, and final OpenAI chat tool-history validation.
- Residue gates must keep `openai-message-normalize.ts` from reintroducing `messages.map`, `tools.map`, `normalizeOpenaiMessageWithNative`, `normalizeOpenaiToolWithNative`, or `normalizeOpenaiChatMessagesWithNative` orchestration.
- Verified evidence on 2026-07-05: Rust `shared_openai_message_normalize` tests 12/12, native hotpath rebuild, llmswitch-core build, focused OpenAI normalize + residue Jest 170/170, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30625`, `nonNativeFileCount=47`, `nonNativeLocTotal=6999`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: rcc startup must not call deleted Virtual Router builder on materialized config

- Verified root cause: `loadRouteCodexConfig()` materializes v2 provider files into `userConfig.virtualrouter.providers`; server runtime bootstrap then re-read that materialized config and called the deleted `buildVirtualRouterInputFromUserConfig()` guard when `routingPolicyGroups` and `providers` were both present.
- Current rule: runtime bootstrap must route every `virtualrouter` config through `compileRouteCodexRuntimeConfigManifest()` and carry the same Rust manifest into HubPipeline setup. `buildVirtualRouterInputV2()` is retired from live config loader code; `src/config/virtual-router-types.ts` was later physically deleted after all callers were gone.
- Current rule: `compileRouteCodexRuntimeConfigManifest()` accepts already-materialized `virtualrouter.providers` as decoded provider config source; raw single-source v2 configs read provider files through `loadProviderConfigsV2()` before calling Rust.
- Verified evidence: red focused runtime provider-merge test reproduced the exact stale-guard error; after the fix, focused config/runtime/auth Jest 35/35, function-map gate, mainline call-map gate, `build:base`, `pack:rcc`, and `verify:rcc-release-install` passed. Real global install of synchronized `routecodex/rcc@0.90.3590` passed; live `/health` on 5520/4444/5555/10000 returned ready version `0.90.3590`; `/daemon/auth/status` returned `authRequired:false`, `authenticated:true`, `isRemote:false`; `/daemon/admin` returned HTTP 200.

# 2026-07-07: Config shadow compare and stale VR type guard are deleted

- `src/config/config-semantic-compare.ts` was physically deleted after JSON/v1/shadow runtime support removal; it had no production/test caller and only historical shadow docs referenced it.
- `src/config/virtual-router-types.ts` was physically deleted after all live callers moved to Rust `compileRouteCodexRuntimeConfigManifest()` and no import remained; do not keep fail-fast guard files without callers.
- `config.virtual_router_types` was removed from function/verification maps; current config materialization truth is `config.user_config_materialization` in Rust `runtime_config_materialization.rs`.
- Verification evidence on 2026-07-07: live source/test/architecture import grep had zero matches, root `tsc`, function-map gate, `verify:config-ssot`, minimal TS surface gate, rustification audit, and `git diff --check` passed. No managed live restart/replay was run because this was dead-code/config-surface deletion.

# 2026-07-05: Hub/VR/Chat Process rustification is not complete at the LOC threshold

- `verify:llmswitch-rustification-audit` reaching `47 files / 6999 LOC` is a Phase 2 numeric gate and L1 audit baseline only. It is not proof that Hub Pipeline / Virtual Router / Chat Process rustification is complete.
- Completion requires every remaining non-native TS file in scope to be classified with evidence as `rust_ssot`, `native_shell_ok`, or `ts_io_shell_ok`; any `ts_semantic_debt` keeps the total goal open.
- Server Rustification is required only where server code owns Hub/VR/Chat Process semantics. TS server HTTP/SSE/process code may remain only as IO shell, with no continuation/tool governance/payload repair/provider projection semantics.
- Future reports must say “threshold met” or “slice closed” rather than “rustification complete” until fresh L1 classification, all L2 semantic debts, closeout gates, and runtime replay evidence pass.

# 2026-07-05: Responses continuation input source selection is Rust-owned

- `responses-conversation-store-native.ts` must not choose restore/materialize continuation input from `entry.input` vs `entry.releasedInputPrefix`, and must not branch on `entry.continuationOwner === 'direct'` for that selection.
- TS restore/materialize facades may pass the complete entry snapshot to native and project returned `{ payload, meta }`; Rust `shared_responses_conversation_utils.rs::{restore_responses_continuation_payload, materialize_responses_continuation_payload}` owns live input vs released prefix, direct/relay behavior, pending tool output replay, and delta construction.
- Residue gate now forbids `useReleasedPrefixSideChannelOnly`, local `continuationInput`, direct-owner selection, and `Array.isArray(entry.input) ... releasedInputPrefix` patterns inside restore/materialize facade blocks.
- Verified evidence on 2026-07-05: llmswitch-core build, focused Responses store + residue Jest 207/207, native hotpath build, `verify:responses-history-protocol-contract` 73/73, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30610`, `nonNativeFileCount=47`, `nonNativeLocTotal=6999`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Response native parser facade is parse-only, not semantic validator

- `native-hub-pipeline-resp-semantics-parsers.ts` must not own response semantic validation or normalization. It may keep JSON parse, basic object/array/null contract, and type projection of Rust native output.
- The following belong to Rust response semantics owners, not TS parser facade: alias map key/value trim, token count flooring, SSE descriptor code/stage validation, Responses host policy target normalization, Responses SSE projection state validation, Anthropic stop reason normalization, provider tool summary filtering, and provider response context protocol/display/request id normalization.
- Residue gate `resp native parser facade must not own response semantic validation` blocks those TS patterns from returning.
- Verified evidence on 2026-07-05: llmswitch-core build, focused parser observability + residue Jest 179/179, native hotpath build, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30407`, `nonNativeFileCount=47`, `nonNativeLocTotal=6796`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Req outbound native parser facade is parse-only for compat output

- `native-hub-pipeline-req-outbound-semantics-parsers.ts` must not own req_outbound compat output semantic validation. It may parse JSON, enforce basic object/null parse contract, and type-project Rust native output.
- `parseReqOutboundCompatOutput()` must not locally validate/rebuild `payload`, trim/filter `appliedProfile`, or validate `nativeApplied`; those are Rust req_outbound compat owner semantics.
- The zero-runtime `parseBoolean()` parser surface is removed; parser observability uses live `parseJsonObject()`.
- Residue gate `req outbound native parser facade must not own compat output semantic validation` blocks these TS patterns from returning.
- Verified evidence on 2026-07-05: llmswitch-core build, focused parser observability + residue Jest 180/180, native hotpath build, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30377`, `nonNativeFileCount=47`, `nonNativeLocTotal=6766`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: Req inbound native parser facade is parse-only for tool-output snapshot result

- `native-hub-pipeline-req-inbound-semantics-parsers.ts` must not own tool-output snapshot result semantic validation. It may parse Rust native JSON as an object and type-project the returned result.
- `parseToolOutputSnapshotBuildResult()` must not locally validate/rebuild nested `snapshot` or `payload`; the `ToolOutputSnapshotBuildResult { snapshot, payload }` contract belongs to Rust `hub_req_inbound_tool_output_snapshot.rs`.
- Residue gate `req inbound native parser facade must not own tool output snapshot semantic validation` blocks local snapshot/payload object checks, array rejection, and local rebuild from returning.
- Verified evidence on 2026-07-05: llmswitch-core build, focused parser observability + residue Jest 181/181, native hotpath build, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30366`, `nonNativeFileCount=47`, `nonNativeLocTotal=6755`), `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, and touched-file diff check passed. No live managed install/restart or upstream replay was claimed.

# 2026-07-05: System tool guidance text is Rust-owned

- `guidance/index.ts::buildSystemToolGuidance()` must not locally construct the generic OpenAI tool_calls guidance text. It calls native `buildSystemToolGuidanceJson` and fail-fast parses the Rust string.
- Rust `req_outbound_stage3_compat.rs::build_system_tool_guidance_json()` owns the current generic system tool guidance text and must remain apply_patch-policy-free; apply_patch guidance/schema policy remains owned by dedicated Chat Process/apply_patch owners, not generic guidance.
- Residue gate `system tool guidance text must be native-owned` blocks local TS `const bullet`, `lines.push`, and `lines.join` reconstruction inside `buildSystemToolGuidance()`.
- Verified evidence on 2026-07-05: Rust focused test `system_tool_guidance_is_native_owned_and_apply_patch_free`, native hotpath build, llmswitch-core build, focused tool-guidance + residue Jest 178/178, required-export subtest, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=30270`, `nonNativeFileCount=45`, `nonNativeLocTotal=6137`), function-map gate, mainline gate, and touched-file diff check passed. Full required-export spec still has unrelated servertool/req_inbound assertion failures; full cargo fmt remains blocked by unrelated `exec_command_guard.rs` formatting. No live managed restart/replay was claimed.

# 2026-07-05: RouteCodex MemPalace artifact exclusion gate

- RouteCodex must not add root `mempalace.yaml`; root governance treats root MemPalace files as forbidden local/tool residue and `repo-sanity` rejects them.
- `mempalace mine .` from repo root does not read `.local-index/mempalace/mempalace.yaml`; it uses auto-detected defaults plus MemPalace built-in skips and `.gitignore`.
- `scripts/ci/mempalace-scan-artifact-audit.mjs` is the project gate for current scanner behavior. It imports MemPalace's own `scan_project(..., respect_gitignore=True)` and fails if any scanned file is under `dist`, `node_modules`, `target`, `coverage`, `build`, `.next`, `.turbo`, `.local-index`, or `.mempalace`.
- Verified on 2026-07-05: `npm run verify:mempalace-scan-artifacts` passed with `scannedFiles=7015 artifactHits=0`. This proves current scanning excludes build/local artifacts; it does not prove old `routecodex` wing drawers were purged.
- Historical `wing=routecodex` Chroma metadata was also audited on 2026-07-05: `26679` drawer rows, `975` distinct `source_file` values, and zero `source_file` hits for `dist`, `node_modules`, `target`, `coverage`, `build`, `.next`, `.turbo`, `.local-index`, and `.mempalace`. This proves the existing wing source metadata has no generated/local artifact paths, but not a full semantic vector-content purge.

# 2026-07-06: Tool guidance augmentation is Rust-owned

- `guidance/index.ts::augmentOpenAITools()` and `augmentAnthropicTools()` no longer own tool description/schema mutation. They fail-fast call native `augmentOpenAIToolsJson` / `augmentAnthropicToolsJson` and parse the returned array.
- Rust `req_outbound_stage3_compat.rs` owns OpenAI/Anthropic generic tool guidance augmentation for `shell`, `exec_command`, `update_plan`, `view_image`, and MCP resource tools. Generic guidance continues to leave `apply_patch` unchanged; apply_patch policy belongs to dedicated Chat Process/apply_patch owners, not generic guidance.
- Residue gate `system tool guidance text must be native-owned` now also bans local TS guidance markers, `appendOnce`, `ensureObjectSchema`, and local `.parameters` / `.input_schema` mutation inside the TS augment facades.
- Verified on 2026-07-06: Rust focused guidance tests passed, native hotpath build passed, llmswitch-core build passed, focused tool-guidance + residue Jest passed 179/179, required-export subtest passed, `coverage-guidance-augment.mjs` passed, `cargo fmt --check` passed, `verify:llmswitch-rustification-audit` passed with `prodTsLocTotal=29960` and `nonNativeFileCount=45/nonNativeLocTotal=6137`, function-map gate and mainline call-map gate passed. No live restart/replay was claimed.

# 2026-07-06: Tool args JSON artifact repair is Rust-owned

- `tools/args-json.ts::parseToolArgsJson()` no longer owns `<arg_key>/<arg_value>` JSON/key/value artifact repair. It is a fail-fast native facade over `parseToolArgsJsonWithArtifactRepairJson`.
- Rust `resp_process_stage1_tool_governance_blocks::json_args` owns lenient raw malformed JSON repair, recursive artifact key normalization, injected arg pair extraction, primitive coercion, and the invalid/non-string empty-object behavior used by tool registry callers.
- `tool-registry.ts` must call `validateApplyPatchArgumentsJson` with the native binding envelope `{ arguments: <source> }`; passing the raw value directly collapses valid apply_patch requests to `empty_patch`.
- Residue gate `tool args JSON artifact repair must be native-owned` blocks local TS arg artifact regex, XML tag stripping, primitive coercion, recursive repair, and parse-failure warning fallback from returning.
- Verified on 2026-07-06: Rust focused parser test passed, Rust `resp_process_stage1_tool_governance` passed 214/1 ignored, native hotpath build passed, llmswitch-core build passed, focused apply_patch tool-registry + residue Jest passed 183/183, required-export subtest passed, `cargo fmt --check` passed, `verify:llmswitch-rustification-audit` passed with `prodTsFileCount=165`, `prodTsLocTotal=29818`, `nonNativeFileCount=44`, `nonNativeLocTotal=5956`, function-map gate, mainline call-map gate, servertool rust-only gate, and touched-file diff check passed. No managed live restart/replay was claimed.

# 2026-07-06: Exec command argument normalization is Rust-owned

- `tools/exec-command/normalize.ts::normalizeExecCommandArgs()` no longer owns exec_command argument normalization. It is a fail-fast native facade over `normalizeExecCommandArgsJson`.
- Rust `resp_process_stage1_tool_governance_blocks::exec_command_args` owns compat-mode nested `input` / `arguments` unwrap, canonical `cmd`-only behavior, aliases `cmd` / `command` / `toon` / `script`, command arrays, option aliases `cwd` / `workDir` / `timeoutMs` / `max_tokens` / `yield_ms` / `wait_ms`, `with_escalated_permissions` mapping, `read_command_from_args` metadata repair, and removal of legacy `toon` from normalized/missing shapes.
- Residue gate `exec_command argument normalization must be native-owned` blocks local TS exec_command normalization aliases, compat unwrap, option alias repair, and legacy `toon` normalization from returning.
- Verified on 2026-07-06: Rust focused normalization test passed, Rust `resp_process_stage1_tool_governance` passed 215/1 ignored, native hotpath build passed, llmswitch-core build passed, focused exec-command/tool-registry/residue Jest passed 201/201, required-export subtest passed, `cargo fmt --check` passed, `verify:llmswitch-rustification-audit` passed with `prodTsFileCount=165`, `prodTsLocTotal=29768`, `nonNativeFileCount=43`, `nonNativeLocTotal=5832`, function-map gate, mainline call-map gate, servertool rust-only gate, and touched-file diff check passed. No managed live restart/replay was claimed.

# 2026-07-06: Virtual Router hit-log formatting is Rust-owned

- `runtime/virtual-router-hit-log.ts` no longer owns Virtual Router hit-log formatting, stop-message runtime summary, hit record normalization, telemetry event projection, provider key parsing, target display label, session color key/color, route color, continuation scope truncation, hit reason/context summary, omit filtering, or formatted log-line construction.
- Rust `virtual_router_hit_log.rs` owns those contracts through required native exports: `createVirtualRouterHitRecordJson`, `toVirtualRouterHitEventJson`, `formatVirtualRouterHitJson`, `formatContinuationScopeJson`, `parseVirtualRouterHitProviderKeyJson`, `describeTargetProviderJson`, `resolveRouteColorStr`, `resolveSessionColorStr`, `resolveSessionLogColorKeyJson`, and `buildHitReasonJson`.
- TS `runtime/virtual-router-hit-log.ts` may only load the required native binding, flatten `routingState` into the native input contract, parse native JSON, return native strings, and keep exported TS types.
- Residue gate `virtual router hit-log formatting must be native-owned` blocks local TS stop-message summary, omit normalization, provider parsing, color maps/hash state, context summary, hit reason building, timestamp formatting, and stopMessage label formatting from returning.
- Verified on 2026-07-06: Rust focused hit-log contract test passed, native hotpath build passed, llmswitch-core build passed, focused hit-log/required-export/residue Jest passed, `cargo fmt --check` passed, `verify:llmswitch-rustification-audit` passed with `prodTsFileCount=165`, `prodTsLocTotal=29421`, `nonNativeFileCount=42`, `nonNativeLocTotal=5251`, function-map gate, mainline call-map gate, and touched-file diff check passed. No managed live restart/replay was claimed.

# 2026-07-05: exec_command hardcoded guard Phase 3A is Rust-owned, not total rustification

- `exec_command` hardcoded guard Phase 3A is native-owned by `resp_process_stage1_tool_governance_blocks/exec_command_guard.rs` through `validateExecCommandGuardJson`.
- Rust owns `git reset --hard` blocking, `git checkout` scope blocking, wrapped `bash/sh/zsh -c/-lc` inspection, and persistent shell write detection for exec/shell tool governance.
- TS `exec-command/validator.ts` and `tools/tool-registry.ts` may call the native guard and keep only normalization, IO-facing validation plumbing, policy-file checks, and the remaining Phase 3B shell-wrapper shape/repair shell. They must not restore TS reset/checkout regex/tokenizer/write-detector semantics.
- Verified evidence on 2026-07-05: Rust `exec_command_guard` 21/21, Rust `resp_process_stage1_tool_governance` 211 passed / 1 ignored, native hotpath build, llmswitch-core tsc, focused exec-command/tool-registry/residue Jest 204/204, rustification audit (`prodTsFileCount=165`, `prodTsLocTotal=30270`, `nonNativeFileCount=45`, `nonNativeLocTotal=6137`), function-map gate, mainline-call-map gate, servertool rust-only gate, and `git diff --check` all passed.
- This closes only the Phase 3A slice. Full Hub/VR/Chat Process rustification remains open because Phase 3B `exec_command` TS policy/shape debt and other L1 `ts_semantic_debt` items still require owner-scoped closeout and runtime replay before runtime completion can be claimed.

# 2026-07-05: exec_command guard Phase 3B policy and shell-wrapper are Rust-owned

- `exec_command` guard Phase 3B moved shell-wrapper shape validation, zero-ambiguity shell-wrapper repair, wrapped-shell policy matching, and policy-file regex rule evaluation into Rust `validateExecCommandGuardJson`.
- TS `exec-command/validator.ts` no longer owns policy regex parsing/evaluation or shell-wrapper shape/repair semantics. It may read an optional policy file as IO, pass raw `policyJson` to native, and project native `normalizedCmd`.
- Residue gate `exec_command hardcoded guard rules must be native-owned` now also bans TS policy regex loader/evaluator and shell-wrapper helper patterns from returning.
- Verified evidence on 2026-07-05: Rust `exec_command_guard` 23/23, Rust `resp_process_stage1_tool_governance` 213 passed / 1 ignored, native hotpath build, llmswitch-core tsc, focused exec-command/tool-registry/servertool/residue Jest 204/204, rustification audit (`prodTsFileCount=165`, `prodTsLocTotal=30110`, `nonNativeFileCount=45`, `nonNativeLocTotal=6137`), function-map gate, mainline-call-map gate, servertool rust-only gate, `build:base`, and `git diff --check` all passed.
- This closes only the Phase 3B policy/shape slice. Full Hub/VR/Chat Process rustification remains open because TS `tools/exec-command/normalize.ts`, `tools/args-json.ts`, compat profile registry, guidance tool schema mutation, VR contracts, and hit-log debt still require owner-scoped closeout.

# 2026-07-05: Responses direct passthrough must not provider-wire preflight live bodies

- Marker: responses-direct-no-wire-preflight-stackfix-20260705.
- Live failure signature: `/v1/responses` on router same-protocol direct fails before provider dispatch with `[llmswitch-bridge] evaluateResponsesDirectRouteDecisionJson JSON stringify failed: Maximum call stack size exceeded`.
- Durable rule: `src/server/runtime/http-server/direct-passthrough-payload.ts` is only a payload-object boundary. The router direct path must keep the current request body as provider wire and must not call `evaluateResponsesDirectRouteDecisionNative()` or any provider-wire shape validator as a live preflight.
- Provider-specific or historical Responses tool-output shape rejection belongs to the provider/runtime or Hub relay owner that actually transforms the protocol. Server same-protocol direct must not sanitize, repair, force relay, replay raw metadata, or fail-fast because of historical `function_call_output.content`.
- Verified closeout on 2026-07-05: focused route-level red/green test, direct payload spec, direct architecture gates, function-map gate, mainline-call-map gate, `build:base`, `pack:rcc`, `verify:rcc-release-install`, global `routecodex/rcc 0.90.3591` install, managed `rcc restart --port 5520`, all configured `/health` endpoints ready, and live same-shape `/v1/responses` smoke returned HTTP 200 with no new post-restart stack-overflow logs.
- Caveat: the exact original request sample directory for `...3225` was unavailable; replay used the same entry and same problematic body shape.

# 2026-07-06: Virtual Router contracts file is type-only bridge surface

- `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts` no longer owns TS runtime route constants or Virtual Router error values.
- Removed `DEFAULT_MODEL_CONTEXT_TOKENS`, `DEFAULT_ROUTE`, and `ROUTE_PRIORITY` from the TS contracts file. Route/default/priority truth remains in Rust `virtual_router_engine`.
- `VirtualRouterError` and `VirtualRouterErrorCode` now live in the existing native-linked `native-router-hotpath-policy.ts` shell. Production, test, and script imports must not import those value exports from `virtual-router-contracts.ts`.
- Residue gate `virtual router contracts must stay type-only bridge surface` blocks TS route constants and error value exports from returning to the contracts file.
- Verified on 2026-07-06: `npm --prefix sharedmodule/llmswitch-core run build`, `npm run build:native-hotpath`, focused routing/error/websearch/residue Jest, `verify:llmswitch-rustification-audit` (`prodTsFileCount=165`, `prodTsLocTotal=29403`, `nonNativeFileCount=41`, `nonNativeLocTotal=5221`), function-map gate, mainline call-map gate, and touched-file diff check passed. No managed live restart/replay was claimed.

# 2026-07-06: Responses store continuation-allow flag is Rust-owned

- `responses-conversation-store.ts::recordResponse()` no longer decides whether a saved `/v1/responses` entry may continue based on pending tool calls. It only collects `pendingToolCallIds` from the current canonical `entry.input`, calls native `planResponsesRecordContinuationFlagJson`, and projects the returned `allowContinuation`.
- Rust `shared_responses_conversation_utils.rs::plan_responses_record_continuation_flag` owns the branch contract:
  - non-empty trimmed pending tool call ids => `allowContinuation=true`, reason `pending_tool_calls`
  - otherwise keep existing `allowContinuation=true`, reason `already_allowed`
  - otherwise `allowContinuation=false`, reason `no_pending_tool_calls`
- The old TS branch `entry.allowContinuation === true && args.allowScopeContinuation === true && entry.scopeKeys.length > 0` was a semantic no-op and must not return as an alternate continuation owner.
- Verified on 2026-07-06: focused Rust test for `record_continuation_flag_plan_owns_pending_tool_decision`, native hotpath build, llmswitch-core build, focused responses store/residue Jest, `verify:responses-history-protocol-contract` (`75` tests), required native export subtest, rustification audit (`prodTsFileCount=160`, `prodTsLocTotal=29066`, `nonNativeFileCount=36`, `nonNativeLocTotal=4752`), function-map gate, mainline gate, and touched-file diff check all passed. No managed live restart/replay was claimed.

# 2026-07-06: Responses store capture entry construction is Rust-owned

- `responses-conversation-store.ts::captureRequestContext()` no longer owns `ConversationEntry` construction semantics. TS computes scope keys and executes Map/FS persistence, but the entry fields are planned by native `planResponsesCapturedEntryJson`.
- Rust `shared_responses_conversation_utils.rs::plan_responses_captured_entry` owns capture-time `basePayload`, normalized `input`, optional `tools`, `allowContinuation`, provider/session/conversation tokens, `entryKind`, `continuationOwner=null`, scope keys, port scope, and timestamps.
- Important contract: when `basePayload` already contains `tools`, Rust does not duplicate them into separate `entry.tools`; resume helpers read tools from full base payload when needed.
- Verified on 2026-07-06: focused Rust test `captured_entry_plan_owns_capture_entry_construction`, native hotpath build, llmswitch-core build, focused responses store/residue Jest, required native export subtest, `verify:responses-history-protocol-contract` (`76` tests), rustification audit (`prodTsFileCount=160`, `prodTsLocTotal=29117`, `nonNativeFileCount=36`, `nonNativeLocTotal=4747`), function-map gate, mainline gate, and touched-file diff check all passed. No managed live restart/replay was claimed.

# 2026-07-06: Responses store dead TS wrappers/required exports can be deleted after source-only consumer proof

- For `conversion.responses.store`, deleting a TS/native facade pair is allowed only after source-only search proves no active consumer under `sharedmodule/llmswitch-core/src` and tests/scripts/docs are treated as evidence only after opening the source files.
- On 2026-07-06 the following zero-consumer TS wrappers were safely deleted:
  - `pickPersistedFields`
  - `prepareConversationEntry`
  - `shouldAllowContinuation`
  - `pickResponsesPersistedFieldsWithNative`
  - `prepareResponsesConversationEntryWithNative`
  - `shouldAllowResponsesConversationContinuationWithNative`
  - required exports `pickResponsesPersistedFieldsJson`, `prepareResponsesConversationEntryJson`, `shouldAllowResponsesConversationContinuationJson`
- Boundary: the underlying Rust internal functions still exist and may still appear in `lib.rs` / architecture docs. Do not delete the Rust NAPI shells in the same slice unless map/wiki/export surfaces are updated together; otherwise this is no longer a pure dead-facade cleanup.
- Verified on 2026-07-06: source-only `rg` found no active consumer beyond fixture text, native build passed, llmswitch-core build passed, focused responses store/residue Jest passed, required export subtest passed, `verify:responses-history-protocol-contract` passed (`76` tests), rustification audit passed (`prodTsLocTotal=28969`, `nonNativeLocTotal=4747`), function-map gate passed, mainline call-map gate passed, and touched-file diff check passed.

# 2026-07-06: Responses conversation store TS file is an IO shell locked by residue gate

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` is classified as `ts_io_shell_ok/native_plan_io_shell_ok` after L2 closeout evidence.
- Allowed TS roles in this file: filesystem persistence, process/env path resolution, global singleton/timer lifecycle, Map/index mutation, candidate projection for native plans, non-blocking logging, diagnostics counters, and `ProviderProtocolError` projection from native plan reasons.
- Forbidden TS roles in this file: manual scope-key construction, continuation owner comparisons, continuation allow true/false branches, local response output-to-input conversion, retired `pick/prepare/shouldAllow` wrappers, history reconstruction, released-prefix fallback, and continuation payload repair.
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` test `responses conversation store TS surface must stay a native-plan IO shell` requires native plan calls and blocks those forbidden patterns.
- Verified on 2026-07-06: focused store residue Jest passed, native hotpath build passed, llmswitch-core build passed, `verify:responses-history-protocol-contract` passed (`76` Rust tests), rustification audit passed (`prodTsFileCount=160`, `prodTsLocTotal=28969`, `nonNativeFileCount=36`, `nonNativeLocTotal=4747`), function-map gate passed, and mainline call-map gate passed. No managed live restart/replay was claimed.
# 2026-07-06: Rustification L1 currently has no Hub/VR semantic TS debt, MemPalace scan excludes artifacts

- Fresh source/doc-only rustification audit (`node scripts/ci/llmswitch-rustification-audit.mjs --json`) reports `prodTsFileCount=160`, `prodTsLocTotal=28969`, `nonNativeFileCount=36`, `nonNativeLocTotal=4747`.
- The current 36 nonNative TS files classify as `ts_io_shell_ok`, `native_shell_ok`, `type_shell_ok`, or diagnostics/process IO for the Hub Pipeline / Virtual Router semantic watchlist; no current `ts_semantic_debt` remains in that list. This is code/L1 classification only and does not claim managed runtime closure.
- `conversion/shared/responses-conversation-store.ts` is classified as `ts_io_shell_ok/native_plan_io_shell_ok` because the remaining TS surface executes Map/FS/global singleton/timer/logging/error-projection IO over Rust native plans, with residue gates blocking continuation owner/scope/allowContinuation semantics from returning.
- MemPalace project scanning is verified to exclude generated/local artifacts by `npm run verify:mempalace-scan-artifacts` (`scannedFiles=7008`, `artifactHits=0`). Representative `dist/`, package `dist/`, Rust `target/`, `node_modules/`, `coverage/`, `.local-index/`, and `.mempalace/` paths are ignored; root `mempalace.yaml` and root `mempalace/` are absent.

# 2026-07-06: Responses handler request-body metadata belongs behind the bridge

- `src/server/handlers/responses-handler.ts` must not read request body metadata directly. HTTP request-body metadata preprocessing for `/v1/responses` belongs behind `src/modules/llmswitch/bridge/responses-request-bridge.ts`.
- `prepareResponsesHandlerRuntimeForHttp()` owns reading body metadata, merging request metadata, deriving session/conversation request context, stripping payload metadata, and returning `requestBodyMetadata` to the handler for logging/projection.
- Gate: `npm run verify:responses-handler-single-bridge-surface` blocks handler imports/calls that bypass the bridge. Verified on 2026-07-06 with the single-bridge gate, focused Responses bridge/handler Jest 23/23, and `npx tsc --noEmit --pretty false`.

# 2026-07-06: ProviderProtocol boundary conflicts are not provider availability failures

- Provider protocol boundary conflicts such as `ERR_PROVIDER_PROTOCOL_MISMATCH` or `runtime_control.providerProtocol conflict` must be classified as protocol boundary errors, not provider availability failures.
- Retry planning must fail fast/project them without retry/reroute, without `retrySwitchPlan`, and without excluding the current provider from Virtual Router route hits.
- Gate: `npm run verify:route-metadata-preselected-route-owner` requires `isProviderProtocolBoundaryError()`, protocol-boundary short-circuit, `excludedCurrentProvider: false`, and a regression named `protocol boundary conflicts never exclude providers from VR route hits`. Verified on 2026-07-06 with the gate, focused provider failure Jest 8/8, `npx tsc --noEmit --pretty false`, and `npm run verify:architecture-ci-longtail`.

# 2026-07-06: Architecture maps and install build tiering closeout facts

- `function-map.yml` `required_tests` entries must be concrete file paths, not directories; directory paths can crash `verify:function-map-test-coverage-integrity` with `EISDIR`.
- `scripts/install-global.sh` must run `npm run build:min` for its default build path; `build:dev` is not accepted by `verify:build-script-tiering`.
- Deleted source paths must not remain in function-map `allowed_paths`; `verify:architecture-deleted-path` is the guard for stale map paths after physical deletions.
- Duplicate-owner summary text can trigger cross-family owner collisions; summary wording must avoid claiming another feature's action such as `metadata:read` when the owner is a slot/API surface.
- Verified on 2026-07-06: `verify:build-script-tiering`, `verify:function-map-test-coverage-integrity`, `verify:function-map-required-tests-bidir`, `verify:function-map-compile-gate`, `verify:architecture-deleted-path`, `verify:architecture-duplicate-owner`, `verify:architecture-ts-owner-ban`, full `verify:architecture-ci`, `build:base`, and rustification audit all passed. No managed live restart/replay was claimed.
# 2026-07-06: managed restart must stay single-port and snapshot-first for runtime adoption

- `src/cli/commands/restart.ts` explicit `routecodex restart --port <port>` is a single-target lifecycle action. It may use the matched config port entry only to resolve the probe host; it must not expand into sibling port-group restarts. Otherwise stale/missing sibling listeners can block managed runtime adoption on the requested port.
- Release-package restart must compare live `/health.version` with the current CLI/package version and, when they differ, adopt the current runtime through `start --restart --port <target>` instead of accepting in-place `SIGUSR2` reload on the old process.
- `scripts/install-global.sh` must keep `ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1` on every shim rewrite. Without snapshot-first shims, `routecodex` and `rcc` can resolve different binaries (`routecodex` from newer global package, `rcc` from stale global package), while managed live/runtime truth must converge on `~/.rcc/install/current`.
- Verified 2026-07-06:
  - restart focused Jest + probe-host Jest PASS
  - root `tsc` PASS
  - `build:min` PASS
  - `install-release-snapshot.mjs` installed `routecodex-0.90.3596-2026-07-05T221943Z`
  - snapshot-first shims made both `routecodex --version` and `rcc --version` report `0.90.3596`
  - managed `routecodex restart --port 5555` moved live `/health.version` on both `5555` and `5520` to `0.90.3596`
  - same-entry `/v1/responses` probe `/tmp/p0-rust-live-5555-after-restart.json` showed first-turn stopless `exec_command`, no leaked stop schema, and continuation completion

# 2026-07-11: restart must stay in original managed session

- Correction to 2026-07-06 restart adoption rule: `restart.ts` must not compare live `/health.version` and spawn `start --restart --port <target>`. That creates a new start/session takeover and can stop the originally started server/session.
- Current restart truth: `rcc restart` / `routecodex restart --port <port>` requests restart from the existing process/session. It uses `/daemon/restart-process` when authorized, otherwise sends `SIGUSR2` to target listener pid(s). With a managed start parent, child exit code 75 is handled by the original parent supervisor in the same session.
- `runtime.lifecycle.restart_command` owns `src/cli/commands/restart.ts`; required regression tests are `tests/cli/restart-command.spec.ts` and `tests/cli/restart-command.probe-host.spec.ts`.
- Verified release evidence on 2026-07-11: global install `routecodex/rcc 0.90.3868` from `~/.rcc/install/current -> releases/routecodex-0.90.3868-2026-07-11T125522Z`; installed dist has 0 matches for `adoptCurrentRuntimeViaStart|targetsNeedRuntimeAdoption|getExpectedVersion|start --restart`; explicit global `rcc restart --port 5555 --host 127.0.0.1` reported in-place signal restart, kept original `start --snap` parent PID `85830`, and replaced child `23167 -> 24868` under the same parent; `/health` on `5555`, `5520`, and `10000` returned ok/ready/pipelineReady version `0.90.3868`.
- Final release evidence on 2026-07-11 supersedes the same-day `0.90.3868` snapshot after another install overwrote `~/.rcc/install/current` to `0.90.3879`: final global install is `routecodex/rcc 0.90.3869` from `~/.rcc/install/current -> releases/routecodex-0.90.3869-2026-07-11T131712Z`; installed dist has 0 matches for `adoptCurrentRuntimeViaStart|targetsNeedRuntimeAdoption|getExpectedVersion|start --restart`; explicit installed `rcc restart --port 5555 --host 127.0.0.1` reported in-place signal restart, kept original `start --snap` parent PID `49609`, and replaced child `82268 -> 85819` under the same parent; `/health` on `5555`, `5520`, and `10000` returned ok/ready/pipelineReady version `0.90.3869`, and `routecodex port status 5555 --json` returned `ok:true`, `localPort:5555`, `routingPolicyGroup:"gateway_priority_5555"`.

# 2026-07-06: Runtime config materialization is Rust-owned and JSON config support is removed

- Rust SSOT: RouteCodex runtime manifest / VR bootstrap materialization is owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/runtime_config_materialization.rs` through `compileRouteCodexRuntimeManifestJson`.
- TS boundary: `src/config/user-config-loader.ts` is now file IO/provider-profile shell and must not regain TS materialization fallback logic.
- Config format truth: root runtime config is `~/.rcc/config.toml`; provider config is `~/.rcc/provider/<providerId>/config.v2.toml`. `config.json`, provider `config.v1.json`, provider `config.v2.json`, and JSON migration commands are removed legacy paths and must fail fast or be ignored, not migrated/fallback-read.
- Verified cleanup: 23 old `~/.rcc` provider JSON config files were physically deleted on 2026-07-06; cleanup verification confirmed no old JSON config files remained under the checked patterns.
- Verification used: root TS compile, llmswitch-core TS compile, focused config/provider-update Jest, Rust `runtime_config_materialization` cargo test, and native hotpath build.
- Provider-update closeout: `src/tools/provider-update/config-builder.ts` is deleted; `provider update <providerId>` reads provider config through the Rust `loadProviderConfigsV2(root)` root loader and writes canonical `provider/<id>/config.v2.toml` through the shared TOML writer. It must not accept arbitrary provider `--config <file>` paths, regenerate v1 `virtualrouter.providers` JSON configs, or silently seed models on upstream failure. The grep gate now blocks production old config filenames, JSON migration/shadow refs, and v1 `virtualrouter.providers` access outside materialized output validation.
- Server runtime closeout: HubPipeline must consume `pipelineRuntimeConfig` from the same Rust `RouteCodexRuntimeManifest` produced during router bootstrap. `src/server/runtime/http-server/runtime-config-manifest-carrier.ts` carries the non-enumerable manifest from bootstrap to setup; setup must fail fast if the manifest is missing, and server/config runtime must not import/use VR-only bootstrap wrappers.
- Verified on 2026-07-06: focused config/runtime Jest 8 suites / 49 tests, grep residue gate, root TS compile, llmswitch-core TS compile, Rust config materialization cargo test, native hotpath build, function-map gate, mainline call-map gate, VR no-TS-runtime gate, minimal TS surface gate, rustification audit, and architecture-ci longtail all passed for this artifact-carry slice.
- Live closeout verified on 2026-07-06: repo package, global `routecodex --version`, and `~/.rcc/install/current/package.json` all reported `0.90.3603`; managed `routecodex restart --port 5555` passed; `/health` on ports 5555 and 5520 reported `version=0.90.3603`; same-entry stopless live probe `/tmp/config-materialization-rust-live-5555.json` completed with first-turn `exec_command`, no leaked stop schema, and completion after submit_tool_outputs.

# 2026-07-06: Config TOML parse/serialize is Rust-owned

- Rust SSOT: TOML parse/serialize semantics for RouteCodex config are owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_toml_codec.rs`.
- TS boundary: `src/config/toml-basic.ts` is a thin native shell only; it must not regain handwritten TOML parsing, splitting, inline-table parsing, serializer ordering, or comment-stripping semantics.
- User/provider config codecs remain TS shells for file IO, TOML-only path rejection, and provider coercion; they delegate TOML data semantics to `config.toml_codec`.
- Native exports `parseRouteCodexTomlRecordJson` and `serializeRouteCodexTomlRecordJson` are required hotpath exports.
- Verified on 2026-07-06: Rust TOML codec cargo test, focused config blackbox Jest, `verify:config-ssot`, root TS compile, llmswitch-core TS compile, native hotpath build, function-map gate, minimal TS surface, rustification audit, and diff check all passed.

# 2026-07-06: Config TOML scalar patch is Rust-owned

- Rust SSOT: comment-preserving TOML string scalar patch semantics are owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_toml_codec.rs` through `update_toml_string_scalar_in_table_json`.
- TS boundary: `src/config/toml-comment-preserving.ts` is a thin sync native shell only; it must not regain table scanning, key matching, comment spacing preservation, scalar escaping, table creation, or insertion-order logic.
- Superseded boundary on 2026-07-07: user config async real-file writes and scalar patch read/write are now Rust-owned through `config_file_codec`; TS `src/config/user-config-writer.ts` is a native shell. Provider async real-file writes are also Rust-owned; `writeProviderConfigFileSync(fsImpl)` remains the TS injected-filesystem boundary until init/test caller injection is removed.
- Native export `updateRouteCodexTomlStringScalarInTableJson` is a required hotpath export.
- Verified on 2026-07-06: Rust TOML codec tests, native hotpath build, focused TOML writer/config writer/grep Jest, `verify:config-ssot`, root TS compile, llmswitch-core TS compile, function-map gate, minimal TS surface, rustification audit, and diff check all passed.

# 2026-07-07: Config async writers are Rust-owned

- Rust SSOT: user config async writes, user scalar patch read/write, and provider config async writes are owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_file_codec.rs`.
- Native exports: `writeRouteCodexUserConfigFileJson`, `writeRouteCodexProviderConfigFileJson`, and `updateRouteCodexUserConfigStringScalarJson` are required hotpath exports.
- TS boundary: `src/config/user-config-writer.ts` and async `writeProviderConfigFile()` are native shells only. `writeProviderConfigFileSync(fsImpl)` remains TS because init/authoring tests pass an injected synchronous filesystem; replacing it with Rust would bypass that host boundary.
- Verified on 2026-07-07 with pre-wire Rust/TS writer parity (`tests/config/config-writer-rust.spec.ts`), post-wire config writer/grep Jest (4 suites / 25 tests), Rust `config_file_codec` tests (5), `verify:config-toml-codec-rust` (7), native hotpath build with required exports, root TS compile, function-map gate, minimal TS surface gate, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-06: Provider config v2 coercion is Rust-owned

- Rust SSOT: provider config v2 coercion from parsed TOML record into `ProviderConfigV2` shape is owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_provider_codec.rs` through `coerce_provider_config_v2_from_parsed_json`.
- TS boundary: `src/config/provider-config-codec.ts` remains a file IO/path rejection/TOML parse shell only; `coerceProviderConfigV2FromParsed` must call native `coerceRouteCodexProviderConfigV2Json` and must not regain provider id/version/default shape logic.
- Native export `coerceRouteCodexProviderConfigV2Json` is a required hotpath export.
- Verified on 2026-07-06: Rust provider codec tests, native hotpath build, focused provider config/TOML/grep Jest, `verify:config-ssot`, root TS compile, llmswitch-core TS compile, function-map gate, minimal TS surface, rustification audit, diff check, and cargo fmt check all passed.

# 2026-07-06: Provider v2 loader planning and identity validation are Rust-owned

- Rust SSOT: provider config v2 file filtering/sorting and provider identity validation are owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_provider_codec.rs` through `plan_provider_config_v2_files_json` and `resolve_provider_config_v2_identity_json`.
- TS boundary: `src/config/provider-v2-loader.ts` remains a Node host IO shell for readdir/path join/file decode/native coercion and duplicate accumulation across loaded files. It must not regain handwritten `config.v2*.toml` file matching, sort planning, base config directory-id injection, suffixed file explicit-id enforcement, or provider id mismatch logic.
- Native exports `planRouteCodexProviderConfigV2FilesJson` and `resolveRouteCodexProviderConfigV2IdentityJson` are required hotpath exports.
- Verified on 2026-07-06: Rust provider codec tests, native hotpath build, focused provider-loader/config-codec-gate Jest, `verify:config-ssot`, root TS compile, function-map gate, minimal TS surface, rustification audit, diff check, and `cargo fmt -p router-hotpath-napi --check` all passed.
- Boundary: full workspace `cargo fmt --check` remains blocked by unrelated unmodified formatting drift in `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`; no managed live restart/replay was run for this offline config loader slice.

# 2026-07-06: User config v2 source validation is Rust-owned

- Rust SSOT: v2 user config source-layout validation and primary routingPolicyGroup resolution are owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/runtime_config_materialization.rs` through `collect_v2_config_source_errors_json` and `resolve_primary_routecodex_routing_policy_group_json`.
- TS boundary: `src/config/user-config-loader.ts` remains a file/provider/profile orchestration shell. `collectV2ConfigSourceErrors` and primary routingPolicyGroup selection must call native and must not regain allowed-field sets, default-route target validation, implicit-v2 detection, router-port precedence, active group fallback, or single-group fallback logic.
- Native exports `collectRouteCodexV2ConfigSourceErrorsJson` and `resolvePrimaryRouteCodexRoutingPolicyGroupJson` are required hotpath exports.
- Verified on 2026-07-06: Rust runtime materialization tests, native hotpath build, focused routecodex config/runtime materialization/grep Jest, `verify:config-ssot`, root TS compile, function-map gate, minimal TS surface, rustification audit, diff check, and `cargo fmt -p router-hotpath-napi --check` all passed.
- Boundary: full workspace `cargo fmt --check` remains blocked by unrelated unmodified formatting drift in `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`; no managed live restart/replay was run for this offline config loader slice.

# 2026-07-06: Materialized provider extraction is Rust-owned

- Rust SSOT: materialized `virtualrouter.providers` extraction into provider config records is owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/runtime_config_materialization.rs` through `extract_routecodex_materialized_provider_configs_json`.
- TS boundary: `src/config/user-config-loader.ts` remains a file/provider/profile orchestration shell. It may choose Rust-extracted materialized provider configs or load provider v2 files, but must not regain provider id trimming, provider object validation, provider.id mismatch checks, id injection, or `ProviderConfigV2` record construction for `virtualrouter.providers`.
- Native export `extractRouteCodexMaterializedProviderConfigsJson` is a required hotpath export.
- Verified on 2026-07-06: Rust runtime materialization tests, native hotpath build, focused routecodex config/runtime materialization/grep Jest, `verify:config-ssot`, root TS compile, function-map gate, minimal TS surface, rustification audit, diff check, and `cargo fmt -p router-hotpath-napi --check` all passed.
- Boundary: full workspace `cargo fmt --check` remains blocked by unrelated unmodified formatting drift in `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`; no managed live restart/replay was run for this offline config loader slice.

# 2026-07-06: RCC default routing pools must be superset pools

- In `~/.rcc/config.toml`, each `virtualrouter.routingPolicyGroups.<group>.routing.default` pool must include all models/forwarders used by the same group's non-default pools.
- Default target order is business priority order. For otherwise comparable targets, models/forwarders with `web_search` and `multimodal` support should be placed earlier.
- GPT forwarder convention: `fwd.gpt.*` is the free/limited-free dynamic pool and should be tried before `fwd.paid.*`; paid GPT aggregation belongs in `fwd.paid.*`.

# 2026-07-06: Minimal TS surface is machine-locked for Hub/VR rustification

- `docs/loops/rustification/minimal-ts-surface.json` is the machine-readable manifest for all current non-native production TS files under `sharedmodule/llmswitch-core/src`.
- `npm run verify:llmswitch-minimal-ts-surface` compares that manifest against the live source/doc-only non-native TS list and fails if any current file is unclassified, any manifest entry is stale, any classification is invalid, or any minimum role / cannot-shrink reason is weak.
- Each entry must name classification, owner feature, minimum TS role, forbidden semantics, and hard `cannotShrinkFurtherBecause` reason. Acceptable reasons must name concrete blockers such as Node host IO, public TS declaration surface, JSON-string NAPI ABI, process-global singleton/timer/filesystem state, or diagnostics sink.
- The gate is wired into `verify:architecture-ci-longtail`.
- Verified on 2026-07-06: `verify:llmswitch-minimal-ts-surface` PASS with 36 entries matching 36 current non-native prod TS files; `verify:llmswitch-rustification-audit` PASS with `prodTsFileCount=160`, `prodTsLocTotal=28969`, `nonNativeFileCount=36`, `nonNativeLocTotal=4747`; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `verify:architecture-ci-longtail` PASS.
- Boundary: this proves remaining TS surface is classified and gate-locked, not that more IO/type shell migration has occurred or that new live runtime replay was performed.
# 2026-07-06: Dead Hub response runtime barrel is deleted

- `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime.ts` was a zero-production-consumer barrel that only re-exported `response-runtime-anthropic.ts`. It is physically deleted.
- Tests and scripts that need Anthropic response conversion must import `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts` or the corresponding `dist/.../response-runtime-anthropic.js` directly.
- The minimal TS surface manifest now tracks 35 current non-native production TS files under `sharedmodule/llmswitch-core/src`; `npm run verify:llmswitch-minimal-ts-surface` enforces that count against source.
- `sharedmodule/llmswitch-core/src/index.ts` must keep `virtual-router-contracts.ts` as `export type *`, not `export *`. The file is a type-only contract surface and must not be exposed as a runtime VR module.
- Verified on 2026-07-06 with minimal TS surface gate, rustification audit (`prodTsFileCount=159`, `prodTsLocTotal=28964`, `nonNativeFileCount=35`, `nonNativeLocTotal=4742`), function-map gate, mainline call-map gate, llmswitch-core build, and focused Hub/servertool residue Jest (`180` tests). No managed live restart/replay was claimed for this slice.

# 2026-07-09: Anthropic response runtime TS shell is deleted

- `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts` is now physically deleted; the 2026-07-06 guidance to import it directly is superseded.
- Tests/scripts that need Anthropic response conversion must call direct native response semantics (`native-hub-pipeline-resp-semantics` / Rust NAPI full exports), not the retired `response-runtime-anthropic` dist subpath.
- Function/verification maps now mark `response-runtime-anthropic.ts` as forbidden runtime TS surface; residue/red-test coverage locks the file as absent.

# 2026-07-09: Standardized bridge runtime TS shell is deleted

- `sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.ts` is physically deleted.
- Remaining ChatEnvelope/StandardizedRequest TS surface is declaration-only (`types/chat-envelope.d.ts`, `types/standardized.d.ts`); conversion behavior belongs to native req inbound/outbound semantics.
- Tests that need chat↔standardized conversion evidence must use direct native helpers, not restore the old runtime wrapper.

# 2026-07-09: Sharedmodule snapshot recorder runtime TS shell is deleted

- `sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts` is physically deleted.
- Snapshot recorder runtime behavior lives in the host bridge `src/modules/llmswitch/bridge/snapshot-recorder.ts` for IO/observation only; snapshot normalization, write planning, policy, and write execution are direct native snapshot hook capabilities.
- The obsolete ambient module for `rcc-llmswitch-core/dist/conversion/hub/snapshot-recorder.js` is removed; do not restore that dist subpath.

# 2026-07-09: Compat engine runtime TS shell is deleted

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts` is physically deleted.
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/native-adapter-context.ts` is physically deleted with it; request compat adapter-context evidence now goes through direct native test helper only.
- Tests/scripts that need request/response compat evidence must call direct native req outbound compat helpers; request compat truth remains in Rust `req_outbound_stage3_compat`.
- Architecture scripts now treat the old compat engine shell as a forbidden resurrection path.

# 2026-07-09: llmswitch core-loader has no implementation selector

- `src/modules/llmswitch/core-loader.ts/js/d.ts` no longer exports `LlmsImpl` or accepts an implementation parameter; the loader resolves the single llmswitch-core dist surface only.
- Host bridge callers must use `resolveCorePackageDir()` without `'ts'` or engine/source selector arguments. Reintroducing implementation selection would violate the llmswitch-core TS shell closeout direction.
# 2026-07-06: VR contracts type surface is facade-scoped

- Upper production layers must not import `sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts` directly.
- Allowed direct imports of `virtual-router-contracts.ts`: same-layer native facades under `sharedmodule/llmswitch-core/src/native/router-hotpath/` and root package `export type *`.
- Hub/Host/Server callers must import VR types from the adjacent native facade that owns their boundary:
  - Hub runtime ingress: `native-virtual-router-runtime.ts`
  - Config/bootstrap: `native-virtual-router-bootstrap-config.ts`
  - Provider error/success ingress: `native-provider-runtime-ingress.ts`
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` test `virtual router contracts must stay type-only bridge surface` now blocks upper-layer direct imports and runtime value semantics from returning to contracts.
- Verified on 2026-07-06 with llmswitch-core build, focused residue Jest, llmswitch-core tsc, minimal TS surface gate, rustification audit (`prodTsFileCount=159`, `prodTsLocTotal=29001`, `nonNativeFileCount=35`, `nonNativeLocTotal=4742`), function-map gate, mainline call-map gate, `verify:vr-no-ts-runtime`, and `verify:vr-no-fallback-semantics`.
- Boundary: `virtual-router-contracts.ts` remains a handwritten TS declaration surface. It cannot be physically deleted until Rust-generated TS declarations or a public config/API migration replaces all compile-time TS contract declarations.

# 2026-07-06: Hub Responses payload closeout planning is Rust-owned

- Rust SSOT for `/v1/responses` response payload closeout planning is `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs` via `plan_responses_payload_from_chat_closeout` and NAPI `planResponsesPayloadFromChatCloseoutJson`.
- This Rust planner owns data-node unwrap, snapshot lookup key order/dedup, inline passthrough/snapshot detection, existing Responses payload replay-safe normalization, freeform apply_patch/custom tool projection, retention context projection, and chat/nonstandard kind planning.
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts` should remain only a host IO/native facade: host policy, snapshot/passthrough store consumption, native build call, and returned metadata stripping. It must not regain local bridge action, reasoning normalization, payload unwrap, snapshot key, inline retention, custom tool projection, or malformed-message semantic checks.
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` blocks response payload TS from re-owning bridge action pipeline or reasoning pre-normalization semantics.
- Verified on 2026-07-06 with Rust closeout tests, native hotpath build, llmswitch-core TS compile, focused responses/provider-response/residue Jest 210 tests, and rustification audit (`prodTsFileCount=159`, `prodTsLocTotal=28837`, `nonNativeFileCount=35`, `nonNativeLocTotal=4743`). No managed live restart/replay was run for this slice.

# 2026-07-06: Provider response is Rust-owned with TS IO shell only

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` is explicitly classified as `ts_io_shell_ok` in `docs/loops/rustification/minimal-ts-surface.json`.
- The file is allowed to do only Node host work: read `Readable` streams, invoke Rust Hub Pipeline/effect planners, execute host side effects (`MetadataCenter`, response store, usage save, servertool shell), record stages, and construct returned SSE streams from Rust frames.
- Provider response parsing, response governance, client projection, effect planning, provider SSE marker/bodyText materialization, stream-read error descriptors, post-servertool projection, and Responses record planning remain Rust-owned through native calls.
- `scripts/ci/verify-llmswitch-minimal-ts-surface.mjs` now permits explicit native-linked shell entries in addition to mandatory non-native entries, so native-linked IO shells can be tracked and forbidden semantics can be gate-locked.
- Gate: `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` test `provider response TS shell must be classified as native IO shell only` blocks local provider response plan types, local shape detectors, endpoint/providerProtocol semantic branches, effect-kind/action switches, client payload builders, fallback/compat wording, and requires the Rust/native call surface.
- Verified on 2026-07-06: `verify:llmswitch-minimal-ts-surface` PASS with 36 manifest entries / 35 current non-native files, provider-response residue Jest PASS, `verify:llmswitch-rustification-audit` PASS (`prodTsFileCount=159`, `prodTsLocTotal=28837`, `nonNativeFileCount=35`, `nonNativeLocTotal=4743`), llmswitch-core TS compile PASS, and Rust provider response gates PASS for provider SSE materialization, context helpers, and post-servertool client projection.

# 2026-07-06: Responses response save request id is active-label first

- For `/v1/responses`, response save must use the current active request label passed to `publishResponsesRecordPlanJson` before any `requestTruth.requestId`. After request-executor rebinds router id to provider id, stale router `requestTruth.requestId` must not override `recordArgs.requestId`.
- Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs::publish_responses_record_plan_json`.
- Gate: `npm run verify:responses-history-protocol-contract` now requires the current-id-first Rust test/anchor and forbids the old requestTruth-first test names. `hub.chat_process_responses_continuation` maps include this gate.
- Verified focused evidence: Rust current-id test passed, native hotpath build passed, provider-response focused/full Jest passed, Responses store/bridge/stopless focused contracts passed, root `tsc`, function-map gate, and mainline call-map gate passed. Current full cargo gate was blocked only by unrelated dirty `config_provider_codec.rs` compile errors.
# 2026-07-06: Provider profile projection is Rust-owned

- `config.provider_profile_materialization` owns provider profile projection through Rust `build_routecodex_provider_profiles_json` and NAPI `buildRouteCodexProviderProfilesJson`.
- `src/providers/profile/provider-profile-loader.ts::buildProviderProfiles()` must remain a native bridge shell. Do not reintroduce TS protocol aliases/resolution, transport extraction, auth extraction/OAuth rejection, compatibility field rejection, metadata extraction, or provider node collection there or in config/server callers.
- `extractApiKeyEntries()` remains TS because it only normalizes an already-built `ApiKeyAuthConfig` public helper; `buildForwarderProfiles()` remains TS and is a separate forwarder profile surface, not closed by this slice.
- Verification evidence on 2026-07-06: crate-local router-hotpath fmt, Rust `runtime_config_materialization` tests, native hotpath build, provider-profile focused Jest, config SSOT, root `tsc`, function-map gate, minimal TS surface gate, rustification audit, and `git diff --check` passed. No managed live restart/replay was run for this offline slice.

# 2026-07-06: Runtime manifest to userConfig materialization is Rust-owned

- `config.user_config_materialization` owns final runtime manifest application through Rust `materialize_routecodex_user_config_from_manifest_json` and NAPI `materializeRouteCodexUserConfigFromManifestJson`.
- `src/config/user-config-loader.ts` must not locally assign/rebuild `userConfig.virtualrouter` from `manifest.virtualRouterBootstrapInput`; it may only orchestrate native normalization, validation, group resolution, provider config IO selection, manifest compilation, native manifest application, and TS provider-profile build.
- Server bootstrap must use `resolvePrimaryRouteCodexRoutingPolicyGroupSync()` for primary group selection; duplicated TS resolver logic was removed.
- Verification evidence on 2026-07-06: crate-local router-hotpath fmt, Rust `runtime_config_materialization` tests, native hotpath build, config SSOT Jest, root `tsc`, function-map gate, minimal TS surface gate, rustification audit, and `git diff --check` passed. No managed live restart/replay was run for this offline config loader slice.

# 2026-07-06: Implicit v2 runtime source normalization is Rust-owned

- `config.user_config_materialization` owns implicit v2 runtime source normalization through Rust `normalize_routecodex_v2_runtime_source_json` and NAPI `normalizeRouteCodexV2RuntimeSourceJson`.
- `src/config/user-config-loader.ts` must call `normalizeRouteCodexV2RuntimeSourceSync(userConfigInput)` before validation/materialization and must not regain TS implicit-v2 detection, `virtualrouterMode` mutation, or local config-source normalization semantics.
- Verification evidence for this ownership slice: crate-local router-hotpath fmt, Rust `runtime_config_materialization` tests, native hotpath build, focused config/runtime/grep Jest, root `tsc`, `verify:config-ssot`, function-map compile gate, minimal TS surface gate, rustification audit, and `git diff --check` passed on 2026-07-06.

# 2026-07-06: Responses missing-context is a local capture/save mismatch, not invented provider continuation behavior

- For `/v1/responses`, configured-provider behavior must be tested against configured providers such as `cc` / `asxs` with login-shell env keys. Do not use `api.openai.com` as a substitute when RouteCodex is routing through configured providers.
- Verified provider evidence: `cc` HTTP `/responses` with fake `previous_response_id` returned HTTP 400 `previous_response_id is only supported on Responses WebSocket v2`; `asxs` selected key returned 401 in this pass and was not used as continuation truth.
- Local store root: request-context capture must preserve the original inbound Responses payload before Hub rewrites the body into provider wire shape. Response save uses the active provider request label; capture must use the same active label and the raw entry payload.
- Code truth: `src/server/runtime/http-server/executor-metadata.ts::buildRequestMetadata` preserves `__raw_request_body` unless already supplied; `resolveResponsesConversationRequestCaptureArgsForChatProcessEntry` consumes that raw payload for Chat Process request-context capture.
- Safety lock: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::recordResponse` must not scope-fallback to a same-scope entry when explicit request context is missing; missing explicit context remains `RESPONSES_STORE_MISSING_REQUEST_CONTEXT`.
- Verified on 2026-07-06 with focused request-executor metadata contract Jest, `verify:responses-history-protocol-contract`, function-map compile gate, mainline call-map gate, mainline manifest sync, llmswitch-core TS compile, and root TS compile.
- Boundary: no global install/restart/live replay was run for this code-level closure.
# 2026-07-06: Forwarder profile projection is Rust-owned

- `config.forwarder_profile_materialization` owns forwarder profile projection through Rust `build_routecodex_forwarder_profiles_json` and NAPI `buildRouteCodexForwarderProfilesJson`.
- `src/providers/profile/provider-profile-loader.ts::buildForwarderProfiles()` must remain a native bridge shell. Do not reintroduce TS forwarder id/protocol/model/strategy/stickyKey/targets/weights parsing or validation there or in config/server callers.
- TS may keep `forwarder-types.ts` schema declarations, `validateForwarderId()` prefix helper, and `forwarder-types-adapter.ts` re-export surface; runtime projection semantics stay in Rust.
- Verification evidence on 2026-07-06: crate-local router-hotpath fmt, Rust `runtime_config_materialization` tests, native hotpath build, forwarder focused Jest, config SSOT, root `tsc`, function-map gate, minimal TS surface gate, rustification audit, and `git diff --check` passed. No managed live restart/replay was run for this offline slice.

# 2026-07-07: Responses apply_patch custom_tool_call requires full Hub response-path gate

- `verify:hub-response-responses-chat-projection` must not be helper-only. It now runs both Rust filters: `build_chat_response_from_responses` and `response_path_preserves_existing_responses_custom_tool_call`.
- The full-path fixture lives in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/tests.rs` and locks provider `custom_tool_call` `apply_patch` through Rust Hub response processing into a non-empty client-visible Responses `custom_tool_call`.
- `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` list `hub_pipeline_lib/tests.rs` under both `hub.response_responses_chat_projection` and `hub.response_responses_client_projection`; the exact fixture name is locked by the package gate command and verification-map notes.
- Verified on 2026-07-07 with `npm run verify:hub-response-responses-chat-projection`, `npm run verify:function-map-compile-gate`, and scoped `git diff --check`. This is a gate closure only; live closure still requires native build, global release install, health version match, and live apply_patch replay.

# 2026-07-07: Config TS surface is Node IO/native shell only for path/auth/codec-loader slices

- `src/config/user-data-paths.ts` no longer exposes public `ForRead` helpers, public `.routecodex` helpers, or `llmsShadow`; retired `.routecodex` env roots fail fast instead of being silently redirected to `.rcc`.
- `src/config/auth-file-resolver.ts` keeps only single-key `resolveKey()` over `authfile-*` Node file IO; removed batch fallback and cache-clear helper surfaces must not be restored.
- `src/config/unified-config-paths.ts` only resolves deterministic TOML config paths and returns `{ resolvedPath }`; it must not regain arbitrary TOML directory selection, source/type/existence metadata, or config-directory creation helpers.
- Deleted config dead surfaces: `src/config/toml-commented-template.ts` and `src/config/user-config-materializer.ts`. Do not recreate them for examples or import-cycle convenience.
- Provider config file planning is Rust-owned in `config_provider_codec.rs`; retired `config.v1.json` / `config.v2.json` in provider directories must fail fast, not be ignored beside TOML.
- Verified on 2026-07-07 with Rust provider codec tests, native hotpath build, focused provider loader/user path tests, root TS compile, config SSOT, function-map gate, minimal TS surface gate, rustification audit (`prodTsFileCount=143`, `prodTsLocTotal=28598`, `nonNativeFileCount=19`, `nonNativeLocTotal=3594`), and diff check. No managed live restart/replay was run for this offline slice.

# 2026-07-07: Provider v2 root loading is Rust-owned

- `config.provider_config_coercion` owns provider v2 root loading through Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_provider_codec.rs::load_provider_configs_v2_from_root_json` and NAPI `loadRouteCodexProviderConfigsV2FromRootJson`.
- `src/config/provider-v2-loader.ts` must remain a root path/native bridge shell only. Do not reintroduce `fs/promises`, `readdir`, `readFile`, local provider config file planning, local TOML decode/coerce, local duplicate provider id accumulation, base-file directory id injection, or suffixed-file explicit-id enforcement there.
- Provider v2 root loading semantics now include provider directory scan, `config.v2*.toml` selection, file read, TOML parse bridge, coercion, duplicate provider id detection, retired JSON rejection, and base/suffixed provider identity validation in Rust.
- Gate: `tests/grep/config-codec-gate.spec.ts` test `provider v2 root loading semantics stay out of TypeScript shell` blocks the old TS loader semantics from returning.
- Verified on 2026-07-07 with root TS compile, native hotpath build, focused provider loader Jest (17 tests), Rust provider codec tests (9 tests), config grep gate (10 tests), config SSOT (6 suites / 48 tests), function-map gate, minimal TS surface gate, rustification audit (`prodTsFileCount=143`, `prodTsLocTotal=28502`, `nonNativeFileCount=19`, `nonNativeLocTotal=3497`), and diff check. No managed live restart/replay was run for this offline config slice.

# 2026-07-07: Provider-update providerId reads use Rust root loader

- Provider CLI commands that operate by provider id must consume `loadProviderConfigsV2(root)` output instead of directly decoding `provider/<id>/config.v2.toml`.
- Covered providerId paths: `provider sync-models`, `provider probe-context`, `provider inspect`, `provider doctor`, and `provider change`.
- Provider-update CLI/tooling paths must not use `decodeProviderConfigFile()` directly. They must address providers by providerId/root and consume the Rust provider v2 root loader; arbitrary provider `--config <file>` direct-decode surfaces are removed.
- Config admin provider views must not use `decodeProviderConfigFile()` directly. They must consume the Rust provider v2 root loader and surface provider summaries from the loaded `ProviderConfigV2` records; per-file admin decode is removed.
- Init provider reads must not use `decodeProviderConfigFileSync()` or local provider directory scans. `rcc init --list-current-providers`, init maintenance menu, provider merge reads, and missing-target checks consume `loadProviderConfigsV2(root)` through `loadProviderV2Map(providerRoot)`. Init writes main config as TOML and provider config as `config.v2.toml`; old JSON init/migration surfaces are rejected.
- Gate: `tests/grep/config-codec-gate.spec.ts` test `provider id CLI config reads go through provider v2 root loader` blocks direct decode/coerce/planning helpers from `src/commands/provider-update.ts` and `src/commands/provider-update-maintenance.ts`.
- Verified on 2026-07-07 with residue grep 0 matches, root TS compile, focused provider-update Jest (10 tests), config grep gate (11 tests), config SSOT (6 suites / 49 tests), function-map gate, minimal TS surface gate (`entries=14`, `non-native prod TS files=12`), rustification audit (`prodTsFileCount=137`, `prodTsLocTotal=28366`, `nonNativeFileCount=12`, `nonNativeLocTotal=3323`), and diff check. No managed live restart/replay was run for this offline CLI/config slice.

# 2026-07-07: Init config path is TOML-only before any init action

- `rcc init --config <path>` must reject non-`.toml` paths immediately through `detectUserConfigFormat(configPath)`, before profile validation, provider-source validation, provider listing, config-state inspection, or any write path.
- This closes the deleted-JSON loophole where a missing `--config /tmp/config.json` path could receive TOML content. Do not restore that behavior as compatibility or migration support.
- Normal init tests should use `config.toml`; any `config.json` init test must be an explicit fail-fast rejection test.
- Verified on 2026-07-07 with root TypeScript, focused init/config/provider-update Jest (6 suites / 43 tests), `verify:config-ssot` (6 suites / 49 tests), function-map compile gate, minimal TS surface gate (`entries=14`, `non-native prod TS files=12`), rustification audit (`prodTsFileCount=137`, `prodTsLocTotal=28366`, `nonNativeFileCount=12`, `nonNativeLocTotal=3323`), residue scans, and `git diff --check`. No managed live restart/replay was run for this offline CLI/config slice.

# 2026-07-07: Config loader rustification must prove existing config compatibility before wiring

- Correction: do not connect a new Rust/config loader path to runtime or start/restart live server until blackbox tests prove the new code reads and preserves behavior for existing `~/.rcc/config.toml` and provider `config.v2.toml` shapes.
- Forbidden response to compatibility failure: editing Jason's real `~/.rcc` config files, removing fields from real config, or treating config edits as a fix for loader/runtime code defects. Existing real config is a compatibility sample; code must adapt or fail with a verified contract error.
- Required order for config/VR/pipeline wiring: source owner/map lookup -> module blackbox over fixtures copied from existing config shape -> old/new output comparison -> focused gates -> only then connection/wiring -> only then managed restart/live probe if explicitly in scope.
- If blackbox is not complete, report "not wired" and the failing/unknown cases. Do not claim closure and do not start the server.

# 2026-07-07: RCC user path resolution is Rust-owned

- `config.path_resolution_surface` owns RCC user dir and subpath resolution through Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/path.rs`.
- TS `src/config/user-data-paths.ts` must remain a native shell for `resolveRccUserDir()` / `resolveRccPath()` / `resolveRccSubdir()` and may keep only snapshot-env handling plus process-env publishing.
- NAPI path resolver calls must pass explicit env snapshots for `RCC_HOME`, `ROUTECODEX_USER_DIR`, and `ROUTECODEX_HOME`; do not rely on Rust `std::env` seeing JS/Jest `process.env` mutations.
- Rust path joining must preserve old Node `path.join()` lexical behavior for `..` and absolute-looking segment strings; `PathBuf::push` alone is not equivalent.
- Verified on 2026-07-07 with Rust `resolve_rcc` tests (4), native hotpath build, focused config blackbox Jest (6 suites / 49 tests), broader config matrix PASS output (13 suites / 99 tests, open handle interrupted after PASS), root TS compile, TOML/provider Rust codec gates, function-map gate, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-07: Config file path resolution is Rust-owned

- `config.path_resolution_surface` also owns `config.toml` file path resolution through Rust `resolve_routecodex_config_path_for_host` and NAPI `resolveRouteCodexConfigPathJson`.
- `src/config/unified-config-paths.ts` must remain a native shell only. Do not reintroduce TS candidate-list precedence, `ROUTECODEX_CONFIG_PATH` / `ROUTECODEX_CONFIG` handling, TOML-only rejection, directory scanning, cwd/base/user-dir candidate construction, or home expansion.
- Required gate `npm run verify:config-path-resolution-rust` runs both `resolve_rcc` and `resolve_routecodex_config_path` Rust tests.
- Verified on 2026-07-07 by pre-wire TS/native blackbox comparison, post-wire focused config blackbox, native hotpath build, root TS compile, function-map gate, minimal TS surface, rustification audit, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-07: Single-source config loader blackbox must separate legal input from runtime-materialized shapes

- `loadRouteCodexConfig()` single-source input contract still rejects `virtualrouter.providers`; do not treat that shape as a legal pre-wire compatibility target for this loader entrypoint.
- Valid pre-wire compatibility targets for the single-source loader include real `config.toml` routing/group/httpserver shapes plus explicit external provider-root resolution through `ROUTECODEX_PROVIDER_DIR` / `RCC_PROVIDER_DIR`.
- If a blackbox fixture only passes by injecting `virtualrouter.providers` into loader input, that is the wrong contract for this entrypoint. Move that check to the runtime/bootstrap/materialized-config owner instead of weakening the loader.
- Verified on 2026-07-07 by adding a `ROUTECODEX_PROVIDER_DIR` blackbox to `tests/config/routecodex-config-loader.v2-single-source.spec.ts` and a materialized-provider precedence blackbox to `tests/config/runtime-config-materialization-rust.spec.ts`; together with runtime bootstrap/provider loader specs, 4 suites / 35 tests passed without wiring or live restart.

# 2026-07-07: apply_patch live replay closure requires route and SSE projection evidence

- Unique marker: `routecodex-apply-patch-live-replay-20260707-124719881`.
- Verified live replay on global release `routecodex/rcc 0.90.3643` after release install and managed restart: `/opt/homebrew/bin/rcc --version`, `/Users/fanzhang/.local/bin/rcc --version`, both install `current/package.json` files, and `/health` on 5555/5520/4444/10000 all reported `0.90.3643`.
- Live apply_patch replay against `http://127.0.0.1:5555/v1/responses` passed with `eventCount=11`, `customInputCount=3`, `functionArgumentPatchLeakCount=0`, `deltaStreamCount=0`, and preserved raw patch text in client-visible `custom_tool_call.input`.
- Live log evidence for request `openai-responses-router-gpt-5.5-20260707T124719881-472008-124`: `[virtual-router-hit] ... tools/gateway-priority-5555-priority-tools -> minimax[key1].MiniMax-M2.7 reason=tools:apply_patch-tool-choice`.
- Guard rule: explicit `/v1/responses` `tool_choice:{type:"custom",name:"apply_patch"}` is a Rust Virtual Router `tools` route signal, and Responses SSE projection must normalize `response.created`, `response.in_progress`, terminal `response.completed`, and `response.done`; helper-only projection tests are insufficient.

# 2026-07-07: Provider cooldown persistence is forbidden

- Supersedes earlier 2026-07-04 guidance about importing, pruning, or cleaning persisted provider cooldown. Provider cooldown / availability truth must be process-local only in Rust `ProviderHealthManager`.
- Restart must clear all provider cooldown by construction. Code must not read, write, import, export, prune, or preserve `provider-health.json`, `providerCooldowns`, `VirtualRouterHealthSnapshot`, `loadInitialSnapshot`, or `persistSnapshot` for provider health.
- TS `HealthManagerModule` may append provider-error diagnostic events, but must not persist or restore provider health/cooldown snapshots. Old provider-health files may exist only as red-test fixtures proving stale disk state is ignored.
- Required verification: Rust selection/preselected-route tests ignore stale persisted cooldown, provider-error tests prove in-memory cooldown still works without files, blackbox scans find no `provider-health.json`, and architecture gate forbids cooldown persistence symbols in production source.
- Verified live on 2026-07-07 with release/global `routecodex/rcc 0.90.3649`: `verify:provider-failure-ban-blackbox` passed with `providerHealthFiles: []` and restart primary retry; `/health` on 4444/5520/5555/10000 all reported `0.90.3649`; `find ~/.rcc -name provider-health.json` returned no files; 5520 status showed `55ai.1.gpt-5.5` healthy with no cooldown.
- 5520 route truth after this fix: thinking/coding/longcontext first select `fwd.free.gpt-5.5 -> cc.key1.gpt-5.5`; paid order is `asxs.crsa -> asxs.crsb -> 55ai -> 1token`, so 55AI is only reached after free CC and preceding paid ASXS targets are unavailable/failed for the current request.

# 2026-07-07: Config single-file text decode is Rust-owned

- `config.user_config_codec` and `config.provider_config_codec` decode TOML text through Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_file_codec.rs`.
- TS `src/config/user-config-codec.ts` and `src/config/provider-config-codec.ts` may keep TOML path rejection, Node file IO, injected `fsImpl` sync support, types, and return shape only; they must call `decodeRouteCodexUserConfigTextSync` / `decodeRouteCodexProviderConfigTextSync` for parse semantics.
- Do not reintroduce TS `parseTomlRecord` + `isRecord` fallback into user/provider config codecs; blackbox parity must be established before wiring new config codec Rust surfaces.
- Verified on 2026-07-07 with Rust `config_file_codec` tests (5), native hotpath build, pre-wire and post-wire config codec Jest, broader config matrix PASS output (14 suites / 106 tests, open handle interrupted after PASS), root TS compile, function-map gate, minimal TS surface gate, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-07: AuthFile resolution planning is Rust-owned

- `config.path_resolution_surface` owns `authfile-*` literal-vs-file planning through Rust `plan_auth_file_resolution_for_host` and NAPI `planAuthFileResolutionJson`.
- TS `src/config/auth-file-resolver.ts` may keep only host file IO (`fs.readFile`), returned secret trimming, and in-process cache execution. It must not reimplement `authfile-` detection, suffix extraction, authDir/default RCC auth path planning, or cache key planning.
- AuthFile Rust parity must preserve old TS `startsWith('authfile-')` semantics exactly: leading/trailing whitespace means literal, not authfile; `authfile-` with empty suffix resolves to `path.join(authDir, '')`.
- Verified on 2026-07-07 with Rust authfile plan tests (4), native hotpath build with required export check, pre-wire Jest parity, post-wire AuthFile read/cache blackbox (2 suites / 11 tests), root TypeScript, targeted rustfmt checks for touched Rust files, function-map gate, minimal TS surface gate, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-07: RouteCodex runtime config loader is Rust-owned

- `src/config/routecodex-config-loader.ts` is now a native host-env shell only. It must not read config files, parse TOML, call `resolveRouteCodexConfigPath`, call user/provider config parsers, load provider roots, or call `materializeRouteCodexConfig` directly.
- Rust `config_file_codec::load_routecodex_config_json` owns runtime config loading orchestration: config path resolution, TOML file read/decode, v2 source normalization/validation, provider config selection/root loading, runtime manifest compile, manifest-to-userConfig materialization, and provider profile projection.
- Native loader input must pass explicit JS env snapshots. In particular, default provider root must resolve from `RCC_HOME` / `ROUTECODEX_USER_DIR` / `ROUTECODEX_HOME` to `<rcc_user_dir>/provider`; do not rely on Rust process env or `plan_provider_config_root_for_host(None)` for this path.
- Wiring rule: expose native loader and prove pre-wire TS/native blackbox parity on temp fixtures before replacing the TS loader. Existing real `~/.rcc/config.toml` and provider `config.v2.toml` shapes are compatibility samples; do not edit them to make new Rust code pass.
- Verified on 2026-07-07 with pre-wire parity Jest (2 suites / 14 tests), post-wire focused Jest (6 suites / 51 tests), Rust `config_file_codec` (5) and `runtime_config_materialization` (8), native hotpath build, root TypeScript, function-map gate, config path/TOML/provider codec Rust gates, minimal TS surface (`nonNativeFileCount=10`, `nonNativeLocTotal=2437`), rustification audit, and diff check. No managed live restart/replay or `~/.rcc` edits were performed.

# 2026-07-07: Hub Pipeline zero-TS audit snapshot

- Unique marker: `hub-zero-ts-audit-20260707-current-surface`.
- Hub semantic mainlines are Rust-owned/anchored for request, response, servertool hook skeleton, and Responses continuation. Current audit gates passed: `verify:llmswitch-minimal-ts-surface -- --json`, `verify:llmswitch-rustification-audit -- --json`, `verify:architecture-thin-wrapper-only`, `verify:function-map-compile-gate`, `verify:servertool-rust-only`, and `verify:architecture-ts-owner-ban`.
- Current minimal TS truth: 13 allowed entries, 10 current non-native prod TS files, 3 explicit native-linked TS shells; rustification audit metrics are `prodTsFileCount=133`, `prodTsLocTotal=27445`, `nonNativeFileCount=10`, `nonNativeLocTotal=2437`.
- Remaining Hub-adjacent TS is host surface, not Hub business semantic owner: Node Readable/SSE IO in `provider-response.ts`, Map/FS/timer persistence in `responses-conversation-store.ts`, diagnostics in `hub-stage-timing.ts`, type declarations, and native binding wrappers.
- Literal zero `.ts` for Hub Pipeline requires replacing host IO/store/lifecycle and public TS type/binding surfaces with Rust-backed/generated equivalents; otherwise "zero TS" should mean zero TS semantic owners, enforced by the existing minimal-surface, rustification, thin-wrapper, function-map, and servertool Rust-only gates.

# 2026-07-07: Hub Pipeline pure-Rust closeout is reference-shrink driven

- `docs/goals/hub-pipeline-zero-ts-closeout-plan.md` is the current closeout plan for literal Hub Pipeline zero TS. It now treats thin TS IO/type shells as intermediate blockers, not final acceptance.
- The first deletion blockers are public/runtime reference locks, not missing Hub semantics: `sharedmodule/llmswitch-core/src/index.ts`, `src/types/llmswitch-core.d.ts`, `scripts/lib/build-core-utils.mjs`, `src/modules/llmswitch/bridge/response-converter.ts`, `src/modules/llmswitch/bridge/state-integrations.ts`, and `responses.continuation.mainline` edge `rct-06`.
- Reference-shrink order: public API/dist surface -> provider response IO facade -> Responses continuation store -> Hub/VR/servertool type shells -> diagnostics/stats -> separate non-Hub runtime lifecycle (`runtime/user-data-paths.ts`).
- Verified on 2026-07-07 after updating the plan: `git diff --check -- docs/goals/hub-pipeline-zero-ts-closeout-plan.md` PASS; `npm run verify:llmswitch-minimal-ts-surface -- --json` PASS (`entries=13`, `non-native=10`, `native-linked=3`); `npm run verify:llmswitch-rustification-audit -- --json` PASS (`prodTsFileCount=133`, `prodTsLocTotal=27445`, `nonNativeFileCount=10`, `nonNativeLocTotal=2437`); `npm run verify:function-map-compile-gate` PASS.

# 2026-07-07: VR/Hub config runtime artifact truth is Rust-owned

- Rust `RouteCodexRuntimeManifest` is the config-to-runtime truth for both `VR <- config` and `Hub Pipeline <- config`.
- `virtualRouterBootstrapInput` is the only config artifact passed into VR bootstrap; `pipelineRuntimeConfig` is the only config artifact passed into Hub runtime policy helpers.
- Router-port `allowedProviders`, ErrorErr05/default-pool route availability tiers, and primary-exhausted route tiers must read `pipelineRuntimeConfig.routingProviderIds` / `pipelineRuntimeConfig.routingTiersByRoute`, not `server.userConfig.virtualrouter.routingPolicyGroups`.
- `src/index.ts` must not validate or count old `virtualrouter.routing`; Rust loader/materializer owns config validation and rejects invalid v2/default route shapes.
- Grep gate `tests/grep/config-codec-gate.spec.ts` blocks old TS helpers `extractProviderKeysForRoutingGroup`, `extractRoutingTiersForRoutingGroupRoute`, and old startup `virtualrouter.routing` validation/log strings.
- Verified on 2026-07-07 with Rust `runtime_config_materialization` and `config_file_codec` tests, native hotpath build, root TS compile, focused config/http-server Jest, function-map compile gate, architecture mainline-call-map gate, minimal TS surface, rustification audit, and diff check. No live restart and no real `~/.rcc` config/provider edits were performed.

# 2026-07-07: Servertool/Hub TS boundary coupling is closed

- Servertool must not import Hub TS type/timing/MetadataCenter writer files. `servertool/types.ts` owns local boundary type aliases, and `servertool/metadata-center-carrier.ts` owns only servertool-local MetadataCenter symbol/read/write IO plus Rust/native stop-gateway helpers.
- Hub must not import `servertool/metadata-center-carrier.ts`. Hub-side bound MetadataCenter readers live in `sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts`.
- `response-stage-orchestration-shell.ts` may remain as the single allowed servertool IO entrypoint consumed by Hub provider response, but it must consume Rust/native response-stage plans and local diagnostic IO only; it must not import Hub `recordStage`, `hub-stage-timing`, or Hub type files.
- Gate: `npm run verify:servertool-rust-only` includes `servertool-hub-boundary-rust-owned`, forbidding servertool `../conversion/hub/**` imports and Hub imports from `servertool/metadata-center-carrier`.
- Verified on 2026-07-07 with zero servertool `../conversion/hub` source imports, focused servertool Jest (3 suites / 52 tests), `cargo test -p servertool-core` (373 tests), `cargo test -p router-hotpath-napi servertool --lib` (168 tests, 2086 filtered), `verify:servertool-rust-only`, llmswitch/root TypeScript, function-map gate, architecture mainline-call-map gate, minimal TS surface, rustification audit, and diff check. No live restart/replay was performed because this slice changed TS boundary imports/types/diagnostic IO, not live runtime config or provider behavior.

# 2026-07-07: Servertool routing instruction state bridge is native-owned

- Routing instruction persistence-key, empty-state, and sync-save decisions belong to Rust `routing_state_store.rs`; `native-virtual-router-routing-state.ts` may only call NAPI capabilities and execute store IO.
- `shouldSaveRoutingInstructionStateSyncJson` is the native owner for session/tmux synchronous save selection; do not reintroduce TS `key.startsWith('session:') || key.startsWith('tmux:')` logic.
- `verify:servertool-rust-only` includes `servertool-routing-instruction-state-native-only` to block TS reimplementation of persistent-key, empty-state, and sync-save markers.
- StopMessage routing instructions must preserve `stopMessageAiMode` through Rust parse, NAPI serialize/deserialize, and state apply. `resolveRccUserDir` must pass JS env snapshots into Rust because Jest/VM env overrides are not reliable through Rust process env alone.
- Verified on 2026-07-07 with focused Rust routing-state and stopMessage tests, native hotpath build, `tests/servertool/routing-instructions.spec.ts` (38 passed, 9 skipped), `cargo test -p servertool-core`, `cargo test -p router-hotpath-napi servertool --lib`, `verify:servertool-rust-only`, llmswitch/root TypeScript, function-map/mainline gates, minimal TS surface, rustification audit, and diff check. No live restart/replay or real `~/.rcc` edits were performed.

- 2026-06-29: servertool 完整 Rust 化目标已升级为“薄 TS 壳也要物理拆掉”，不能再把 thin shell 当终态。第一刀已删除 `sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`，运行时与测试改为直接使用 `execution-queue-shell.ts`；`verify-servertool-rust-only` / active audit 改为锁旧 facade 物理缺失。
- 2026-06-29: 该 dispatch facade 删除 slice 已验证 root `tsc`、focused Jest 40/40、scoped `git diff --check`；全量 `verify:servertool-rust-only` 当前因既有 dirty `backend_route_contract.rs` 缺失与 `outcome_contract.rs` backend-route marker 不一致失败，不属于 dispatch facade slice。
# 2026-07-08 log color session identity truth

- Verified RouteCodex log color rule: when a request carries `sessionId` plus tmux/log aliases, all request/response/usage/virtual-router-hit coloring must derive from `sessionId` first. `clientTmuxSessionId` / `tmuxSessionId` / RCC tmux aliases are only fallback keys when request `sessionId`, `conversationId`, and `logSessionColorKey` are absent.
- Red evidence: `tests/sharedmodule/virtual-router-hit-log.spec.ts` previously returned `tmux-session-stable` for `{ sessionId: 'request-session-a', clientTmuxSessionId: 'tmux-session-stable' }`.
- Green/live evidence: release `0.90.3653` installed globally; `/health` on port 5520 reported `version=0.90.3653`; installed runtime smoke resolved mixed color metadata to `request-session-live` and formatted `[virtual-router-hit]` with that same session color.

# 2026-07-08 log color failed-response closeout

- Additional root cause for remaining three-color screenshots: `colorizeRequestLog(..., { isError: true })` still forced `❌ failed` response logs to red even after request/VR/usage session color was registered. Old request-start/request-log tests also still contained tmux-first expectations, so the gate did not lock Jason's latest requirement.
- Fix: failed response logs now use the registered request/session color when available; red is only a no-session fallback. Request-start/request-log/usage tests now assert `sessionId` color wins and tmux/route/red colors do not win for registered session logs.
- Verified and installed: focused Jest 49/49 PASS; root TypeScript PASS; `verify:function-map-compile-gate` PASS; `verify:architecture-mainline-call-map` PASS; `verify:vr-no-ts-runtime` PASS; `verify:llmswitch-rustification-audit` PASS; `build:base` PASS; release snapshot installed as global `routecodex/rcc 0.90.3654`; `rcc restart --port 5520 --host 127.0.0.1` PASS; `/health.version` on 5520 is `0.90.3654`; installed runtime smoke showed failed response and `[virtual-router-hit]` ANSI colors both equal the same session color.

# 2026-07-08 log color client_metadata session truth

- Codex `/v1/responses` session truth is top-level `body.client_metadata.session_id` / `thread_id`, not only `body.metadata` and not `turn_id`.
- Request-start-only extraction is insufficient: executor metadata must read the same data-plane `client_metadata` before VR/usage/response logging so all modules share `sessionId`, `conversationId`, and `logSessionColorKey`.
- Verified fix in global release `routecodex/rcc 0.90.3658`: focused Jest, root `tsc`, function-map/mainline gates, VR no-TS gate, llmswitch rustification audit, build, global install, managed restart, 5520/5555 health version, and installed-runtime smoke all passed; smoke confirmed request, failed response, and `[virtual-router-hit]` colors all derive from `client_metadata.session_id`.

# 2026-07-08 Hub response empty-result and direct usage model truth

- Marker: hub-response-empty-result-usage-model-20260708.
- Response-only HubPipeline lib calls such as `provider-response.ts -> executeHubPipelineJson` may legitimately run with empty `{}` routing config. Rust `HubPipelineEngine` must not initialize `VirtualRouterEngineCore` unless the config contains real VR runtime shape (`providers`, `routing`, or `forwarders`); VR facade calls without routing config should fail explicitly as `hub_pipeline_virtual_router_facade_unavailable`.
- Native TS wrappers must preserve non-string native return/Error object messages. Collapsing a native Error object into `empty result` hides the real Rust error and prevents correct live diagnosis.
- Router-direct usage model truth is two-field: `usageLogInfo.requestModel` is the client alias/model, and `usageLogInfo.model` is the provider target model after direct-route hooks. Usage rendering should show `requestModel->providerModel`, e.g. `gpt-5.4->gpt-5.5`, not `-->gpt-5.4` after client response model restore.
- Verified in global release `routecodex/rcc 0.90.3666`: Rust hub_pipeline_lib PASS 67, native hotpath build PASS, focused Jest provider-response/API PASS 24, direct-result/usage logger PASS 39, llmswitch/root `tsc`, function-map/mainline gates, `build:base`, `install:release`, and 5520/5555 `/health` version all PASS. 5555 live `/v1/responses` smoke returned HTTP 200 with no new `executeHubPipelineJson` / `empty result` / `routing configuration missing` logs; 5520 live response showed client model `gpt-5.4` and provider `resolved_model_used=gpt-5.5`, while installed release direct-result/logger smoke rendered `model=gpt-5.4->gpt-5.5`.

# 2026-07-08 HubPipeline type shell blocker was stale

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts` was no longer a true Rust-generated-declaration blocker. Current source had already moved runtime/host bridge types into `hub-pipeline.ts` as record-shaped native shell types, and the deleted file only exported zero-consumer `ProviderProtocol`.
- The remaining test-only `StageRecorder` import belonged to the adjacent servertool boundary owner, `sharedmodule/llmswitch-core/src/servertool/types.ts`.
- The file was physically deleted, removed from `docs/loops/rustification/minimal-ts-surface.json`, and locked by residue tests requiring the old type shell to stay absent and not be re-exported.
- Verification: the new residue test failed while the stale file existed; after deletion, focused residue/provider Jest passed 212 tests, sharedmodule/root TypeScript passed, `verify:llmswitch-minimal-ts-surface -- --json` passed with `entries=12`, `current non-native prod TS files=9`, `explicit native-linked TS shells=3`, `verify:llmswitch-rustification-audit -- --json` passed with `prodTsFileCount=122`, `prodTsLocTotal=27304`, `nonNativeFileCount=9`, `nonNativeLocTotal=2427`, function-map/mainline gates passed, llmswitch-core package build passed, and `git diff --check` passed.

# 2026-07-08 log color session collision closeout

- Screenshot symptom after sessionId extraction fixes: different visible sessions/ports such as 5520 and 5555 could still render the same color.
- Root cause: Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_hit_log.rs` used a fixed 22-color session palette, so distinct session IDs could hash into the same ANSI bucket. Red proof: `active-session-color-2` and `active-session-color-3` both resolved to `\x1b[94m`.
- Fix commit `753fd79c2`: removed the fixed palette and made Rust `resolve_session_color` generate deterministic truecolor ANSI from the sessionId hash. Same session stays stable, different active sessions are no longer compressed into the small palette, and TS remains a native facade rather than a color owner.
- Verification: Rust red/green unit `session_color_is_stable_and_not_palette_bucket_colliding`; focused Jest `tests/sharedmodule/virtual-router-hit-log.spec.ts`; request-log focused Jest; `npm run build:native-hotpath`; llmswitch/root TypeScript; function-map and mainline gates; `verify:vr-no-ts-runtime`; `verify:llmswitch-rustification-audit`; `build:base`; release install `routecodex/rcc 0.90.3673`; 5520/5555 `/health` ready/version 0.90.3673; installed-runtime smoke proved `port-5520-session-smoke` and `port-5555-session-smoke` produce different truecolor ANSI and their VR hit lines start with the matching session color.
# 2026-07-08: Server-side servertool runtime bridge is retired

- Server-side servertool runtime execution is removed. `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts`, engine/queue/stage/progress/runtime shell files, and their obsolete tests are deleted and locked by `scripts/verify-servertool-rust-only.mjs`.
- `provider-response.ts` must not execute or project server-side servertool runtime actions. Rust `servertoolRuntimeActions` must be present as an array; non-empty actions are unsupported and fail fast with the explicit “server-side tool execution has been removed” error. CLI-owned tools must be projected by Rust before client projection.
- Rust/NAPI exports for provider-response servertool runtime-action planning and post-servertool client projection are retired. Do not restore `planProviderResponseServertoolRuntimeActionsJson`, `resolveProviderResponsePostServertoolEffectJson`, `projectPostServertoolHubRespOutbound04ClientSemanticJson`, or the corresponding Rust helper exports.
- Mainline truth: `servertool.hook_skeleton.mainline` has no server-side followup/reenter runtime-action edges; response hook flow goes from hook response injection to projection finalization, and server-side dead business must stay physically absent.
- Verified source/build closure on 2026-07-08 with servertool rust-only gate, sharedmodule/root TypeScript, focused provider-response/servertool Jest, Rust hub pipeline/resp outbound tests, native hotpath build, function-map/mainline/manifest/wiki gates, minimal TS surface, rustification audit, build:base, apply-patch freeform contract, and diff check. No live restart/replay was claimed for this slice.

# 2026-07-08: llmswitch-core minimal TS surface is closed to zero

- `docs/loops/rustification/minimal-ts-surface.json` is now empty for llmswitch-core closeout. The former 12 remaining `sharedmodule/llmswitch-core/src` hand-authored TS surfaces are removed or converted out of production TS: provider-response, responses conversation store, user-data paths, stats center, hub stage timing, hub pipeline facade, native router policy facade, Hub type shells, VR contract shell, and servertool type shell.
- Zero-TS truth is guarded by `scripts/ci/verify-llmswitch-zero-ts-closeout.mjs`, `verify:llmswitch-minimal-ts-surface`, and `verify:llmswitch-rustification-audit`; required current metrics are `entries=0`, `current non-native prod TS files=0`, `explicit native-linked TS shells=0`, `nonNativeFileCount=0`, and `nonNativeLocTotal=0`.
- Old llmswitch-core package scripts/tests must not import deleted `dist/conversion/hub/**` or old `router/virtual-router/**` TS surfaces. VR package tests must use native APIs and explicit `metadataCenterSnapshot`, not JS `quotaView`, TS dependency injection, or weights-only synthesized-pool behavior.
- Source/build closeout was verified with zero-TS gates, servertool rust-only gate, sharedmodule/root TypeScript, architecture review/function/mainline/manifest gates, Hub module blackbox, VR direct/health/pool scripts, focused provider-response/responses-store/hub residue Jest, native hotpath build, build:base, diff check, and targeted stale import scan. No live restart/replay was claimed for this static/source closeout.
- Follow-up lock: `verify:llmswitch-zero-ts-closeout` must be reachable as an npm script, not only a bare node script. Server runtime HubPipeline handles are native string handles only; do not restore object facades with `getVirtualRouter()`. Route/status/diagnose calls should use Rust native functions directly from the handle, and tests must install matching `pipelineRuntimeConfigByRoutingPolicyGroup` instead of relying on deleted facade objects.
# 2026-07-09: 5555 router-direct VR hit log session carrier

- 5555 `/v1/responses` can fail before provider send if router-direct route metadata reaches native VR hit logging without a session color carrier: `[virtual-router-hit-log] native formatVirtualRouterHitJson failed: virtual-router-hit sessionId is required`.
- Correct owner boundary: do not relax Rust `formatVirtualRouterHitJson`; server router-direct must provide `logSessionColorKey` before `routeHubPipelineVirtualRouterNative`. For raw/no-session requests, synthesize only log carrier `rcc-session:request:<requestId>` and keep semantic `sessionId`/`conversationId` unset.
- Fix commit `26331ff97`: router-direct/router-relay preselection call `buildInboundLogSessionContext`; handlers pass requestId to handler log metadata; MetadataCenter transport snapshots carry runtime control such as providerProtocol into native Hub/response bridge.
- Verified in global installed `routecodex/rcc 0.90.3678`: focused red/green Jest, root TS compile, function-map/mainline gates, `verify:vr-no-ts-runtime`, install-global restart of 5555, health 5520/5555 version match, and live no-session 5555 SSE smoke HTTP 200 through `response.completed`/`[DONE]`. Logs showed VR hit `sid=rcc-session:request:openai-responses-router-gpt-5.5-20260709T003317944-480895-2744` and no matching VR session/providerProtocol/invalid-payload errors.

# 2026-07-09: llmswitch host bridge snapshot/routing-state shell refs closed

- Host bridge must not load `conversion/snapshot-utils` or `native/router-hotpath/native-virtual-router-routing-state` through llmswitch-core dist shell subpaths. `runtime-integrations.ts/js` should use direct native snapshot hook capabilities via `native-exports`, and `state-integrations.ts/js` should use direct native routing-state JSON capabilities.
- Routing instruction state host bridge direct wiring must preserve Set/Map shape by passing through native `serializeRoutingInstructionStateJson` and `deserializeRoutingInstructionStateJson`; raw `JSON.stringify(state)` is not equivalent for `allowedProviders`, `disabledProviders`, `disabledKeys`, or `disabledModels`.
- Provider response session usage planning should call `planChatProcessSessionUsageJson` through the native binding instead of importing the routing-state TS shell only for `planChatProcessSessionUsage`.
- Verified source/reference slice: bridge scan for `native/router-hotpath/native-virtual-router-routing-state|conversion/snapshot-utils` returned zero matches; focused Jest passed 216/216; strict TS shell reference audit passed with `shellsWithHostTextRefs=14`, `coreModuleSubpathRefs=30`; zero-ts, minimal TS surface, rustification audit, sharedmodule/root tsc, and diff check passed. This does not complete the broader TS shell reference closeout; provider response orchestration/shared conversion/metadata writer/SSE and routing integration shell refs remain.

# 2026-07-09: provider-response/runtime host bridge shell refs direct-native wired

- `runtime-integrations.ts/js` should not import llmswitch-core `native-sse-runtime` or `native-provider-runtime-ingress` TS shells. Host stream body collection is IO; SSE decode and provider ingress policy must use direct Rust JSON capabilities (`buildJsonFromSseJson`, `reportProviderErrorToRouterPolicyJson`, `reportProviderSuccessToRouterPolicyJson`).
- `provider-response-converter-host.ts/js` should not import llmswitch-core orchestration protocol/shared conversion/resp semantics/runtime metadata/metadata writer/routing-state/SSE runtime TS shell subpaths. The host bridge may keep stream construction and MetadataCenter symbol read/write IO, while Rust JSON capabilities own HubPipeline response execution, metadata snapshot/effect planning, runtime metadata carrier materialization, SSE frame building, response materialization, context helper resolution, and session usage planning.
- Residue tests now lock direct `resolveProviderResponseContextHelpersJson` use and forbid the old resp-semantics host subpath. Verified source/reference slice: focused Jest passed 242/242; strict TS shell reference audit passed with `shellsWithHostTextRefs=9`, `coreModuleSubpathRefs=26`; zero-ts, minimal TS surface, rustification audit, sharedmodule/root tsc, JS syntax checks, and diff check passed. Remaining host bridge shell refs are concentrated in `snapshot-recorder.ts/js`, `native-exports.ts/js`, and `routing-integrations.ts/js`.

# 2026-07-09: native-exports host bridge shell loaders closed

- `src/modules/llmswitch/bridge/native-exports.ts/js` must not load `native-shared-conversion-semantics`, `native-hub-pipeline-resp-semantics`, or `native-hub-bridge-policy-semantics` through llmswitch-core dist subpaths. These wrappers should call `router_hotpath_napi` JSON capabilities directly.
- `planResponsesHandlerEntryJson` is a mixed-signature NAPI export: first arg is JSON payload string, second/third args are optional raw endpoint/path strings. Do not route it through a helper that JSON-encodes every argument.
- Verified source/reference slice: exact native-exports scan returned zero old loader/subpath matches; focused Jest passed 207/207; strict TS shell reference audit passed with `shellsWithHostTextRefs=6`, `coreModuleSubpathRefs=16`; zero-ts, minimal TS surface, rustification audit, sharedmodule/root tsc, JS syntax check, and diff check passed. Remaining host bridge refs are in `snapshot-recorder.ts/js` and `routing-integrations.ts/js`.

# 2026-07-09: routing-integrations host bridge shell refs closed

- `src/modules/llmswitch/bridge/routing-integrations.ts/js` must not load llmswitch-core `native-hub-pipeline-orchestration-semantics`, `native-virtual-router-bootstrap-config`, or `runtime/virtual-router-host-effects` dist subpaths. HubPipeline/VR bootstrap should call direct `router_hotpath_napi` binding functions.
- Route host effects may remain in the host bridge only as IO/object mutation: console log emission and request in-place marker cleanup. Semantic pieces must stay Rust NAPI-owned: routing instruction kind parse, stop scope resolution, marker parse log, clean marker plan, session color key, VR hit record/format, stop status label, and `rccUserDir` resolution.
- Verified source/reference slice: exact routing scan returned zero old subpath matches; focused Jest passed 210/210; strict TS shell reference audit passed with `shellsWithHostTextRefs=3`, `coreModuleSubpathRefs=10`; zero-ts, minimal TS surface, rustification audit, sharedmodule/root tsc, JS syntax check, and diff check passed. The remaining host bridge shell subpath refs are `snapshot-recorder.ts/js -> conversion/hub/snapshot-recorder`.

# 2026-07-09: snapshot-recorder host bridge refs closed

- `src/modules/llmswitch/bridge/snapshot-recorder.ts/js` must not load the llmswitch-core snapshot recorder dist facade. The host bridge owns only base recorder IO, MetadataCenter snapshot reading, and local errorsample observation; snapshot stage normalization, write-option planning, should-record policy, and write execution must call direct Rust NAPI snapshot hook capabilities.
- Verified source/reference slice: exact snapshot bridge scan returned zero old facade loader/import/cache matches; focused Jest passed 192/192; strict TS shell reference audit passed with `host=[]`, `shellsWithHostTextRefs=2`, `coreModuleSubpathRefs=8`; zero-ts, minimal TS surface, rustification audit, sharedmodule/root tsc, JS syntax check, and diff check passed.
# 2026-07-09: llmswitch TS shell reference closeout loaders and zero-import facade deletion

- `src/modules/llmswitch/bridge/module-loader.ts/js` should remain path-resolution-only. Do not restore `importCoreDist`, `requireCoreDist`, node require creation, Jest runtime shell loading, or TS source-prefer behavior.
- `src/modules/llmswitch/core-loader.ts/js` should remain single-implementation core dist loading. The dead `engine` family, `rcc-llmswitch-engine`, Jest source-prefer loading, and builtin TS source fallback were removed in commit `37fad4d`; `importCoreModule` should fail explicitly on missing dist instead of loading source TS.
- `src/modules/llmswitch/bridge/responses-response-bridge.ts/js` must not export `importResponsesHandlerCoreDist` / `requireResponsesHandlerCoreDist` or load `conversion/responses/responses-openai-bridge`. JSON chat-completion normalization uses direct native `buildResponsesPayloadFromChatNative`.
- Zero-production-import facades `sharedmodule/llmswitch-core/src/conversion/compaction-detect.ts`, `sharedmodule/llmswitch-core/src/conversion/mcp-injection.ts`, and `sharedmodule/llmswitch-core/src/conversion/shared/tooling.ts` are physically deleted and locked by residue audit in commit `1705127`.
- SSE wrapper files `native-chat-sse-event-payload.ts`, `native-anthropic-sse-event-payload.ts`, and `native-gemini-sse-event-payload.ts` are physically deleted in commit `f08420d` after function/verification maps and tests moved to direct `router_hotpath_napi.node` evidence. Residue audit must keep these paths absent and must not restore `build(Chat|Anthropic|Gemini)SseEventSequenceWithNative` wrapper ownership for this surface.
- Responses SSE wrapper file `native-responses-sse-event-payload.ts` is physically deleted in commit `b9e3e98` after descriptor/metadata/reasoning tests moved to direct `router_hotpath_napi.node` evidence via test-only helper `tests/sharedmodule/helpers/responses-sse-direct-native.ts`. The helper is not a runtime owner; residue audit must keep the old wrapper path absent and not restore `buildResponsesSse*WithNative` / `normalizeResponsesSseReasoningSummaryWithNative` wrapper ownership.
- Session identifier wrapper file `native-hub-pipeline-session-identifiers-semantics.ts` is physically deleted after tests moved to direct `router_hotpath_napi.node` `extractSessionIdentifiersJson` evidence. Keep session header parsing Rust-internal; do not restore `extractSessionIdentifiersFromMetadataWithNative` or public `coerceClientHeaders*` / `findHeaderValue*` / `pickHeader*` / `normalizeHeaderKey*` NAPI helper surfaces.
- Stop-message auto wrapper file `native-stop-message-auto-semantics.ts` is physically deleted after stopmessage decision/schema tests moved to direct `router_hotpath_napi.node` `decideStopMessageAction` and `evaluateStopSchemaGateJson` evidence via test-only helper `tests/servertool/helpers/stop-message-direct-native.ts`. Do not restore `decideStopMessageActionWithNative` / `evaluateStopSchemaGateWithNative` as runtime TS wrapper exports.
- Req-process wrapper file `native-hub-pipeline-req-process-semantics.ts` is physically deleted after req-process servertool bundle tests moved to direct `router_hotpath_napi.node` `applyReqProcessToolGovernanceJson` evidence via test-only helper `tests/sharedmodule/helpers/req-process-direct-native.ts`. Do not restore `applyReqProcessToolGovernanceWithNative` as a runtime TS wrapper export.
- `native-virtual-router-bootstrap-providers.ts` is a zero-production-import wrapper but not a safe physical deletion target yet: direct Rust NAPI currently does not satisfy the existing provider auth-alias regression expectations. Reconcile the Rust bootstrap contract/tests before deleting this wrapper.

# 2026-07-09: Servertool MetadataCenter carrier shell is retired

- `sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts` is physically deleted. Do not restore servertool-local MetadataCenter direct-write facades such as `attachStopGatewayContext`, `attachStopMessageCompareContext`, `readStopMessageCompareContext`, or `writeRuntimeControlToBoundMetadataCenter`.
- Stop-gateway/stop-message compare evidence should use direct Rust/native exports plus the server HTTP `MetadataCenter` API; request-scoped metadata writes remain behind the unified metadata center API/runtime-control writer surface.
- `verify:metadata-center-dualwrite-api`, metadata-center manifest/write-boundary gates, residue tests, and release-install verifier no longer preserve the deleted dist subpath. Current llmswitch shell audit metric after this deletion is `prodTsShellCount=86`, with `nonNativeFileCount=0`.

# 2026-07-09: Guidance public TS shell is retired

- `sharedmodule/llmswitch-core/src/guidance/index.ts` is physically deleted, and package exports `./guidance` / `./v2/guidance` are removed. Tool guidance truth remains Rust/NAPI exports such as `buildSystemToolGuidanceJson`, `augmentOpenAIToolsJson`, and `augmentAnthropicToolsJson`.
- Tests that need guidance evidence should call direct native helper code, not recreate the public TS shell or package subpath.
- Current llmswitch shell audit metric after this deletion is `prodTsShellCount=85`, with `nonNativeFileCount=0`.

# 2026-07-09: Text markup normalizer TS shells are retired

- `sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.ts` and `sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer/normalize.ts` are physically deleted. Do not restore them as public `conversion/shared/text-markup-normalizer` subpaths.
- Text tool-call extraction and assistant-text normalization truth remains Rust/NAPI (`extract*Tool*FromTextJson`, `normalizeAssistantTextToToolCallsJson`). Tests should call direct native helper code; host scripts should use the host bridge native export.
- Current llmswitch shell audit metric after this deletion is `prodTsShellCount=83`, `shellsWithProdImporters=69`, with `nonNativeFileCount=0`.

# 2026-07-09: Hub runtime ingress aggregate TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts` is physically deleted. Do not restore it as an aggregate runtime ingress wrapper or mock target.
- `hub.runtime_ingress_bridge` owner is now `src/modules/llmswitch/bridge/routing-integrations.ts` plus Rust `hub_pipeline_engine`; host bridge tests should mock `native-exports.getRouterHotpathJsonBindingSync()` / direct `router_hotpath_napi` capabilities, not the retired sharedmodule wrapper.
- `routing-integrations.ts/js` should reuse the single host native binding loader from `native-exports`; do not reintroduce a second local native `.node` loader for HubPipeline handle calls.
- Current shell audit after this deletion is `prodTsShellCount=77`, `shellsWithProdImporters=65`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Hub metadata-policy parser TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-metadata-policy.ts` is physically deleted. Do not restore `resolveStopMessageRouterMetadataWithNative` or its wrapper-local parser/logging behavior as a runtime TS shell.
- Tests should lock the path as absent; parser observability should not keep retired zero-consumer wrappers alive.
- Current shell audit after this deletion is `prodTsShellCount=76`, `shellsWithProdImporters=65`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Hub builders TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-builders.ts` is physically deleted. Do not restore `buildRouterMetadataInputWithNative` or `coerceStandardizedRequestFromPayloadWithNative` as runtime TS wrapper exports.
- Tests/scripts needing these semantics should call direct Rust/NAPI capabilities `buildRouterMetadataInputJson` and `coerceStandardizedRequestFromPayloadJson`.
- Current shell audit after this deletion is `prodTsShellCount=75`, `shellsWithProdImporters=65`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: VR provider bootstrap TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-providers.ts` is physically deleted. Do not restore `bootstrapProvidersWithNative` or the provider bootstrap TS facade.
- Tests needing provider bootstrap evidence should call direct Rust/NAPI `bootstrapVirtualRouterProvidersJson`.
- Rust `provider_bootstrap.rs` owns auth alias materialization, including `tokenFile` / `token_file`; token files count as effective auth material and must not trigger placeholder `secretRef` generation.
- Current shell audit after this deletion is `prodTsShellCount=61`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: OpenAI codec TS shell is retired

- `sharedmodule/llmswitch-core/src/conversion/codecs/openai-openai-codec.ts` is physically deleted. Do not restore `OpenAIOpenAIConversionCodec` or the wrapper-local request context map as runtime TS state.
- Tests/scripts needing OpenAI<->OpenAI codec evidence should call direct Rust/NAPI `runOpenaiOpenaiRequestCodecJson` and `runOpenaiOpenaiResponseCodecJson`.
- Current shell audit after this deletion is `prodTsShellCount=74`, `shellsWithProdImporters=65`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: SSE public index TS shell is retired

- `sharedmodule/llmswitch-core/src/sse/index.ts` is physically deleted. Do not restore the public `sseToJson` / `jsonToSseFrames` aliases or `dist/sse/index.js` script dependency.
- Scripts/tests needing SSE conversion should call direct `router_hotpath_napi.node` helpers; do not route through public `dist/sse/index.js`.
- Current shell audit after this deletion is `prodTsShellCount=73`, `shellsWithProdImporters=64`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Native SSE runtime TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.ts` is physically deleted. Do not restore `buildJsonFromSseWithNative` / `buildSseFramesFromJsonWithNative` / `collectSseBodyText` as a sharedmodule runtime wrapper surface.
- Script evidence uses `scripts/helpers/sse-direct-native.mjs`; test evidence uses `tests/sharedmodule/helpers/sse-direct-native.ts`; both load `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node` and call `buildSseFramesFromJsonJson` / `buildJsonFromSseJson` directly.
- Runtime ownership remains Rust `sse_runtime_dispatch.rs`; host IO callsites are `src/modules/llmswitch/bridge/provider-response-converter-host.ts` for JSON->SSE frames and `src/modules/llmswitch/bridge/runtime-integrations.ts` for SSE->JSON body collection/materialization.
- Current shell audit after this deletion is `prodTsShellCount=72`, `shellsWithProdImporters=64`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Req outbound aggregate TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts` is physically deleted. Do not restore `runReqOutboundStage3CompatWithNative`, `runRespInboundStage3CompatWithNative`, `buildNativeReqOutboundCompatAdapterContextWithNative`, `standardizedToChatEnvelopeWithNative`, or `applyClaudeThinkingToolSchemaCompatWithNative` as sharedmodule runtime wrapper exports.
- Tests needing req_outbound compat or standardized->chat envelope evidence should call direct `router_hotpath_napi.node` exports through test-only helpers. Current direct exports are `buildNativeReqOutboundCompatAdapterContextJson`, `runReqOutboundStage3CompatJson`, `runRespInboundStage3CompatJson`, and `standardizedToChatEnvelopeJson`.
- Req-05 mainline owner is Rust `hub_pipeline_lib/engine.rs::execute` -> `req_outbound_stage3_compat::run_req_outbound_stage3_compat`; JSON NAPI entrypoints are evidence surfaces, not runtime TS owners.
- Chat semantics tests using Rust HubPipeline must provide explicit minimal Virtual Router config, default provider route, and `metadataCenterSnapshot.runtimeControl.providerProtocol`; Rust VR correctly fail-fasts on missing routing config, missing metadataCenterSnapshot, or empty provider pool.
- Current shell audit after this deletion is `prodTsShellCount=71`, `shellsWithProdImporters=64`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Anthropic OpenAI codec TS shell is retired

- `sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts` is physically deleted. Do not restore `AnthropicOpenAIConversionCodec`, `buildOpenAIChatFromAnthropic`, `buildAnthropicRequestFromOpenAIChat`, or wrapper-local context map state as runtime TS ownership.
- Tests/scripts needing Anthropic<->OpenAI codec evidence should call direct Rust/NAPI exports through helper code. Current direct exports are `buildOpenaiChatFromAnthropicJson` and `buildAnthropicFromOpenaiChatJson`.
- Anthropic codec truth remains Rust `anthropic_openai_codec.rs`; the helper files under `tests/sharedmodule/helpers` and `scripts/helpers` are evidence/CLI glue only, not runtime owners.
- Current shell audit after this deletion is `prodTsShellCount=70`, `shellsWithProdImporters=63`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Anthropic OpenAI request helper TS shell is retired

- `sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-request.ts` is physically deleted. Do not restore it as a shared conversion TS shell for Anthropic outbound request building.
- Tests needing Anthropic image mapping or OpenAI function `tool_choice` to Anthropic `{type:"tool", name}` evidence should call direct Rust/NAPI `buildAnthropicFromOpenaiChatJson` through test-only helper code.
- The direct native helper must preserve NAPI Error object messages so fail-fast assertions continue to prove Rust error truth, for example malformed data URL image payloads.
- Current shell audit after this deletion is `prodTsShellCount=69`, `shellsWithProdImporters=63`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Gemini OpenAI codec TS shell is retired

- `sharedmodule/llmswitch-core/src/conversion/codecs/gemini-openai-codec.ts` is physically deleted. Do not restore `GeminiOpenAIConversionCodec`, `buildOpenAIChatFromGeminiRequest`, `buildOpenAIChatFromGeminiResponse`, or `buildGeminiFromOpenAIChat` as runtime TS wrapper ownership.
- Tests needing Gemini<->OpenAI codec evidence should call direct Rust/NAPI exports through helper code. Current direct exports are `runGeminiOpenaiRequestCodecJson`, `runGeminiOpenaiResponseCodecJson`, and `runGeminiFromOpenaiChatCodecJson`.
- Gemini codec truth remains Rust `gemini_openai_codec.rs`; test helpers are evidence glue only, not runtime owners.
- Current shell audit after this deletion is `prodTsShellCount=68`, `shellsWithProdImporters=63`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses OpenAI codec TS shell is retired

- `sharedmodule/llmswitch-core/src/conversion/codecs/responses-openai-codec.ts` is physically deleted. Do not restore `ResponsesOpenAIConversionCodec` or wrapper-local `ctxMap` request context state as runtime TS ownership.
- Tests needing Responses<->OpenAI codec evidence should call direct Rust/NAPI exports through helper code. Current direct exports are `runResponsesOpenaiRequestCodecJson` and `runResponsesOpenaiResponseCodecJson`.
- Responses codec request context is explicit native output from Rust `responses_openai_codec.rs`; hidden TS TTL/context maps are retired shell state, not runtime truth.
- Current shell audit after this deletion is `prodTsShellCount=67`, `shellsWithProdImporters=62`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Native compat action aggregate TS shell is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-compat-action-semantics.ts` is physically deleted. Do not restore it as an aggregate native wrapper or broad compat-action TS call surface.
- Deleted-wrapper references in historical fixtures are sample text only; active source/tests/scripts/docs architecture surfaces must not reference the retired path except the absent-path residue gate.
- Current shell audit after this deletion is `prodTsShellCount=66`, `shellsWithProdImporters=62`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=8`, with `nonNativeFileCount=0`.

# 2026-07-09: Tool registry aggregate TS shell is retired

- `sharedmodule/llmswitch-core/src/tools/tool-registry.ts` is physically deleted. Do not restore the broad server-side tool registry or migrate dead validation arms for shell/update_plan/view_image/MCP resource tools.
- Remaining apply_patch and exec_command validation evidence should call direct native/test helpers or the dedicated exec-command validator, not the retired aggregate `validateToolCall` shell.
- Current shell audit after this deletion is `prodTsShellCount=65`, `shellsWithProdImporters=61`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Exec command validator TS shell is retired

- `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts` is physically deleted. Do not restore `validateExecCommandArgs` or a script/test loader for `dist/tools/exec-command/validator.js`.
- Exec command validation evidence should call direct Rust/NAPI exports: `normalizeExecCommandArgsJson` for compat/canonical argument normalization, `validateCanonicalClientToolCallJson` for canonical client tool-call shape, and `validateExecCommandGuardJson` for dangerous command/policy guard.
- `validateCanonicalClientToolCallJson` is now part of `native-router-hotpath-required-exports.ts`; missing export is a binding contract failure, not a reason to restore a TS validator shell.
- Current shell audit after this deletion is `prodTsShellCount=64`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Exec command parse/normalize TS facades are retired

- `sharedmodule/llmswitch-core/src/tools/args-json.ts` and `sharedmodule/llmswitch-core/src/tools/exec-command/normalize.ts` are physically deleted. Do not restore parse/normalize TS facades around Rust tool governance.
- Test/script evidence should call direct Rust/NAPI `parseToolArgsJsonWithArtifactRepairJson` and `normalizeExecCommandArgsJson`; helper wrappers must remain test/script glue only and must not reimplement parser or normalization semantics.
- Current shell audit after this deletion is `prodTsShellCount=62`, `shellsWithProdImporters=59`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses router-direct must not relay for tool/chat-process reasons

- Same-protocol `/v1/responses` router-direct/provider-direct is provider passthrough plus hooks only. It must not enter Hub relay because of client tools, stopless/servertool state, or chat-process needs.
- The old failure signature was `[router-direct] failed_no_relay {"reason":"responses_chat_process_requires_hub_relay"}` followed by `router-direct failed without relay`; this came from direct decision/HTTP skip handling that treated tool/chat-process semantics as Hub-relay reasons.
- Fixed source truth: Rust direct decision no longer returns `servertool_followup_requires_hub_relay` for stop-message includeDirect, and `src/server/runtime/http-server/index.ts` no longer marks `client_tools_require_hub_relay` or `stopless_servertool_requires_hub_relay` as relayable skip reasons.
- Gate truth: `verify:responses-direct-tool-shape-contract` forbids `client_tools_require_hub_relay`, `stopless_servertool_requires_hub_relay`, `responses_chat_process_requires_hub_relay`, and `servertool_followup_requires_hub_relay` from becoming router-direct Hub relay reasons again.
- Verified in global installed `routecodex/rcc 0.90.3682`: active install dist has zero matches for those four reasons, `/health` is ready on 5520/5555, and live tool-bearing `/v1/responses` samples on both ports completed with `[response] completed` and `[usage]` instead of direct-relay failure.

# 2026-07-09: Hub runtime/request bridge owner maps are Rust-owned

- `hub.runtime_ingress_bridge` owner truth is Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_engine/registry.rs`; `src/modules/llmswitch/bridge/routing-integrations.ts` is host/native-call glue only.
- `hub.request_stage_pipeline_bridge` owner truth is Rust NAPI `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`; `native-hub-pipeline-orchestration-semantics-protocol.ts` is native-call/JSON IO glue only.
- For function-map canonical builder gates, do not list Rust implementation directories in `allowed_paths` when they define the same canonical builders as the owner module. Use exact owner file in `function-map.yml`; use `verification-map.yml` for broader Rust source coverage.

# 2026-07-09: Bridge instructions TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/bridge-instructions.ts` is physically deleted. Do not restore the facade; `responses-openai-bridge.ts` should call Rust native `ensureBridgeInstructionsWithNative` directly and keep only local IO mutation glue.
- Current shell audit after this deletion is `prodTsShellCount=59`, `shellsWithProdImporters=58`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Provider protocol error TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/provider-protocol-error.ts` is physically deleted. Do not restore the facade; `responses-openai-bridge.ts` should call Rust native `buildProviderProtocolErrorWithNative` directly and construct only the JS `Error` carrier locally.
- Current shell audit after this deletion is `prodTsShellCount=58`, `shellsWithProdImporters=57`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses OpenAI bridge utils TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/utils.ts` is physically deleted. Do not restore the facade; `responses-openai-bridge.ts` should call native Hub bridge action semantics helpers directly for the old utility surface.
- The remaining local functions in `responses-openai-bridge.ts` are IO/native-call glue only; request parameter selection, passthrough field selection, slim context/metadata projection, captured input sanitize, metadata extra field extraction, tool-control stripping, retained parameter merge, and data unwrap remain Rust native truth.
- Current shell audit after this deletion is `prodTsShellCount=57`, `shellsWithProdImporters=56`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Bridge message utils TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/bridge-message-utils.ts` is physically deleted. Do not restore it as the Responses bridge history/input conversion facade.
- `responses-openai-bridge.ts` may keep local BridgeInput type aliases and small native-call glue, but bridge history construction and bridge-input-to-chat conversion truth must stay in Rust native `buildBridgeHistoryWithNative` and `convertBridgeInputToChatMessagesWithNative`.
- Current clean-worktree shell audit after this deletion is `prodTsShellCount=56`, `shellsWithProdImporters=55`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Tool mapping TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.ts` is physically deleted. Do not restore it as the Responses bridge tool mapping facade.
- `responses-openai-bridge.ts` may keep local tool type aliases and small native-call glue, but chat-tools-to-Responses-tools mapping truth must stay in Rust native `mapChatToolsToBridgeWithNative` with explicit `sanitizeMode: 'responses'`.
- Current shell audit after this deletion is `prodTsShellCount=55`, `shellsWithProdImporters=54`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Chat request filter native wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-request-filter-semantics.ts` is physically deleted. Do not restore it as a standalone native wrapper.
- `sharedmodule/llmswitch-core/src/conversion/shared/chat-request-filters.ts` may own small native binding/load/stringify/parse fail-fast glue for `buildGovernedFilterPayloadJson` / `buildGovernedFilterPayloadWithContextJson`; actual governed filter semantics remain Rust native truth.
- Current shell audit after this deletion is `prodTsShellCount=43`, `shellsWithProdImporters=42`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Stopless next_step exact prompt lock

- For `stopreason=2` / `schemaFeedback.reasonCode=stop_schema_continue_next_step`, the next provider-facing current-turn user prompt must be exactly the schema `next_step` carried as CLI `continuationPrompt`. Do not inject fixed prose such as `继续执行你给出的 next_step` or any other generic continuation guidance.
- Verified lock: `scripts/tests/stopless-contract-blackbox.mjs` asserts the next_step case current-turn user texts equal `["rerun failing command"]`; focused Rust tests and stopless blackboxes passed on 2026-07-09. Full `build:base` was blocked by unrelated parallel deletion of native TS wrapper files still imported elsewhere.

# 2026-07-09: Native split facade wrappers are retired

- `native-shared-conversion-semantics-{call-id,id-stream,metadata,misc,openai,reasoning,responses,shell-utils,tool-definitions,toolcalls,tools}.ts`, `native-hub-bridge-action-semantics-tools-{request,core,post}.ts`, and `native-virtual-router-engine-proxy.ts` are physically deleted. Do not restore these split native wrapper files.
- Aggregate owners are now the only TS native-call glue for these surfaces: `native-shared-conversion-semantics.ts`, `native-hub-bridge-action-semantics.ts`, and `native-virtual-router-runtime.ts`. Semantics remain Rust/NAPI truth; aggregate TS files may only keep binding/load/stringify/parse fail-fast glue.
- Active tests/docs must import or allow the aggregate owner, not deleted split paths. Historical goal docs/backups may still mention the old split filenames as audit history, but active source/tests/scripts/docs architecture surfaces should not depend on them except absent-file residue gates.
- Current shell audit after this deletion is `prodTsShellCount=39`, `shellsWithProdImporters=38`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: OpenAI message normalize TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts` is physically deleted. Do not restore it as the chat request normalization facade.
- `chat-request-filters.ts` may keep only the env switch and native-call IO glue around `normalizeOpenaiChatRequestWithNative`; message/tool/history normalization truth remains Rust native.
- Tests should call the aggregate native owner directly or exercise `chat-request-filters.ts`; active gates should assert the retired facade path is absent.
- Current shell audit after this deletion is `prodTsShellCount=38`, `shellsWithProdImporters=37`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses response utils TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts` is physically deleted. Do not restore it as a response projection facade.
- `sharedmodule/llmswitch-core/scripts/tests/coverage-responses-response-utils.mjs` is also deleted because it only covered the retired facade and has no package/script caller.
- `responses-openai-bridge.ts` may keep the public `buildChatResponseFromResponses` export and native invocation/JSON parse glue around `buildChatResponseFromResponsesFullWithNative`; unwrap, bridge actions, passthrough/snapshot retention, and chat carrier projection remain Rust native truth.
- Current shell audit after this deletion is `prodTsShellCount=37`, `shellsWithProdImporters=36`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses OpenAI response-payload split facade is retired

- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts` is physically deleted. Do not restore it as a split bridge file.
- `responses-openai-bridge.ts` owns the public `buildResponsesPayloadFromChat` / `extractRequestIdFromResponse` exports and may keep native-call/JSON glue around Rust response payload helpers; response payload closeout and retention truth remain Rust native.
- Tests and scripts should import the aggregate `responses-openai-bridge.ts` surface, not the deleted `responses-openai-bridge/response-payload` subpath.
- Current shell audit after this deletion is `prodTsShellCount=36`, `shellsWithProdImporters=35`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses host policy TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.ts` is physically deleted. Do not restore it as a host policy facade.
- `responses-openai-bridge.ts` may call `evaluateResponsesHostPolicyWithNative` directly; host policy semantics remain Rust native truth.
- Current shell audit after this deletion is `prodTsShellCount=35`, `shellsWithProdImporters=34`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Followup native facade is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-followup-mainline-semantics.ts` is physically deleted. Do not restore it as a native followup wrapper or type source.
- `servertool/types.d.ts` may carry local registration type declarations, but followup request id, loop warning, budget reset, skeleton config, and followup decision semantics remain Rust-owned in `followup-core` / router-hotpath NAPI.
- Current shell audit after this deletion is `prodTsShellCount=34`, `shellsWithProdImporters=33`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Vercel AI SDK transport must inherit provider stream timeouts

- 5555 stalls with `provider.sse_decode` followed by `error_action_backoff_wait delayMs=1000` are not necessarily backoff hangs. For request `openai-responses-orangeai.key1-glm-5.2-20260709T150926727-484198-1107`, the 1s backoff completed; the actual stall was the prepared SDK fetch/SSE path waiting about 5 minutes before `ECONNRESET`.
- The owner is provider runtime transport, not SSE handler or Hub Pipeline. `VercelAiSdkOpenAiTransport.executePreparedRequest()` must enforce the same provider headers timeout and stream idle timeout contract as `HttpClient.postStreamOrResponse`.
- Provider config overrides for `streamIdleTimeoutMs` and `streamHeadersTimeoutMs` must reach `ServiceProfileResolver` / `ProviderContext.profile`; otherwise `transportBackend = "vercel-ai-sdk"` silently ignores config values that native HttpClient honors.
- `UPSTREAM_STREAM_IDLE_TIMEOUT` belongs to the recoverable `UPSTREAM_STREAM_TIMEOUT` family and must be allowed as a next-target/reroute transport error.
- Verified source gates: focused SDK transport, service-profile resolver, and provider-failure policy tests pass, `build:base` passes, function-map compile gate passes, SSE architecture boundary passes, and fallback denylist passes. Broader provider-failure blackbox currently has a separate runtime-health-trip failure and should not be conflated with SDK stream timeout handling.

# 2026-07-09: Responses tool utils TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts` and `sharedmodule/llmswitch-core/scripts/tests/coverage-responses-tool-utils.mjs` are physically deleted. Do not restore the facade or its coverage-only script.
- `responses-openai-bridge.ts` may keep local `ToolCallIdStyle` / bridge-input mutation glue only to call Rust native `createToolCallIdTransformerWithNative`, `normalizeResponsesCallIdWithNative`, `normalizeFunctionCallIdWithNative`, `normalizeFunctionCallOutputIdWithNative`, and `stripInternalToolingMetadataWithNative`; tool id normalization and metadata stripping truth remain Rust native.
- Current shell audit after this deletion is `prodTsShellCount=33`, `shellsWithProdImporters=32`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Runtime metadata TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/runtime-metadata.ts` is physically deleted. Do not restore it as a runtime metadata facade.
- The only previous production consumer was `responses-openai-bridge.ts`; it may keep local native-call/mutation glue around Rust native `ensureRuntimeMetadataCarrierWithNative` only for its force-web-search metadata carrier path.
- `sharedmodule/llmswitch-core/scripts/tests/coverage-bridge-protocol-blackbox.mjs` is physically deleted and removed from `run-matrix-ci.mjs`; it imported multiple already-retired dist facades and no longer represented active Rust/native bridge truth.
- Current shell audit after this deletion is `prodTsShellCount=32`, `shellsWithProdImporters=31`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Deleted native split helpers must not keep live imports

- `native-hub-pipeline-resp-semantics-shared.ts` and `native-hub-bridge-action-semantics-shared.ts` are retired split helpers. Do not restore them as facades.
- If active source still imports a retired `native-*-shared.js`, move only binding/stringify/parse/error glue to an existing native loader/aggregate owner. Current owner for these helper surfaces is `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts`.
- Verification lock: active source grep for the retired helper paths must return no hits, `npm run verify:llmswitch-core-tsc` must pass, and `npm run build:base` must pass.

# 2026-07-09: MetadataCenter runtime-control writer TS facade is retired

- `sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts` is physically deleted. Do not restore it as a shared TS facade for MetadataCenter symbol reads, runtime-control writes, or metadata snapshot reads.
- Production bridge code may use local `Symbol.for('routecodex.metadataCenter')` / `Symbol.for('routecodex.metadataCenter.rustSnapshot')` binding-preservation glue only when calling Rust native metadata carrier functions; write/project semantics remain Rust/native owned.
- Test-only direct-native helpers may carry local MetadataCenter read/write glue to exercise native stage boundaries, but active production source must not import this retired facade.
- Current shell audit after this deletion is `prodTsShellCount=29`, `shellsWithProdImporters=25`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: VR stop-message native TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-stop-message-semantics.ts` is physically deleted. Do not restore it as a public TS wrapper for `parseResolvedStopMessageInstructionJson`.
- The live host boundary already owns local fail-fast parsing glue in `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`; Rust export `parseResolvedStopMessageInstructionJson` remains required through the native export gate.

# 2026-07-09: VR routing-instructions native TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-instructions-semantics.ts` is physically deleted. Do not restore it as a public TS wrapper for routing instruction parsing/application.
- Active production source had no importer. Servertool routing tests use `tests/servertool/routing-instructions-direct-native.ts` as test-only direct-native glue for `parseRoutingInstructionsJson` and `applyRoutingInstructionsJson`.
- Current shell audit after this deletion pair is `prodTsShellCount=27`, `shellsWithProdImporters=24`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: VR routing-state native TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts` is physically deleted. Do not restore it as a public TS wrapper for routing-state keying, persistence, stop-message merge, or chat-process session usage.
- Routing-state persistence truth remains Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing_state_store.rs`; `src/lib.rs` is only the NAPI bridge, not a second canonical builder owner.
- Tests that need routing-state helpers should call Rust JSON exports through `tests/servertool/routing-instructions-direct-native.ts` as test-only glue. Active production source must not import a replacement routing-state wrapper.
- Current shell audit after this deletion is `prodTsShellCount=26`, `shellsWithProdImporters=24`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Hub pipeline orchestration protocol TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts` is physically deleted from production source. Do not restore it as a public runtime wrapper for Hub Pipeline orchestration or request-stage native plans.
- Tests that need direct NAPI glue should use `tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts`. That helper is test-only; production owner truth remains Rust `router-hotpath-napi/src/lib.rs` and `hub_pipeline_lib`.
- `function-map.yml` / `verification-map.yml` may point to the test helper only as coverage/test glue. It must not become a production allowed runtime path.
- Current shell audit after this deletion is `prodTsShellCount=25`, `shellsWithProdImporters=24`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: Responses bridge closed-loop runner is test-only

- `sharedmodule/llmswitch-core/src/test/responses-bridge-closed-loop.ts` is retired from production source and moved to `tests/sharedmodule/responses-bridge-closed-loop.ts`.
- Do not reintroduce closed-loop/test runners under `sharedmodule/llmswitch-core/src/`; shell-reference audit treats `src/` as production and this creates false production importers.
- `responses-openai-bridge.ts` has `prodImportRefs=0` after this move. Keep future Responses bridge evidence in root tests/scripts/docs unless there is a real runtime consumer.
- Current shell audit after this move is `prodTsShellCount=25`, `shellsWithProdImporters=23`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=4`, with `nonNativeFileCount=0`.

# 2026-07-09: exec-command-loop uses native exports, not Responses bridge subpath

- `scripts/tests/exec-command-loop.mjs` must call `dist/modules/llmswitch/bridge/native-exports.js::buildResponsesPayloadFromChatNative` for Responses projection verification.
- Do not restore the old core-loader Responses bridge subpath import in this script; that recreates an active script dependency on the production TS shell.
- Current shell audit after this move is `prodTsShellCount=25`, `shellsWithProdImporters=23`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`; remaining subpath refs are docs/note only, not active scripts.

# 2026-07-10: response projection scripts use native response mapper

- `scripts/batch-toolcall-report.mjs` and `scripts/responses-sse-replay-golden.mjs` must import `sharedmodule/llmswitch-core/dist/native/router-hotpath/native-shared-conversion-semantics.js::buildChatResponseFromResponsesWithNative` for response->chat projection.
- Do not restore their dependency on the production `responses-openai-bridge` dist file; these scripts only need Rust native response mapping, not request bridge glue.
- After this move, `responses-openai-bridge.ts` remains `prodImportRefs=0`; script text refs are down to 2 and both remaining refs need request-side bridge handling before deletion.

# 2026-07-10: replay-responses-sse uses native Responses payload mapper

- `scripts/replay-responses-sse.mjs` must use `dist/modules/llmswitch/bridge/native-exports.js::buildResponsesPayloadFromChatNative` for Chat response -> Responses payload projection.
- Do not restore its sharedmodule `dist/conversion/responses/responses-openai-bridge.js` import.
- The remaining script dist bridge dependencies, `scripts/outbound-regression-codex-samples.mjs` and `scripts/responses-sse-capture.mjs`, require Chat->Responses request bridge semantics. Existing `runResponsesOpenaiRequestCodecJson` is the opposite direction (Responses->Chat) and is not an equivalent replacement.

# 2026-07-10: metadata boundary test uses host native Responses mapper

- `tests/sharedmodule/responses-openai-bridge-metadata-boundary.spec.ts` must import `buildResponsesPayloadFromChatNative` from `src/modules/llmswitch/bridge/native-exports.js`, not from `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js`.
- This test validates client metadata isolation through Rust native projection and does not need the production Responses bridge TS shell.

# 2026-07-10: Production Responses OpenAI bridge is retired

- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts` is physically deleted from production source. Do not restore it as a public bridge, production helper, dist import target, or compatibility layer.
- Chat -> Responses request building is Rust/NAPI-owned through `buildResponsesRequestFromChatJson` and host `buildResponsesRequestFromChatNative`; Responses -> Chat request adaptation remains Rust `responses_openai_codec.rs` / `convert_bridge_input_to_chat_messages`.
- Tests that still need old deep bridge assertions must use test-only `tests/sharedmodule/helpers/responses-openai-bridge-direct-native.ts`; production source/scripts must use Rust/host native exports.
- The direction lock remains: `runResponsesOpenaiRequestCodecJson` is Responses -> Chat and must not be used as a Chat -> Responses replacement.

# 2026-07-10: Bridge action/policy production native wrappers are retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-action-semantics.ts` and `native-hub-bridge-policy-semantics.ts` are physically deleted from production source. Do not restore them as production native wrapper shells.
- Tests that need those direct helper surfaces must use `tests/sharedmodule/helpers/native-hub-bridge-action-direct-native.ts` and `tests/sharedmodule/helpers/native-hub-bridge-policy-direct-native.ts`.
- Production callers must use Rust NAPI through existing host exports, especially `src/modules/llmswitch/bridge/native-exports.ts::hasDeclaredApplyPatchToolNative`, `evaluateResponsesDirectRouteDecisionNative`, and `sanitizeProviderOutboundPayload`.

# 2026-07-09: Local shutdown requires caller provenance

- `/shutdown` is lifecycle control-plane. Localhost alone is not enough authorization because a single accepted shutdown stops every listener in the managed multi-port process (`5520`, `10000`, `5555`, `4444`).
- Anonymous local `/shutdown` must return `403 shutdown_caller_required` and must not call `process.kill`. Legitimate lifecycle callers must send `x-routecodex-stop-caller-pid`, `x-routecodex-stop-caller-ts`, `x-routecodex-stop-caller-cwd`, and `x-routecodex-stop-caller-cmd`.
- The shutdown route exception path must fail visibly; it must not ACK success and self-terminate as a fallback.
- Verified gates for the provenance fix: red test first confirmed anonymous `/shutdown` returned 200; after the fix, focused `/shutdown` provenance Jest, `port-utils` caller-header Jest, `stop-command` caller-header Jest, `verify:runtime-lifecycle-pid-rebase`, TypeScript compile, shell syntax checks for affected scripts, and read-only live health checks for 5520/5555 pass.

# 2026-07-09: Stopless guidance must not judge task state

- Stopless / reasoningStop guidance may describe the stop schema contract and field requiredness, but must not tell the model that the task is done, converged, ready to close, must stop, or should avoid continuing.
- First no-schema continuation text is exactly `继续。`; invalid-schema continuation text is neutral feedback repair such as `继续；按上一轮反馈修正。`; budget/terminal repair text remains schema feedback only.
- Non-terminal CLI `summary` is also neutral `继续`; do not reintroduce state-judging summaries.
- `stopreason=2` next-turn provider-facing user prompt must be the model-provided `next_step` itself. The system should not synthesize "suggested next step" text.
- Verified on installed `0.90.3707`: `routecodex hook run reasoningStop` for no-schema, invalid-schema, and budget-exhausted all emit neutral `summary`/`continuationPrompt`; runtime `dist` grep has no terminal-state judgment wording.

# 2026-07-10: Req inbound split native wrappers are retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-inbound-outbound-semantics.ts` and `native-hub-pipeline-req-inbound-semantics-tools.ts` are physically deleted. Do not restore them as production split wrapper shells.
- Aggregate owner `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.ts` may carry only native binding/stringify/parse/fail-fast glue for req inbound helpers such as collected tool outputs, bridge tool mapping, context capture, tool-output snapshot, diagnostics, and shell-like tool-call normalization. Semantics remain Rust/NAPI truth.
- Active production and test callers should import req inbound native helper exports from the aggregate owner; residue gates should assert the split paths remain absent.
- Current shell audit after this deletion is `prodTsShellCount=18`, `shellsWithProdImporters=14`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`, with `nonNativeFileCount=0`.

# 2026-07-10: Edge-stage native wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.ts` is physically deleted. Do not restore it as a production split wrapper for format envelope or SSE stream mode glue.
- `native-hub-pipeline-req-inbound-semantics.ts` is the aggregate owner for the remaining native-call/stringify/parse/fail-fast glue: `sanitizeFormatEnvelopeWithNative`, `resolveSseStreamModeWithNative`, and `processSseStreamWithNative`. Runtime semantics remain Rust/NAPI truth.
- Current shell audit after this deletion is `prodTsShellCount=17`, `shellsWithProdImporters=13`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`, with `nonNativeFileCount=0`.

# 2026-07-10: Snapshot native production wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-snapshot-hooks.ts` is physically deleted from production source. Do not restore it as a production snapshot native wrapper.
- Snapshot native echo tests should use test-only `tests/sharedmodule/helpers/snapshot-hooks-direct-native.ts`; runtime snapshot behavior remains Rust/NAPI truth or host bridge owner, not sharedmodule production TS shell.
- Current shell audit after this deletion is `prodTsShellCount=16`, `shellsWithProdImporters=13`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`, with `nonNativeFileCount=0`.

# 2026-07-10: Hub response semantics production wrappers are retired

- `native-hub-pipeline-resp-semantics-inbound-tools.ts`, `native-hub-pipeline-resp-semantics-outbound-tools.ts`, and `native-hub-pipeline-resp-semantics.ts` are physically deleted from `sharedmodule/llmswitch-core/src/native/router-hotpath/`. Do not restore them as production wrapper shells or dist subpath targets.
- Tests that need direct response semantics NAPI glue must use `tests/sharedmodule/helpers/resp-semantics-direct-native.ts`. Production callers should use Rust/host native exports, especially `src/modules/llmswitch/bridge/provider-response-converter-host.ts` for provider response materialization and SSE descriptor IO glue.
- Scripts that need Anthropic response conversion should call direct NAPI helpers in `scripts/helpers/anthropic-codec-direct-native.mjs`; do not depend on `sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-pipeline-resp-semantics.js`.
- The retired coverage script `sharedmodule/llmswitch-core/scripts/tests/coverage-native-hub-pipeline-resp-semantics.mjs` must stay deleted because it requires the removed dist wrapper. Response semantics coverage now comes from Rust tests, residue gates, focused direct-native helper tests, and host native bridge tests.
- Current shell audit after this deletion is `prodTsShellCount=13`, `shellsWithProdImporters=11`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`, with `nonNativeFileCount=0`.

# 2026-07-10: Native shared conversion aggregate wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts` is physically deleted from production source. Do not restore it as a production aggregate wrapper, compatibility shim, required dist output, or Jest mock subpath.
- Tests that still need the old direct native helper surface must use `tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts`. Production scripts/runtime must use direct Rust/NAPI or host native exports such as `src/modules/llmswitch/bridge/native-exports.ts::buildChatResponseFromResponsesNative` and `buildResponsesRequestFromChatNative`.
- Required-export checks for req inbound context capture should assert the packaged `.node` export or existing `native-hub-pipeline-req-inbound-semantics` aggregate, not `dist/native/router-hotpath/native-shared-conversion-semantics.js`.
- Current shell audit after this deletion is `prodTsShellCount=12`, `shellsWithProdImporters=10`, `coreModuleSubpathRefs=3`; rustification baseline is `prodTsFileCount=12`, `prodTsLocTotal=3833`, `nonNativeFileCount=0`.

# 2026-07-10: Native router hotpath analysis wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.ts` is physically deleted from production source. Do not restore it as a parser wrapper or compatibility shim.
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts` owns the remaining native-call/JSON parse/fail-fast glue for pending tool sync, continue execution injection, chat media analysis/strip, and web-search intent; deeper semantics remain Rust/NAPI truth.
- Tests that need media strip direct-native behavior should keep it in `tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts`; production source must not import or recreate the retired analysis wrapper.
- Current shell audit after this deletion is `prodTsShellCount=11`, `shellsWithProdImporters=9`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`; rustification audit is `prodTsFileCount=11`, `nonNativeFileCount=0`.
- `native-hub-pipeline-req-inbound-semantics.ts` must not be deleted solely because strict shell audit reports `prodImportRefs=0`; it still acts as an owner/test surface until function-map/mainline/test references are explicitly moved.

# 2026-07-10: Root llmswitch-core public entry is metadata/type-only

- `sharedmodule/llmswitch-core/src/index.ts` must not runtime re-export `native-virtual-router-bootstrap-config.ts`, `native-provider-runtime-ingress.ts`, or `native-router-hotpath-loader.ts`; use explicit native subpaths for runtime facade imports.
- The root entry may expose only `VERSION` and type-only VR contracts until generated declarations replace the remaining handwritten type surface.
- Audit scripts classify this root entry as non-semantic only when it contains type-only exports plus `VERSION`; do not add fake native keywords to satisfy rustification gates.
- Current strict shell reference audit after this public-barrel shrink is `prodTsShellCount=11`, `shellsWithProdImporters=7`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`.
- `native-provider-runtime-ingress.ts` and `native-virtual-router-bootstrap-config.ts` having `prodImportRefs=0` is not deletion proof by itself; they still require exact test/owner migration before physical deletion.

# 2026-07-10: Provider runtime ingress TS wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts` is physically deleted. Do not restore it as a production wrapper, type source, root export, or no-fallback allowlisted shell.
- Provider error/success ingress truth is Rust-owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs::report_provider_error_to_router_policy_json_bridge` and `virtual_router_engine/provider_runtime_ingress.rs::report_provider_error` / `report_provider_success`.
- Tests that need direct ingress calls should use host/native binding (`src/modules/llmswitch/bridge/native-exports.js::getRouterHotpathJsonBindingSync`) or local host boundary types, not the retired llmswitch-core TS wrapper.
- Current strict shell audit after deletion is `prodTsShellCount=10`, `shellsWithProdImporters=7`, `coreModuleSubpathRefs=3`; focused provider ingress/error-pipeline/residue tests pass.

# 2026-07-10: Req inbound aggregate native wrapper is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.ts` is physically deleted from production source. Do not restore it as a production aggregate wrapper, required dist output, or Jest mock subpath.
- Tests that need req_inbound direct native evidence must use `tests/sharedmodule/helpers/req-inbound-direct-native.ts`; runtime context capture remains host bridge `src/modules/llmswitch/bridge/native-exports.ts` calling Rust/NAPI truth in `hub_req_inbound_context_capture.rs`.
- Function map and mainline call map no longer point runtime edges at the retired aggregate wrapper. Active import scan for the retired aggregate path should have no source/test/script imports outside residue absent-file locks.

# 2026-07-10: Native shared conversion core shell is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.ts` is physically deleted. Do not restore it as a production helper shell or required dist output.
- Its remaining binding/stringify/parse/error glue moved into the existing `native-router-hotpath-loader.ts` native loader surface; this is loader plumbing only, not a new TS semantics owner.
- Tests/scripts that need direct NAPI helper access should import those loader helper exports, while runtime semantics remain Rust/NAPI truth.
- Current strict shell audit after deletion is `prodTsShellCount=7`, `shellsWithProdImporters=6`, `coreModuleSubpathRefs=3`; rustification audit is `prodTsFileCount=7`, `nonNativeFileCount=0`.

# 2026-07-10: Virtual router host-effects and required-export shells are retired

- `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts` is physically deleted. Do not restore it as a production runtime shell; stop-message marker/status-label/hit-log host glue now lives in `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts` beside `VirtualRouterEngine`.
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts` is physically deleted. Do not restore it as a separate production shell; `REQUIRED_NATIVE_HOTPATH_EXPORTS` is owned by `native-router-hotpath-loader.ts`.
- `sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` must parse only the `REQUIRED_NATIVE_HOTPATH_EXPORTS` array block from loader. Full-file string scanning is invalid after the required-export list is co-located with loader code because unrelated string literals pollute the export contract.
- Current strict shell audit after deletion is `prodTsShellCount=5`, `shellsWithProdImporters=4`, `coreModuleSubpathRefs=3`; rustification audit is `prodTsFileCount=5`, `prodTsLocTotal=2330`, `nonNativeFileCount=0`.

# 2026-07-10: Virtual router hit-log TS facade is retired

- `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts` is physically deleted. Do not restore it as a production facade, package subpath, ambient module, or test import target.
- Virtual Router hit-log truth remains Rust-owned by `virtual_router_hit_log.rs` and NAPI exports `createVirtualRouterHitRecordJson`, `formatVirtualRouterHitJson`, `toVirtualRouterHitEventJson`, `resolveSessionColorStr`, and `resolveSessionLogColorKeyJson`.
- Runtime host code must call those exports through existing native loader/host binding surfaces: `native-virtual-router-runtime.ts` for VR hit emission and `src/modules/llmswitch/bridge/native-exports.ts::getRouterHotpathJsonBindingSync` for host session log color helpers.
- Tests that need the deleted facade API shape use test-only `tests/sharedmodule/helpers/virtual-router-hit-log-direct-native.ts`, not production TS shell imports.
- Current strict shell audit after deletion is `prodTsShellCount=4`, `shellsWithProdImporters=2`, `coreModuleSubpathRefs=3`; rustification audit is `prodTsFileCount=4`, `prodTsLocTotal=2184`, `nonNativeFileCount=0`.

# 2026-07-10: Native router hotpath production shell is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts` is physically deleted. Do not restore it as a production helper shell, dist script target, or test mock target.
- The remaining production native binding helpers (`callNativeJson`, `loadNativeRouterHotpathBindingForInternalUse`, `failNative`) are owned by `native-router-hotpath-loader.ts`; this is loader plumbing only, not a second semantics owner.
- Direct tests that need the old helper-shaped analyzer functions use `tests/sharedmodule/helpers/native-router-hotpath-direct-native.ts`; scripts should call `dist/native/router-hotpath/native-router-hotpath-loader.js` and the NAPI binding directly.
- Current strict shell audit after deletion is `prodTsShellCount=3`, `shellsWithProdImporters=1`, `coreModuleSubpathRefs=3`; rustification audit is `prodTsFileCount=3`, `prodTsLocTotal=1980`, `nonNativeFileCount=0`.

# 2026-07-10: Native virtual router runtime production shell is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts` is physically deleted. Do not restore it as production `VirtualRouterEngine`, hit-log host-effects, token estimator, stop-message marker, or diagnostics runtime shell.
- Production VR diagnostics and hit-log mainline now bind to Rust/NAPI plus host `src/modules/llmswitch/bridge/routing-integrations.ts`; tests/scripts that need direct runtime access use `tests/sharedmodule/helpers/virtual-router-engine-direct-native.ts` or `sharedmodule/llmswitch-core/scripts/helpers/virtual-router-engine-direct-native.mjs`.
- Current strict shell audit after deletion is `prodTsShellCount=2`, `shellsWithProdImporters=0`, `coreModuleSubpathRefs=3`; rustification baseline is `prodTsFileCount=2`, `prodTsLocTotal=1159`, `nonNativeFileCount=0`.
- Remaining production TS files are `sharedmodule/llmswitch-core/src/index.ts` (type-only + VERSION) and `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts` (native export manifest/binding loader). Do not claim zero production TS until the loader manifest/binding role and root package entry are replaced.

# 2026-07-10: llmswitch-core production TS shell count is zero

- `sharedmodule/llmswitch-core/src/index.ts` is physically deleted; do not restore the root TypeScript barrel for metadata, `VERSION`, or type-only re-export purposes.
- `sharedmodule/llmswitch-core/package.json` no longer exposes root `"."`, `main`, `module`, `types`, or deleted `"./conversion/switch-orchestrator"`; the package remains consumable through explicit live subpaths such as `./native/servertool-wrapper`.
- `scripts/ci/llmswitch-rustification-audit.mjs` and `scripts/ci/verify-llmswitch-minimal-ts-surface.mjs` no longer allow a metadata-only root entry exception.
- `scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json` is the canonical shell gate and now reports `prodTsShellCount=0`, `shellsWithProdImporters=0`, `shellsWithHostTextRefs=0`.
- `npm run verify:llmswitch-rustification-audit -- --json` now compares against baseline `prodTsFileCount=0`, `prodTsLocTotal=0`, `nonNativeFileCount=0`.
- Commit: `16395ae09 refactor(hub): retire llmswitch-core root TS barrel`; note commit: `b51b8a691 docs(note): record llmswitch-core zero TS shell closeout`.

# 2026-07-10: Native router hotpath loader production shell is retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts` is physically deleted from production source; do not restore it as a dist/package runtime loader, required-export owner, root export, or package required output.
- Required NAPI export truth is `sharedmodule/llmswitch-core/native-hotpath-required-exports.json`; `sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` parses that JSON contract and validates the packaged `.node` binding against it.
- Test-only direct native loading lives in `tests/sharedmodule/helpers/native-router-hotpath-loader.ts`; script-only direct native loading lives in `sharedmodule/llmswitch-core/scripts/helpers/native-router-hotpath-loader.mjs`. Both are helper surfaces, not production TS runtime.
- Source verification after this closeout reports `prodTsShellCount=0` and rustification `prodTsFileCount=0`; exact active source/script/doc scan no longer references the deleted production loader path.

# 2026-07-10: Native exports Phase 3 servertool wrapper fan-out is retired

- `src/modules/llmswitch/bridge/native-exports.ts` must not restore the `SERVERTOOL ORCHESTRATION WRAPPERS (Phase 3)` hand-written export block. The former wrapper names, including `runServertoolResponseStageWithNative`, `buildServertoolDispatchPlanInputWithNative`, `planServertoolOutcomeWithNative`, web-search wrappers, and vision wrappers are no longer package/native-exports surface.
- If a remaining servertool bridge needs an old Phase 3 native capability internally, call the Rust/NAPI JSON capability through a private non-exported helper. Do not re-export the old `*WithNative` name from `native-exports.ts` or generated `servertool-wrapper.d.ts`.
- Tests that need removed Phase 3 behavior must use direct Rust/NAPI binding evidence under test helpers, as `servertool-cli-native-bridge.spec.ts` now does for `planStoplessCliProjectionContextJson`.
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` locks both `native-exports.ts` and `native-exports.js` against restoring the Phase 3 wrapper marker and representative deleted wrapper names.
- Verification evidence for this closeout: `build:base`, `verify:servertool-rust-only`, strict llmswitch shell audit with `prodTsShellCount=0`, rustification/minimal TS audits, focused servertool/residue Jest 246/246, function-map/mainline/deleted-path/thin-wrapper/fallback gates, and `git diff --check` pass.

# 2026-07-10: routing-integrations VR route host-effects are Rust-planned

- `src/modules/llmswitch/bridge/routing-integrations.ts` must not restore local VR route host-effects decision helpers such as `createVirtualRouterRouteHostEffectsLocal`, `emitVirtualRouterHitLogLocal`, `resolveVirtualRouterLogRequestIdLocal`, or local `forceStopStatusLabel` calculation.
- Runtime VR route host-effects are Rust-owned by `virtual_router_engine/virtual_router_host_effects.rs` through NAPI exports `planVirtualRouterRouteHostEffectsJson` and `finalizeVirtualRouterRouteHostEffectsJson`.
- The TS bridge may only call the Rust plan before route, call the Rust finalizer after route, apply returned `cleanedRequest` to the original request object, and `console.log` the optional returned hit-log line.
- `vr.route_host_effects` and the VR hit-log mainline point to the Rust finalizer; function-map/wiki gates lock this owner so stop-message parse logs, request/session id selection, hit-log record creation, line formatting, and forced stop-status labels do not return to TS bridge logic.

# 2026-07-10: Responses conversation store state is Rust operation-owned

- `src/modules/llmswitch/bridge/responses-conversation-store-host.ts` must remain a thin native operation shell around `executeResponsesConversationStoreOperationJson`; do not restore TS `Map`/index/persistence/prune/rebind/release state logic there.
- `shared_responses_conversation_utils.rs` owns Responses conversation request map, response index, scope index, persistence eligibility/load/flush, restart-simulation reset, prune, release, clear, rebind, lookup, resume, and materialize behavior.
- The host shell may pass `ROUTECODEX_RESPONSES_CONVERSATION_STORE` as operation-level IO context because Jest/runtime host env is not always visible as OS env to Rust; Rust applies the path and resets store state only when that explicit path changes.
- Checked-in `responses-conversation-store-host.js` / `.d.ts` mirrors must not receive debug API backfill. Debug accessors may exist only on canonical TS source/tests until the source mirror imports are fully retired.
- Residue gate must keep old per-plan native helper names out of `responses-conversation-store-host.ts/js/d.ts`; the allowed production surface is the single operation API plus thin host wrappers.

# 2026-07-11: Responses store host global singleton is retired

- `ResponsesConversationStore` class and `globalThis.__rccResponsesConversationStore` are physically removed from `src/modules/llmswitch/bridge/responses-conversation-store-host.ts`; do not restore either as runtime truth or a test hook.
- Runtime observers/tests must use explicit host exports such as `getResponsesConversationStoreDebugStats()` and the Rust operation API, not raw global `Map` access.
- Tests that assert request-map cleanup must set `ROUTECODEX_RESPONSES_CONVERSATION_STORE` to a temp file and clear that isolated store before/after. Otherwise `clear_request` can load the user's default persisted store and leave unrelated old entries, creating false failures.

# 2026-07-10: Responses continuation direct NAPI wrappers are retired

- `resumeResponsesConversationPayloadJson`, `restoreResponsesContinuationPayloadJson`, and `materializeResponsesContinuationPayloadJson` must not return to `native-hotpath-required-exports.json`; the host-facing store surface is `executeResponsesConversationStoreOperationJson`.
- Direct resume error-envelope coverage now uses store operation `resume_entry_payload`; do not reintroduce standalone NAPI wrappers or test-only JS helper wrappers for those three names.

# 2026-07-10: Responses store host d.ts mirror is retired

- `src/modules/llmswitch/bridge/responses-conversation-store-host.d.ts` had no active consumer and is physically deleted. Keep it absent; residue coverage should assert absence while `responses-conversation-store-host.ts` remains the canonical source and `.js` remains only while runtime importers still require it.

# 2026-07-10: zero-ref bridge d.ts mirrors should be deleted, not preserved

# 2026-07-12: host bridge/resource/snapshot review closeout

- Current host bridge contraction batch is verified as release `0.90.3922`: narrow owner-specific hosts replace broad non-bridge `native-exports` callsites, resource ownership map/gates are queryable, and provider-request dry-run snapshot ownership sits in `debug.pipeline_dry_run_loop` instead of provider runtime.
- Final installed evidence: `routecodex --version`, `rcc --version`, `~/.rcc/install/current/package.json`, and `/health` on `5520`, `5555`, `4444`, and `10000` all report `0.90.3922` with `ready=true` and `pipelineReady=true`.
- Review boundary: full crate `cargo fmt --manifest-path ... --check` currently hits an unrelated committed-format issue in `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`; touched `hub_snapshot_hooks.rs` rustfmt passes, so do not mix that old Rust formatting cleanup into host bridge/resource commits unless explicitly scoped.

- `src/modules/llmswitch/{core-loader,bridge,bridge/index}.d.ts` and `src/modules/llmswitch/bridge/{module-loader,native-exports,provider-response-converter-host,response-converter,responses-request-bridge,responses-response-bridge,responses-sse-bridge,routing-integrations,runtime-integrations,snapshot-recorder-runtime,snapshot-recorder-tool-failures,snapshot-recorder-types,snapshot-recorder,state-integrations}.d.ts` had no active consumer and are physically deleted.
- For bridge closeout, zero-ref `.d.ts` sidecar mirrors are stale artifacts, not compatibility surfaces. Keep them absent and lock with residue coverage instead of preserving them beside live `.ts`/`.js` files.

# 2026-07-10: host llmswitch bridge JS mirrors are retired

- All tracked `src/modules/llmswitch/**/*.js` and `src/modules/llmswitch*.js` source-side emit mirrors are physically deleted. Do not restore them as compatibility surfaces, Jest helpers, or runtime truth.
- Canonical host bridge authoring remains in `src/modules/llmswitch/**/*.ts`; runtime JS belongs in `dist` after build. Jest relative `.js` specifiers resolve to TS through `moduleNameMapper`, so source imports may keep ESM `.js` specifiers without requiring checked-in mirror files.
- Residue coverage now fails if a tracked-and-existing host bridge `.js` source artifact returns under `src/modules/llmswitch`.

# 2026-07-11: Native exports servertool-core wrapper fan-out is retired

- `src/modules/llmswitch/bridge/native-exports.ts` must not restore the `SERVERTOOL CORE BRIDGE WRAPPERS` production block or per-capability servertool/stopless/followup `*WithNative` export fan-out.
- `sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js`, `dist/native/servertool-wrapper.d.ts`, and `types/servertool-wrapper.d.ts` are release-marker surfaces only; they must not export or declare capability wrappers ending in `WithNative`.
- Tests that still need old wrapper-shaped names use `tests/sharedmodule/helpers/servertool-native-wrapper-test-helper.ts`, which directly invokes Rust/NAPI JSON capabilities and is not a production import target.
- Servertool function/verification maps no longer list `native-exports.ts` as the servertool wrapper owner; the owner remains Rust/NAPI (`servertool-core` and `router-hotpath-napi`) plus required export manifests and tests.
- Verification evidence for this closeout: focused servertool Jest 50/50, hub-pipeline residue audit 211/211, `verify:servertool-rust-only`, strict llmswitch shell audit, rustification/minimal TS audits, function-map/mainline/deleted-path/thin-wrapper/fallback gates, `verify:llmswitch-core-tsc`, root `tsc`, `build:base`, servertool-wrapper import exportCount=0, residue `rg` zero matches, and `git diff --check` pass.

# 2026-07-11: Provider runtime ingress updates HubPipeline handle VR health

- Provider runtime ingress reports now update Rust `HubPipelineEngine` handle registry as well as standalone `VirtualRouterEngineProxy` registry; HubPipeline virtual-router status and routing must see provider errors/success without TS bridge polling or a second runtime owner.
- The Rust dispatch path is `provider_runtime_ingress::{report_provider_error, report_provider_success}` -> `hub_pipeline_engine::registry::{dispatch_provider_error_to_registered_engines, dispatch_provider_success_to_registered_engines}` -> `HubPipelineEngine::{handle_provider_runtime_error, handle_provider_runtime_success}`.
- Provider success must clear only the exact provider key from the event. It must not also clear `runtimeKey` or provider-key aliases; otherwise a backup provider success can erase the primary provider failure window and keep routing to a repeatedly failing primary.
- Verification evidence: `cargo test -p router-hotpath-napi provider_`, focused provider runtime / Hub runtime / error pipeline Jest 26 tests, `build:native-hotpath`, `verify:error-pipeline-contract`, `verify:provider-failure-ban-blackbox`, `verify:vr-no-ts-runtime`, llmswitch shell/minimal/rustification audits, architecture mainline/function gates, root/sharedmodule TypeScript, `build:base`, and `git diff --check` pass.

# 2026-07-11: Hub Pipeline / llmswitch-core zero production TS audit is green

- Current source/doc-only closeout gates prove zero hand-authored production TS runtime surface under `sharedmodule/llmswitch-core/src`: `verify:llmswitch-zero-ts-closeout`, strict `llmswitch-ts-shell-reference-audit`, minimal TS surface, and rustification audit all pass with zero production/non-native TS metrics.
- `git ls-files 'sharedmodule/llmswitch-core/src/**/*.ts'` currently finds only test files plus `virtual-router-contracts.d.ts` and `servertool/types.d.ts` declaration artifacts; no production runtime `.ts` files remain.
- Architecture/build evidence for the audit: function-map compile gate, mainline call-map, mainline manifest sync, deleted-path, thin-wrapper-only, VR no-TS runtime, servertool Rust-only, Responses history protocol contract, sharedmodule/root TypeScript, `build:native-hotpath`, and `build:base` all pass.
- Installed runtime evidence is consistent at `0.90.3789`: `routecodex --version`, `rcc --version`, `~/.rcc/install/current/package.json`, and `/health` on `4444`, `5520`, `5555`, and `10000` all report `0.90.3789` with `ready=true` and `pipelineReady=true`.
- No runtime behavior changed in this audit slice; treat this as source/reference/build/install evidence, not a new live same-entry behavior replay.

# 2026-07-11: llmswitch-core full tracked and filesystem TS-like zero

- `sharedmodule/llmswitch-core` is now locked as full source/test/type TS-like zero, not only production TS zero: tracked `.ts/.tsx/.mts/.cts/.d.ts` under the core tree are absent after deletion, and filesystem scanning excluding generated/cache dirs also returns zero.
- `scripts/ci/verify-llmswitch-zero-ts-closeout.mjs` is the closeout gate: it checks minimal TS manifest entries are zero, tracked core TS-like files are zero, filesystem core TS-like files are zero, external active imports/require/Jest mocks/config mappers to `sharedmodule/llmswitch-core/src` are zero, and rustification `nonNativeFileCount/nonNativeLocTotal` are zero.
- External test/config references were moved to dist/native or local opaque test types: Jest no longer maps `rcc-llmswitch-core/v2` or old relative core `src` specifiers to `sharedmodule/llmswitch-core/src`, and the unused `tests/jest-path-fix.js` mapper is deleted.
- Build-core is native-only for llmswitch-core: `scripts/build-core.mjs` runs native hotpath build plus servertool wrapper generation and no longer runs `tsc -p sharedmodule/llmswitch-core/tsconfig.json`; the core package `build` script matches that native-only path.
- Verification evidence: `npm run verify:llmswitch-zero-ts-closeout`, strict shell reference audit, rustification audit, minimal TS surface audit, function-map compile gate, architecture mainline/deleted-path/thin-wrapper gates, VR no-TS runtime, VR no-fallback semantics, servertool Rust-only, focused residue/minimal/apply-patch/stop-message Jest, `tsconfig.jest` TypeScript, `node scripts/build-core.mjs`, `git diff --check`, and `npm run build:base` pass. No global install/restart was run for this source-only closeout slice.

# 2026-07-11: Direct Responses continuation provider pin projection

- Direct-owned `/v1/responses` continuation restore must promote the stored direct `providerKey` into request-scoped `MetadataCenter.runtime_control.retryProviderKey`; Rust Virtual Router consumes that field to force same-provider direct continuation.
- Relay-owned continuation must not write `retryProviderKey`. Keeping `responsesResume.providerKey` only in continuation context is not enough for direct provider pin, and reading provider pin from relay or flat legacy metadata is forbidden.
- Verified regression evidence: direct continuation blackbox hits `["p1","p1"]` with `default/forced`; relay blackbox hits `["p1","p2"]`, proving relay remains unpinned.

# 2026-07-11: WebUI routing targets and live apply truth

- Marker: webui-target-chain-live-apply-20260711.
- `webui.config_editor_surface` is a thin config editor only: route names are labels, not provider target truth. WebUI target summaries must read configured pool targets from `routing.<route>[][].targets[]` and accept target objects through `providerId`, `provider`, or `target`.
- WebUI config mutation responses must expose live-apply evidence. Active `httpserver.ports[]` edits call the live port owner and return `portApply`; active config/provider/routing/forwarder edits return `selfReload`; non-active config edits must report explicit saved-only skip instead of claiming runtime application.
- Frontend tests for this surface should use TOML-shaped user/provider config paths and assert target-chain/live-apply behavior, not legacy `config.json`, route-name-derived targets, or "restart required" UI text.

# 2026-07-11: Process lifecycle logger preserves nested error semantics

- Marker: process-lifecycle-nested-error-20260711.
- `process-lifecycle.jsonl` failure records with `details.error={}` are silent-failure bugs in the lifecycle logger, not acceptable evidence. The unique owner is `src/utils/process-lifecycle-logger.ts`; fix recursive serialization there rather than adding caller-specific message fields.
- Verified fixed behavior: installed `0.90.3872` recursively serializes nested `Error` values with `name`, `message`, `stack`, `cause`, and extra fields such as `code`. Focused logger/port-utils tests, TypeScript, runtime lifecycle gate, function-map gate, `build:base`, global install, live health on 5555/5520/10000, and installed-dist logger probe passed.

# 2026-07-11: Responses direct model compat is bounded, not recursive fallback

- Responses direct path may restore client-visible model for non-ChatGPT provider compat, but only at protocol-visible top-level response `model` and SSE/JSON `response.model`; nested diagnostic/tool/metadata `model` fields must remain provider payload truth.
- Router-direct SSE compat must fail fast when `sseStream` is not a real readable stream. Returning an empty stream is forbidden because it converts malformed provider/runtime output into a false successful SSE.
- Response dry-run snapshots containing serialized live readable state must be rejected unless they also include materialized `bodyText`, `raw`, `text`, or `sseBodyText`; offline dry-run cannot replay a captured live stream object.
- Verification evidence: router-direct focused Jest passed 34/34; pipeline dry-run Jest passed 4/4; temp serialized `sseStream` sample through `dry-run:codex-response` failed with the explicit unreplayable-stream error.

# 2026-07-11: install-release must not use start --restart takeover

- Marker: install-release-no-start-restart-20260711.
- Root cause of the remaining "restart closes server" symptom: release/install verification could still invoke `rcc start --restart --port <port>` and `/shutdown` adoption even after `restart.ts` was fixed. That path stops the existing managed process/session instead of asking the original session to restart.
- Current rule: if live `/health` exists, install-release uses installed `rcc restart --port <port> --host <host>`; if live health is unavailable, it may use daemon `rcc start --no-restart --port <port>` only for a stopped target. Version mismatch after restart is a visible failure, not a takeover.
- Verified current global evidence: installed truth is `routecodex/rcc/~/.rcc/install/current/package.json` all `0.90.3874`; `/health` on `5555`, `5520`, `10000`, and `4444` all reports ok/ready/pipelineReady `0.90.3874`.
- Lifecycle evidence after the install window: `process-lifecycle.jsonl` shows `SIGUSR2 -> restart_delegate_parent_supervisor -> exitCode 75` under the original `start --snap` parent and no new `port_http_shutdown`/`shutdown_route` from install-release adoption.

# 2026-07-11: Responses SSE extra transport leaf is deleted

- `src/modules/llmswitch/bridge/responses-sse-transport.ts` is physically deleted; keepalive framing is part of the existing handler-facing `responses-sse-bridge.ts` facade, while SSE projection and terminal transport-state semantics remain Rust/NAPI-owned through `native-exports.ts`.
- Architecture verifiers and red tests must not require the deleted leaf as a separate owner. `hub-pipeline-stage-residue-audit` locks the path as absent.
- Verification evidence: focused TypeScript, `verify:responses-handler-single-bridge-surface`, `verify:responses-sse-business-module`, focused Jest 222/222, strict llmswitch shell audit, zero-TS closeout verifier, deleted-path, thin-wrapper-only, function-map compile, `git diff --check`, and `build:base` pass.

# 2026-07-11: State integrations bridge shell is deleted

- `src/modules/llmswitch/bridge/state-integrations.ts` is physically deleted. Active routing-state IO now lives under `src/manager/modules/routing/native-routing-state-store.ts`, and request metadata session extraction calls `extractSessionIdentifiersFromMetadataNative` directly from the native bridge.
- The routing-state persistence truth remains Rust/NAPI: TS only marshals host `Set`/`Map` containers around `serializeRoutingInstructionStateJson`, `deserializeRoutingInstructionStateJson`, `loadRoutingInstructionStateJson`, and `saveRoutingInstructionStateJson`.
- Stale state-integrations Jest mocks/specs must not be restored; `hub-pipeline-stage-residue-audit` locks `state-integrations.ts` and `.d.ts` absent.

# 2026-07-11: Responses direct SSE dry-run carrier isolation

- Marker: responses-direct-dryrun-carrier-isolation-20260711.
- `SSE stream missing from pipeline result` can be a dry-run carrier leak, not an SSE transport bug. Confirm by checking `~/.rcc/codex-samples/openai-responses/ports/<port>/<requestId>/provider-response.json`: if `body.body.object=routecodex.pipeline_dry_run`, `stoppedBeforeProviderSend=true`, and current provider request is Codex SSE while metadata points at an older dry-run request, the root is direct provider runtime metadata isolation.
- Fixed owner: `src/providers/core/runtime/responses-provider.ts` `processIncomingDirect()` must build context from the current request runtime carrier, not provider instance `getCurrentRuntimeMetadata()`. Previous behavior allowed stale `__rccDryRunSerialized` from a prior dry-run to stop later live direct SSE before upstream send.
- Regression lock: `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` includes `direct SSE does not inherit provider-request dry-run from previous provider runtime metadata`.

# 2026-07-12: Dry-run closure for provider request/response bugs

- Request-side provider bugs must be verified by provider-request dry-run on the real entry or captured `client-request.json`: evidence is `object=routecodex.pipeline_dry_run`, `kind=provider_request`, final `providerRequest.body/endpoint/headers`, and `evidence.stoppedBeforeProviderSend=true`. If dry-run returns ordinary upstream content, the dry-run loop is broken and must be fixed first.
- Response-side provider bugs must be verified by `npm run dry-run:codex-response -- --sample <provider-response.json>` through `convertProviderResponseIfNeeded`; the script must not grow a second response converter.
- Same-protocol direct chat entry samples can contain Responses provider payloads. For response dry-run, provider payload truth (`object=response`) overrides sample directory/entry endpoint inference, so an `openai-chat` sample may correctly run as `providerProtocol=openai-responses`.
- Offline response dry-run requires materialized body text for SSE. Serialized live `sseStream` snapshots without `bodyText`, `raw`, `text`, or `sseBodyText` are invalid replay inputs and require recapture or a different provider-response sample.
- Installed closeout evidence for this rule: global `0.90.3882`, four live ports healthy, request sample `/Users/fanzhang/.rcc/codex-samples/openai-chat/ports/5520/req_1783772710226_e00fe86c/client-request.json` dry-runs to provider `/responses` with body model `gpt-5.5` and stops before provider send, and response sample `/Users/fanzhang/.rcc/codex-samples/openai-chat/ports/5520/req_1783783139322_87bd6dfa/provider-response.json` dry-runs to `chat.completion` model `gpt-5.5`.

# 2026-07-12: Resource ownership refactor starts with map/gate, not a global manager

- Resource convergence must start from `docs/architecture/resource-taxonomy.md`, `docs/architecture/resource-operation-map.yml`, function-map `resource_bindings`, mainline-call-map `resource_flow`, and `verify:resource-operation-map`.
- M0 resource map currently covers 18 resources: request normal/protocol/provider-semantic, provider wire, response raw/hub/client, metadata runtime/request/response, error chain, route selection, provider runtime observation, continuation scope, dry-run probe, debug snapshot, SSE frame, and servertool followup.
- Resource identity is global per lifecycle, but writes remain stage-bound and feature-owned. Do not implement a global mutable request/response manager before resource ownership and gates identify a unique owner.
- Resource gate proved red/green: a temp function-map binding to undeclared `request.missing_payload` fails; real tree passes `verify:resource-operation-map`, function-map compile gate, mainline call map, mainline manifest sync, wiki sync, and diff check.
- Runtime refactors after M0 must proceed one resource operation at a time. Only remove duplicate/wrong-layer code after resource owner, mainline edge, tests, and relevant live/sample verification prove the old path is not an owner.

# 2026-07-12: Hub Pipeline / VR external refs are host bridge refs, not core runtime TS

# 2026-07-12: snapshot runtime marker InvalidData owner

- `[hub_snapshot_hooks] runtime metadata write skipped ... kind=InvalidData` after a normal `[virtual-router-hit]` is a `snapshot.stage_contract` / runtime marker integrity issue, not VR route selection evidence.
- Verified source root: TS `ensureSnapshotRuntimeMarker` direct `writeFile(target, flag:'wx')` could expose a visible empty/partial `__runtime.json`; Rust `hub_snapshot_hooks.rs::upsert_runtime_metadata_file` used to treat malformed existing runtime metadata as `InvalidData` and skip metadata enrichment.
- Current source fix: TS marker publication uses temp file + `fsp.link(tmp, target)` atomic publish; Rust repairs invalid existing runtime metadata from current runtime truth and records `runtimeMetadataRepair.reason=invalid_existing_runtime_metadata`. Source/native verification passed, but no live/global install closeout was claimed for this slice.

- `sharedmodule/llmswitch-core/src` currently has zero tracked TS-like files, strict llmswitch shell audit reports `prodTsShellCount=0`, rustification/minimal-surface audits report zero production/non-native TS, and `verify-vr-no-ts-runtime` reports zero VR production TS.
- Current Hub Pipeline / VR external-reference closeout work is therefore concentrated in RouteCodex host bridge files under `src/modules/llmswitch`, especially `native-exports.ts` and `routing-integrations.ts`; do not describe these as llmswitch-core or VR runtime TS residue. Current dirty worktree also has a pending deletion of `responses-sse-bridge.ts`, so current-state audits must distinguish tracked-file history from existing working-tree files.
- Correct closeout order: shrink test-only bridge imports first, split broad facades by owner, migrate any remaining TS semantic helper into Rust/NAPI, then delete only zero-ref leaves with residue gates. Host IO shells for streams, MetadataCenter, response store, snapshot writes, and SSE transport remain until an explicit replacement owner exists.

# 2026-07-12: Responses SSE bridge facade is deleted

- `src/modules/llmswitch/bridge/responses-sse-bridge.ts` is physically deleted. `handler-response-sse.ts` is now the only TS transport facade for `/v1/responses` SSE framing and calls `projectResponsesSseFrameForClientNative` / `updateResponsesSseTransportTerminalStateNative` directly through `native-exports.ts`.
- SSE transport keepalive/state seed may remain in `handler-response-sse.ts`; client-visible projection, terminal-state evidence, required_action/tool semantics, repair decisions, continuation save/restore, and stopless/servertool governance remain Rust/NAPI or Chat Process owners.
- Architecture gates now require the deleted bridge facade to stay absent and require the handler to import `native-exports.ts` instead of restoring the duplicate SSE bridge facade.

# 2026-07-12: Responses JSON direct guard now uses direct native evidence

- `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` no longer imports `src/modules/llmswitch/bridge/responses-response-bridge.*`; it validates direct passthrough dispatch and replay-safe client projection through direct Rust/NAPI helper calls.
- `tests/sharedmodule/helpers/resp-semantics-direct-native.ts` exposes `planResponsesJsonClientDispatchWithNative` and allows the existing client payload helper to pass context into `projectResponsesClientPayloadForClientJson`, so the test can prove Rust-owned model/metadata cleanup without preserving a TS bridge test dependency.
- This is a test external-reference contraction only. `responses-response-bridge.ts` remains an active production facade through `handler-response-utils.ts` and is not a dead deletion candidate yet.

# 2026-07-12: Responses response bridge facade is deleted

- `src/modules/llmswitch/bridge/responses-response-bridge.ts` is physically deleted after active production/test/script imports were removed. `handler-response-utils.ts` now calls `planResponsesJsonClientDispatchNative`, `buildResponsesPayloadFromChatNative`, and `projectResponsesClientPayloadForClientNative` directly through `native-exports.ts`.
- Handler-side code remains HTTP/log/snapshot dispatch glue only: request log context and `stripInternalKeysDeep` stay local IO/projection plumbing, while client-visible Responses payload semantics and dispatch policy remain Rust/NAPI-owned.
- Architecture maps and generated wiki pages now bind response mainline `resp-03` and continuation `rct-05` to `handler-response-utils.ts -> native-exports.ts`; gates require the deleted response bridge facade to stay absent.

# 2026-07-12: llmswitch core-loader shell is deleted

- `src/modules/llmswitch/core-loader.ts` is physically deleted. Native binding package/dist resolution is now private plumbing inside `src/modules/llmswitch/bridge/native-exports.ts`.
- Do not restore `core-loader.ts` or a `core-loader.js` source mirror for tests/scripts. Consumers that need the native binding loader should use the approved `native-exports.ts` surface.
- Residue coverage: `hub-pipeline-stage-residue-audit` and `verify:architecture-deleted-path` both lock the standalone core-loader path absent.

# 2026-07-12: Test-only native evidence should bypass host native-exports bridge

- Supersedes the 2026-07-10 test guidance that pointed native evidence tests at `src/modules/llmswitch/bridge/native-exports.js`.
- For test-only native evidence, prefer `tests/sharedmodule/helpers/*-direct-native.ts` or `native-router-hotpath-loader.ts` direct Rust/NAPI helpers, not host `native-exports.js`.
- Runtime/server boundary code may still use host `native-exports.ts` as the N-API shell; this rule is specifically for reducing external test/script references that keep broad host bridge surfaces sticky.
- Current migrated examples: `responses-openai-bridge-metadata-boundary.spec.ts`, `mimoweb-text-harvest.spec.ts`, `provider-runtime-ingress.spec.ts`, `request-executor-native-semantics.spec.ts`, `responses-conversation-store-direct-native.ts`, and `native-exports.responses-sse-contract.spec.ts`.

# 2026-07-12: release snapshot startup requires dependency closure plus import gate

- Installed release startup can fail even when repo `dist` imports pass if `~/.rcc/install/current/node_modules` is incomplete. Verified failure: old `0.90.3917` snapshot missed `ajv`, `axios`, `open`, `openai`, and `rcc-errorhandling`, causing `route-error-hub.js` to crash with `ERR_MODULE_NOT_FOUND`.
- Release install truth now includes two gates: `scripts/install-release.sh` must verify production dependency closure before reusing `node_modules`, and `scripts/install-release-snapshot.mjs` must verify dependency closure plus key runtime imports before switching `install/current`.
- Startup closeout evidence for this class must include installed snapshot dependency scan, direct installed import probe, global `routecodex/rcc --version`, and live `/health` for the target port group. Verified current install: `routecodex-0.90.3917-2026-07-12T005746Z`, no missing production deps, installed `route-error-hub.js` import ok, ports 5520/5555/4444/10000 ready.

# 2026-07-12: route availability uses narrow host and release copy retries EINTR only

- VR route availability/default-floor host calls are contracted through `src/modules/llmswitch/bridge/route-availability-host.ts`; `request-executor-core-utils.ts` must not import broad `native-exports.js` for `evaluateSingletonRoutePoolExhaustionNative`, `planPrimaryExhaustedToDefaultPoolNative`, or `resolveErrorErr05RouteAvailabilityDecisionNative`.
- `route-availability-host.ts` is a thin native re-export only. Rust/NAPI remains the semantic owner for singleton route-pool exhaustion, primary-exhausted default-pool planning, and ErrorErr05 availability decisions.
- Release snapshot install can fail during large `node_modules` copy with `EINTR`. The allowed fix is a limited `fs.cpSync` retry for `EINTR` after deleting the partial target, while still failing visible after retry exhaustion and still running dependency closure/runtime import gates before switching `install/current`.
- Verified install evidence: `0.90.3919` installed after the retry fix; CLI/current package and `/health` on 5520/5555 all report `0.90.3919`; installed route availability host exists and only re-exports native functions.

# 2026-07-12: Responses client projection uses narrow host, not broad native-exports from server handler

- `src/server/handlers/handler-response-utils.ts` must not import broad `src/modules/llmswitch/bridge/native-exports.ts`; Responses JSON client projection calls now go through `src/modules/llmswitch/bridge/responses-client-projection-host.ts`.
- The narrow host is a thin re-export only. Rust/NAPI remains the semantic owner for `buildResponsesPayloadFromChatNative`, `planResponsesJsonClientDispatchNative`, and `projectResponsesClientPayloadForClientNative`.
- Source scan now has 0 `native-exports.js` imports outside `src/modules/llmswitch/bridge` (README/docs excluded). Locking evidence: focused handler-response Jest 5 suites / 21 tests, hub-pipeline residue 227/227, `verify:responses-handler-single-bridge-surface`, function-map compile, architecture mainline call map, strict shell audit, rustification/minimal TS/VR gates, `git diff --check`, and `build:base`.

# 2026-07-12: Resource ownership M0 has named machine gates

- Resource ownership M0 now has queryable gate entrypoints: `verify:resource-operation-map`, `verify:resource-owner-uniqueness`, `verify:resource-mainline-bindings`, `verify:resource-forbidden-writes`, and `verify:resource-side-channel-isolation`.
- These gates currently run the same comprehensive `scripts/architecture/verify-resource-operation-map.mjs` verifier, which validates map parseability, resource id uniqueness, function-map resource binding consistency, mainline resource_flow consistency, required gate script existence, forbidden-writer queryability, and side-channel provider/client body isolation.
- Red evidence for this verifier must mutate a temp copy only: invalid YAML, duplicate `resource_id`, undeclared function-map resource binding, empty `forbidden_writers`, or side-channel `may_enter_provider_body=true` must fail. Real tree must pass the full resource gate suite plus function-map compile, mainline call map, manifest sync, wiki sync, and diff check.
- Runtime refactor remains out of M0 unless a resource owner, allowed writers/readers, forbidden paths, mainline edge, and required dry-run/live/sample verification are mapped first.

# 2026-07-12: Resource ownership scope is project-wide

- The RouteCodex resource refactor scope is the whole project, not `dryrun.provider_request_probe` or any single pilot resource. Dry-run may be used as a low-risk sample, but global progress is measured by function-map `resource_bindings` and mainline-call-map `resource_flow` coverage.
- Use `npm run audit:resource-global-coverage` and `docs/architecture/resource-global-coverage-report.json` before selecting the next resource/domain slice. Current baseline after M0: `15/119` active features have `resource_bindings`; `19/108` mainline edges have `resource_flow`.
- Do not start runtime refactor for a domain until its feature owners and adjacent mainline edges are resource-bound and the relevant verifier/gate exists.

# 2026-07-12: Resource ownership first-layer closed priority mainlines

- First-layer resource coverage now closes adjacent `resource_flow` for `request.mainline`, `response.mainline`, `responses.continuation.mainline`, `servertool.hook_skeleton.mainline`, `error.mainline`, `vr.route_availability.mainline`, and `metadata.center.mainline`.
- Current coverage baseline after first-layer补缺: `31/119` active features have `resource_bindings`; `51/108` mainline edges have `resource_flow`.
- Next-layer resource taxonomy must be expanded before mapping config/WebUI/runtime lifecycle/debug/internal-error/VR diagnostics/hit-log and servertool engine subfeatures. Do not overload request/response/snapshot resources to make these edges appear covered.

# 2026-07-12: Resource ownership second-layer closes config/runtime/debug/VR diagnostics

- Second-layer resource coverage closes config materialization, WebUI config editor, runtime lifecycle, debug/internal-error, VR online diagnostics, VR hit-log projection, and the remaining dry-run mainline gaps without runtime behavior changes.
- Added independent resource identities instead of borrowing request/response/route truth: `config.*` projections, `webui.config_edit_intent`, `runtime.*` lifecycle records, `debug.internal_error_envelope`, `debug.external_error_link`, `debug.client_boundary_proof`, `vr.diagnostic_*`, `vr.hit_log_record`, `vr.telemetry_projection`, and `diagnostic.http_payload`.
- Coverage after `npm run audit:resource-global-coverage`: resources `40`, active feature `resource_bindings` `43/119`, mainline `resource_flow` `91/108`.
- Remaining resource_flow backlog is outside the second-layer scope: stopless session sub-edges, Anthropic/Gemini SSE projection edges, and `stage_a.p0_rust_migration` edges. Do not fill those with second-layer resources; define next-layer resource identities first.

# 2026-07-12: Resource ownership mainline resource_flow reaches full coverage

- Third-layer resource coverage closes the remaining mainline resource_flow gaps for `stopless.session.mainline`, Anthropic/Gemini `sse.chat_stream_projection.mainline`, and `stage_a.p0_rust_migration.mainline`.
- Added independent resources: `stopless.schema_gate_state`, `stopless.runtime_snapshot`, `stopless.cli_projection`, `stopless.cli_result`, `stopless.guidance_rewrite`, `stopless.schema_contract`, `sse.protocol_stream_projection`, `sse.provider_stream_aggregate`, and `stage_a.*` Rust migration boundary resources.
- Coverage after `npm run audit:resource-global-coverage`: resources `53`, active feature `resource_bindings` `50/119`, mainline `resource_flow` `108/108`.
- Remaining resource ownership work is feature-level binding coverage for non-mainline owner surfaces. Do not bind those features to unrelated mainline resources; define owner-specific resources only after the source edge/owner is anchored.

# 2026-07-12: Resource ownership fourth-layer servertool engine feature bindings

- Fourth-layer resource coverage starts after mainline `resource_flow` is already complete at `108/108`; it must add feature-level `resource_bindings` for non-mainline owner surfaces without adding fake mainline edges.
- Servertool engine subfeatures are now represented by owner-specific plan/state/projection/policy resources: `servertool.engine_selection_plan`, `servertool.engine_action_plan`, `servertool.auto_hook_execution_plan`, `servertool.execution_contract_plan`, `servertool.execution_state`, `servertool.registry_projection`, `servertool.cli_projection_plan`, `servertool.flow_presentation`, `servertool.loop_warning`, `servertool.hook_closeout_contract`, and `servertool.orchestration_policy`.
- Coverage after `npm run audit:resource-global-coverage`: resources `64`, active feature `resource_bindings` `73/119`, mainline `resource_flow` `108/108`. The servertool engine priority batch no longer appears in the missing binding list; next backlog starts at `server.runtime_key_resolution`.
- Verified gates for this map-only slice: resource operation map, resource owner/mainline/forbidden/side-channel gates, function-map compile gate, architecture mainline call map, manifest sync, wiki sync, and `git diff --check`.
- Do not treat umbrella/doc/gate features as runtime resources just to increase coverage. If a feature lacks real source owner evidence, leave it as backlog instead of binding it to request/response/route truth.

# 2026-07-12: Resource ownership fourth-layer host/runtime feature bindings

- Host bridge / runtime surface resource binding must model entry shells, native handles, transport envelopes, and projection catalogs as distinct resources; do not bind those features to request/response/route truth just to increase coverage.
- Added host/runtime resources: `runtime.provider_binding_resolution`, `runtime.hub_pipeline_handle`, `runtime.http_entry_dispatch`, `runtime.http_lifecycle_context`, `response.host_conversion_handoff`, `response.inspection_signal`, `models.capability_catalog`, `server.handler_transport_envelope`, `cli.command_dispatch_intent`, `hub.chat_session_usage`, and `response.provider_context_projection`.
- Coverage after `npm run audit:resource-global-coverage`: resources `75`, active feature `resource_bindings` `88/119`, mainline `resource_flow` `108/108`. The host/runtime priority batch no longer appears in the missing binding list; next backlog starts at `error.backoff_action_queue`.
- Verified gates for this map-only slice: resource operation map, resource owner/mainline/forbidden/side-channel gates, function-map compile gate, architecture mainline call map, manifest sync, wiki sync, and `git diff --check`.
- Runtime behavior did not change in this slice. Build/global install/live runtime validation is not required unless runtime code changes.

# 2026-07-12: Resource ownership fourth-layer protocol/conversion feature bindings

- Protocol/conversion feature-level bindings now close OpenAI Chat single-tool-call history compat, Responses function-tool normalization, Responses tool-parameters normalization, Responses instructions-to-input normalization, Responses CRS request compat, web search governance, and shared Gemini conversion without runtime behavior changes.
- Protocol resources must stay owner-specific: `protocol.responses_function_tool_schema` belongs to `responses.function_tool_normalization`, while `protocol.responses_tool_parameters_schema` belongs to `responses.tool_parameters_normalization`. Do not collapse them into one `protocol.responses_tool_schema` resource because that creates ambiguous writer ownership.
- `protocol.web_search_governance_plan` is a `side_channel`; it may be read by Hub/VR/provider outbound control surfaces but must not enter provider body or client body.
- Coverage after this slice: resources `82`, active feature `resource_bindings` `95/119`, mainline `resource_flow` `108/108`, and no missing mainline resource-flow edges. Verified gates: resource operation map/audit, resource owner/mainline/forbidden/side-channel gates, function-map compile, architecture mainline call map, manifest sync, wiki sync, and `git diff --check`.

# 2026-07-12: Resource ownership fourth-layer config codec/path feature bindings

- Config path/codec/coercion feature-level bindings now close `config.path_resolution_surface`, `config.toml_codec`, `config.user_config_codec`, `config.provider_config_codec`, and `config.provider_config_coercion` without runtime behavior changes.
- Lower-level config resources are distinct from high-level materialization resources: use `config.path_resolution_plan`, `config.toml_codec_record`, `config.user_config_text_codec`, `config.provider_config_text_codec`, and `config.provider_config_coercion_plan` for codec/path/coercion owners. Do not bind these owners to `config.runtime_projection` or provider profile projection just to increase coverage.
- Coverage after this slice: resources `87`, active feature `resource_bindings` `100/119`, mainline `resource_flow` `108/108`, and no missing mainline resource-flow edges. Verified gates: resource operation map/audit, resource owner/mainline/forbidden/side-channel gates, function-map compile, architecture mainline call map, manifest sync, wiki sync, and `git diff --check`.

# 2026-07-12: Resource ownership fourth-layer feature bindings complete

- Fourth-layer project-wide feature-level `resource_bindings` coverage is complete without runtime behavior changes: resources `106`, active feature `resource_bindings` `119/119`, mainline `resource_flow` `108/108`, and no missing mainline resource-flow edges.
- Final residual resources must stay owner-specific: error backoff queue, VR route-control surfaces, pipeline/server contract descriptors, apply_patch freeform contract, snapshot/debug observation surfaces, manager/daemon projection surfaces, and SSE dispatch/parser/projection surfaces must not be collapsed into request/response/route truth resources.
- This completion is map/doc/gate truth only. Runtime refactor is a separate goal and still requires selecting one resource owner, proving source anchors, updating tests, and using dry-run/live/sample evidence if behavior changes.
- Verified gates: resource operation map/audit, resource owner/mainline/forbidden/side-channel gates, function-map compile, architecture mainline call map, manifest sync, wiki sync, and `git diff --check`.

# 2026-07-12: Resource source-binding gate before runtime refactor

- After fourth-layer resource coverage reaches `119/119`, the next required layer is source-binding enforcement, not runtime refactor.
- `npm run verify:resource-source-bindings` is the source-binding gate for resource owner features, verification-map entries, function-map source anchors, required gate scripts, declared resource references, adjacent mainline resource flows, side-channel body isolation, and forbidden writer overlap.
- `npm run test:resource-source-bindings-red-fixtures` is the paired red fixture gate; it must fail closed for missing owner features, undeclared resource bindings, missing source anchors, missing required gates, side-channel provider-body leakage, forbidden writer overlap, and fake non-adjacent mainline flows.
- Current source-binding evidence: the gate checks resources `106`, distinct owner source anchors `85`, and mainline flows `108`, while preserving active feature `resource_bindings` `119/119` and mainline `resource_flow` `108/108`.
- Runtime refactor still requires selecting a single resource owner slice and adding behavior tests plus dry-run/live/sample evidence if runtime behavior changes.

# 2026-07-12: Resource source-binding gate is on architecture review path

- `verify:resource-source-bindings` is now part of `verify:architecture-review-surface-light`, so normal build paths that run review-light cannot bypass source-binding ownership checks.
- `test:resource-source-bindings-red-fixtures` is now part of `verify:architecture-ci-longtail`, and `verify:function-map-build-wiring` locks both the green source-binding gate and the red fixture gate wiring.
- If a future resource/runtime refactor changes resource ownership but only passes the standalone verifier, it is not enough; run the architecture review surface to prove the gate is wired into the real build/review path.

# 2026-07-12: RouteCodex `.agent-collab` protocol is the local multi-worker governance surface

- RouteCodex project-local multi-worker collaboration truth lives in `.agent-collab/PROTOCOL.md`; tracked authoring files are `PROTOCOL.md`, `schema/*.schema.json`, and `examples/*`, while runtime state directories `runs/`, `claims/`, `handoff/`, `merge-queue/`, and `KILL_SWITCH` are ignored.
- `architecture.agent_collab_protocol` owns this governance contract through `scripts/architecture/verify-agent-collab-protocol.mjs`; the contract resource is `architecture.agent_collab_protocol_contract` and is explicitly non-runtime.
- Required gate wiring: `verify:agent-collab-protocol` must stay in `verify:architecture-review-surface-light`, `test:agent-collab-protocol-red-fixtures` must stay in `verify:architecture-ci-longtail`, and `verify:function-map-build-wiring` locks both wires.
- The protocol rules are machine-checked: `run_id` is required, `worker_id` optional, claims are semantic (`feature_id`, `resource_id`, `mainline_node_id`, `gate_id`), claim acquisition uses `mkdir .agent-collab/claims/<semantic_id>`, stale heartbeat is not takeover permission, completion requires `evidence.jsonl`, and integration defaults to `handoff/` or `merge-queue/`.
- Current verified baseline after adding this governance slice: `verify:resource-source-bindings` checks resources `107`, owner source anchors `86`, and mainline flows `108`; `audit:resource-global-coverage` reports active feature `resource_bindings` `120/120` and mainline `resource_flow` `108/108`.

# 2026-07-12: `debug.pipeline_dry_run_loop` is the first pre-refactor runtime slice

- First real resource owner slice selected for pre-refactor closure: `debug.pipeline_dry_run_loop.mainline`; owner feature `debug.pipeline_dry_run_loop`, owner module `src/debug/pipeline-dry-run.ts`, resources `dryrun.provider_request_probe` and `snapshot.debug_sample`, edges `ddr-01..ddr-04`.
- `.agent-collab` workflow was exercised with semantic claim `mainline_node_id:debug.pipeline_dry_run_loop.mainline`; unrelated `feature_id:runtime.lifecycle.mainline` claim must be avoided by future workers unless explicitly handed off.
- Runtime refactor admission rule for this slice: first add a failing request dry-run sample or failing provider-response dry-run sample, then fix only the unique owner, then rerun `test:pipeline-dry-run`, request dry-run black-box replay, response dry-run black-box replay when response handling is touched, `verify:resource-source-bindings`, `verify:function-map-compile-gate`, and `verify:architecture-review-surface-light`.
- Current black-box proof: request dry-run on existing port `5520` produced `routecodex.pipeline_dry_run` with `stoppedBeforeProviderSend=true` and final `providerRequest.body`; response dry-run on captured provider response produced `ok=true`, `converted.status=200`, and `converted.body.object=chat.completion`.
- This was pre-refactor evidence only. No runtime behavior change, restart, global install, or release mutation is implied.

# 2026-07-12: runtime.lifecycle is Rust-owned and live restart verified

- `runtime.lifecycle.mainline` decisions and record plans are owned by Rust/NAPI module `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/runtime_lifecycle.rs`; TS lifecycle files are execution shells through `src/modules/llmswitch/bridge/runtime-lifecycle-host.ts`.
- Rust-owned lifecycle plans now cover pid cache write/read validity, stop-intent write/consume TTL, instance write/status transitions, restart transport selection, and explicit `start --restart` takeover refusal. Invalid instance statuses and backward status transitions fail in Rust.
- Release/live truth after closeout: global `routecodex`, global `rcc`, and `~/.rcc/install/current/package.json` all report `0.90.3927`; live `/health` on 5555, 5520, 10000, and 4444 reports `ok`, `ready=true`, `pipelineReady=true`, `version=0.90.3927`.
- In-session restart proof: global `routecodex restart --port 5555 --host 127.0.0.1` changed the listener from pid `63616` to `79326` while parent stayed pid `41955` (`node ~/.rcc/install/current/dist/cli.js start --snap`); `process-lifecycle.jsonl` records `SIGUSR2`, `restart_delegate_parent_supervisor`, and exit code `75`.
- Closeout evidence: cargo `runtime_lifecycle` tests 3/3, focused lifecycle Jest 51/51, runtime lifecycle/resource/function/mainline/wiki/manifest gates, llmswitch rustification audits, `build:native-hotpath`, `build:base`, `install:release`, global version checks, live health, and live restart all passed.

# 2026-07-12: runtime.lifecycle start is launch-only by default

- Follow-up closeout tightened `runtime.lifecycle.start_command`: default `rcc start` and explicit `rcc start --restart` are not restart transports and must refuse an existing listener before stop-intent or `/shutdown`; only explicit `--exclusive` remains the destructive takeover path.
- This supersedes the earlier 2026-07-06 startup note that said `rcc start` still performs managed takeover/restart by default. That old sentence is no longer current after the `runtime.lifecycle.start_command` closeout.
- Rust/NAPI `plan_runtime_start_restart_takeover_guard_json` owns both default-start and explicit-start-restart refusal decisions. TS `start.ts` only observes listener pids and executes the returned plan; `server-runtime-stop-intent.ts` no longer owns the default TTL.
- Release/live truth after the tightened closeout: global `routecodex`, global `rcc`, and `~/.rcc/install/current/package.json` all report `0.90.3930`; `/health` on 5520 reports `ok`, `ready=true`, `pipelineReady=true`, `version=0.90.3930`.
- In-session restart proof: global `routecodex restart --port 5520 --host 127.0.0.1` changed the listener from pid `46976` to `48692` while parent stayed pid `41955` (`node ~/.rcc/install/current/dist/cli.js start --snap`); `process-lifecycle.jsonl` records `SIGUSR2`, `restart_delegate_parent_supervisor`, and exit code `75`.
- Live negative proof: global `rcc start --restart --port 5520` exits nonzero with `start_takeover_refused`, keeps listener pid `48692` healthy, and does not modify the old stop-intent file mtime.

# 2026-07-12: runtime.lifecycle closeout final 0.90.3931 evidence

- Final installed runtime.lifecycle closeout truth is `0.90.3931`: repo `package.json`, global `routecodex`, global `rcc`, and `~/.rcc/install/current/package.json` all report `0.90.3931`; live `/health` on 5520 reports `ready=true`, `pipelineReady=true`, `version=0.90.3931`.
- In-session restart proof for the final build: pid `3967` under supervisor parent `41955` received `SIGUSR2`, emitted `restart_delegate_parent_supervisor`, and exited with code `75`; current listener is pid `11617` with the same parent `41955` running `node ~/.rcc/install/current/dist/cli.js start --snap`.
- Live negative proof for final build: global `rcc start --restart --port 5520` exits `1` with `start_takeover_refused`, leaves listener `node:11617` running, and preserves the existing stop-intent mtime `1783818045`.
- Installed dist scan has zero takeover-adoption residue for `start --restart`, `cli.start.restart_takeover`, and retired install/runtime adoption helper names.

# 2026-07-12: `debug.pipeline_dry_run_loop` has repeatable M1 blackbox fixture gate

- `debug.pipeline_dry_run_loop` M1 is now a repeatable verification framework, not just manual evidence. The gate is `npm run test:pipeline-dry-run-blackbox-fixtures`, implemented by `scripts/tests/pipeline-dry-run-blackbox-fixtures.mjs`.
- The M1 sample matrix lives at `docs/architecture/dry-run-sample-matrix.yml` and records the request artifact, response sample, expected positive fields, negative fixtures, required failure substrings, required gates, and runtime fix admission rule.
- Required runtime admission rule: request-construction bugs must first validate the final upstream `providerRequest` through request dry-run; response-handling bugs must first validate `convertProviderResponseIfNeeded` through response dry-run. Serialized live `sseStream` snapshots without `bodyText/raw/text` are not offline replay evidence and must be re-captured.
- Gate wiring is locked: `verify:architecture-ci-longtail` runs `test:pipeline-dry-run-blackbox-fixtures`, and `verify:function-map-build-wiring` fails if the gate is removed. `function-map.yml` and `verification-map.yml` bind this gate to `feature_id:debug.pipeline_dry_run_loop`.
- Verified evidence: live request dry-run on existing healthy port `5520` produced `routecodex.pipeline_dry_run` with `stoppedBeforeProviderSend=true`, `providerRequestSnapshotWritten=true`, and providerRequest body present; response dry-run produced `ok=true`, `converted.status=200`, and `converted.body.object=chat.completion`.
- The slice remains pre-runtime-refactor: no provider, Hub Pipeline, Virtual Router, restart/install, config, live runtime, or normal request/response behavior changed.

# 2026-07-12: runtime.lifecycle closeout final install advanced to 0.90.3932

- Supersedes the earlier same-day `0.90.3931` final evidence because the final `build:base` advanced package/build truth to `0.90.3932`, then `npm run install:release` installed and restarted the live runtime.
- Final installed runtime.lifecycle closeout truth is `0.90.3932`: repo `package.json`, global `routecodex`, global `rcc`, and `~/.rcc/install/current/package.json` all report `0.90.3932`; live `/health` on 5520 reports `ready=true`, `pipelineReady=true`, `version=0.90.3932`.
- In-session restart proof for the final build: old child `11617` under supervisor parent `41955` received `SIGUSR2`, emitted `restart_delegate_parent_supervisor`, and exited with code `75`; current listener is pid `49119` with the same parent `41955` running `node ~/.rcc/install/current/dist/cli.js start --snap`.
- Live negative proof for final build: global `rcc start --restart --port 5520` exits `1` with `start_takeover_refused`, leaves listener `node:49119` running, and preserves the existing stop-intent mtime `1783818045`.
- Installed dist scan has zero takeover-adoption residue for `start --restart`, `cli.start.restart_takeover`, and retired install/runtime adoption helper names.
[2026-07-12] Hub/VR host wiring tests use owner-specific host mocks

- Verified slice: `hub.runtime_ingress_bridge` / `vr.route_host_effects` test reference contraction. `tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts` and `tests/sharedmodule/hub-pipeline.metadata-center-provider-protocol.spec.ts` mock `routing-native-host.js`, not broad `native-exports.js`.
- Rule: do not force white-box host wiring tests into direct-native helpers when the test needs to inspect mocked native-call arguments. Mock the owner-specific host instead. Reserve `tests/sharedmodule/helpers/*direct-native*` for pure Rust/NAPI output evidence.
- Evidence: focused Jest 3 suites / 240 tests, exact migrated-test `native-exports` scan zero hits, strict TS shell audit, rustification audit, function/mainline/resource gates, VR no-TS runtime, minimal TS surface, `git diff --check`, and `build:base` passed.

[2026-07-12] Responses request-bridge host wiring tests use owner-specific fake

- `tests/modules/llmswitch/bridge/responses-request-bridge.*.spec.ts` host wiring tests must import `tests/modules/llmswitch/bridge/responses-request-handler-host-fake.ts` when they need deterministic handler-host behavior.
- Do not reintroduce `tests/providers/helpers/llmswitch-native-exports-fake.js`, `createNativeExportsMock`, or broad `native-exports.ts` mocks for those white-box request-bridge tests. The helper is mapped under metadata/request-bridge owner surfaces and protected by `verify:hub-pipeline-native-reference-gate`.

[2026-07-12] Provider-response host split gates follow helper source anchors

- After provider-response converter host is split, gate/map evidence must follow the real helper owner files: `provider-response-native-calls.ts` for shared native JSON invocation, `provider-response-effects.ts` for servertool fail-fast/effect execution, and `provider-response-metadata-effects.ts` for MetadataCenter readers/writers.
- Do not satisfy stale gates by moving helper logic back into `provider-response-converter-host.ts`. Update function-map/mainline-call-map/verifiers so they check the split helper files while `convertProviderResponse` remains orchestration-only.

[2026-07-12] Handler/executor monitored tests use responses handler host fake

- `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, and `tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts` must import `tests/providers/helpers/responses-handler-host-fakes.ts`, not broad `tests/providers/helpers/llmswitch-native-exports-fake.ts`.
- `verify:hub-pipeline-native-reference-gate` now rejects monitored white-box imports of broad `llmswitch-native-exports-fake` in addition to broad `native-exports` mocks and `createNativeExportsMock`.

# 2026-07-12: servertool_core_blocks contextual JSON bridge helpers

- `hub.servertool_core_shared_helpers` owns only Rust JSON parse/stringify bridge mechanics in `shared_json_utils.rs` (`parse_json_with_context`, `stringify_json_with_context`); `servertool_core_blocks.rs` consumes those helpers broadly while servertool-core remains the semantic owner for engine/stopless/hook/orchestration/CLI/timeout/policy contracts.
- Required evidence for this slice: `test:servertool-core-shared-helpers-red-fixtures`, `verify:servertool-core-shared-helpers`, `test:servertool-core-shared-helpers-cargo`, servertool rust-only/function-map/mainline/thin-wrapper/rustification gates, native hotpath build, build:base, and wiki sync if generated ownership pages change.

# 2026-07-12: hub_pipeline_lib engine shared JSON/trim helper boundary

- `hub.pipeline_engine_shared_helpers` owns only Rust JSON parse error-context and trimmed-string mechanics through `shared_json_utils.rs` (`parse_json_with_context`, `read_trimmed_string`); `hub_pipeline_lib/engine.rs` consumes those helpers while remaining the owning facade for route selection, req/resp stage orchestration, stopless hook skeleton, context snapshot transfer, and effect plan assembly.
- `execute_hub_pipeline_json` must keep its public `serde_json::from_str(&input_json)?` behavior; do not replace that entry parse with contextual helper unless the public error-code contract is deliberately redesigned.
- Required evidence for this slice: `test:hub-pipeline-engine-shared-helpers-red-fixtures`, `verify:hub-pipeline-engine-shared-helpers`, `test:hub-pipeline-engine-shared-helpers-cargo`, servertool rust-only/function-map/mainline/thin-wrapper/rustification gates, native hotpath build, and `git diff --check`.

# 2026-07-12: VR shared helper first-slice boundary

- `vr.shared_function_library_helpers` owns only exact duplicate Rust VR pure helper mechanics for string/list normalization and reuse of existing tool constants. Its canonical builders are `trim_nonempty_str`, `push_unique_trimmed`, `normalize_unique_trimmed_strings`, and `normalize_trimmed_string_values` under `virtual_router_engine/routing/utils.rs`.
- Bool/number/provider-key/forwarder/default-floor helpers remain out of this first slice; do not merge them until caller-specific semantics are locked by dedicated red tests and route availability / forwarder gates.
- Required evidence for this slice: `test:vr-shared-function-library-helpers-red-fixtures`, `verify:vr-shared-function-library-helpers`, `test:vr-shared-function-library-helpers-cargo`, VR no-TS runtime, function-map compile, mainline call map, llmswitch rustification audit, wiki sync, `build:base`, and `git diff --check`.

# 2026-07-12: Config bridge native JSON invoker boundary

- `hub.config_native_json_invoker_convergence` closes the config bridge portion of the TS native JSON invoker singleton: `config-integrations.ts` uses `native-json-invoker.ts` for native function lookup, JSON argument encoding, JSON result parsing, and fail-fast missing-function behavior.
- Config-specific shape validators stay in `config-integrations.ts`; config semantics and provider/runtime config files remain Rust/native owner territory and were not changed.
- `verify:hub-bridge-native-json-invoker-singleton` now blocks local `JSON.parse` / `JSON.stringify` / `const binding` / `const fn` native JSON call mechanics from returning to `config-integrations.ts`; the red fixture case is `config-local-json-mechanics`.

# 2026-07-12: Responses store host-state probes must use the host store binding

- Pending Responses conversation request entries are in-memory-only until a response id exists; a separate direct-native binding/store instance reloads persisted entries and cannot prove host in-memory pending state.
- Tests that assert state produced by `responses-conversation-store-host.ts` capture/record operations must use host-owned debug wrappers (`hasResponsesConversation*InStore`) or host metrics. Reserve direct-native store helpers for pure Rust/NAPI output evidence, not host store instance identity checks.

# 2026-07-13: Repairable blockers must be fixed forward in multi-worker goals

- For long-running RouteCodex multi-worker goals, a blocker that can be resolved by a forward fix is not a reason to wait, reset, or mark the goal blocked.
- Examples: stale source/map anchors, gate wiring drift, review-surface drift, narrow fixture drift, and other non-destructive source/map/gate consistency issues.
- Required behavior: refresh `.agent-collab`, record evidence, acquire the semantic claim if free, or handoff plus minimal forward-only repair when an active claim owns the low-risk alignment drift; then run the proving gate.
- High-risk production writes, deletes, migrations, release/global install mutation, auth/secrets/payment, and live runtime mutation still need explicit Jason approval or checked handoff.
# 2026-07-13: direct runtime metadata projection Rust owner

- Direct route/provider metadata field selection and control projection are Rust-owned by `direct_runtime_metadata_projection.rs`; TS only performs cycle-aware JSON transport and NAPI invocation.
- A cyclic request graph must be reduced by the Rust route-safe projection before any downstream JSON-only observer such as log-session identifier extraction. Sanitizing only the final VR call is too late because earlier observers can fail first.
- Verified baseline after closeout: direct route-level suite moved from 21 passed / 12 failed to 22 passed / 11 failed; the cyclic image case is green while the remaining SSE/modelId/retry failures are independent owners.
# 2026-07-13: direct model hooks use canonical wire / client alias dual-track truth

- Same-protocol direct must send the configured canonical provider `modelId` on the wire and restore the original inbound alias only on the client response surface. Alias-to-wire and wire-to-client are separate directions, not competing expectations.
- Direct model/thinking planning and bounded response model projection are Rust-owned. TS may preserve stream/object references and execute NAPI/stream IO, but must not infer whether a payload changed or recursively rewrite arbitrary diagnostic `model` fields.
- Native JSON planners that may leave a payload unchanged must return an explicit `payloadChanged`; the TS host uses that Rust decision to preserve identity. SSE frame projection must preserve the original frame whitespace and malformed/terminal data verbatim.
# 2026-07-13: returned direct HTTP status classification is Rust ErrorErr input truth

- router-direct may receive a resolved provider response object whose HTTP status is itself a provider failure. The decision that 401/402/403/429/5xx must enter ErrorErr is Rust-owned; TS may only materialize the planned JS Error and execute the existing error callback/rethrow effects.
- Ordinary 400/404/499 returned responses are negative locks for this specific recoverable-status owner. Do not restore a TS status list, HTTP code synthesis, retry/reroute policy, or client projection in router-direct.
# 2026-07-13: router-direct eligibility is a Rust action plan

- Port mode, effective `sameProtocolBehavior`, provider availability, and inbound/provider protocol compatibility are one eligibility decision owner. Rust emits `skip`, `resolve_provider`, or `execute_direct`; TS performs provider lookup/protocol extraction/IO only.
- A two-stage Rust plan prevents unnecessary provider lookup for an already-skipped port without moving branching truth back into TS. Impossible native actions must fail-fast; they are not an invitation for a TS default/fallback branch.
# 2026-07-13: direct payload audit selection is Rust diagnostic truth

- Direct route audit observes only ordered top-level `model`, `reasoning`, `thinking`, and `max_tokens`. Rust owns this allowlist/order; TS only retains the payload reference and applies the returned projection to request-local audit context.
- Explicit null is preserved, absent/nested lookalikes are omitted, and audit output cannot become provider/client payload or MetadataCenter truth.
# 2026-07-13: router-direct response action is Rust-owned

- Direct response shape/stream action selection is owned by `direct_route_response_action.rs`; TS may observe and preserve non-JSON stream references and execute stream/HTTP IO, but must not decide passthrough vs JSON/SSE projection.
- The native action vocabulary is closed. Unknown or impossible combinations fail-fast; there is no TS default action or fallback path.
- Verified evidence: Rust 2/2, router-direct Jest 36/36, residue/red and required architecture gates, native build, and base build passed.
# 2026-07-13: direct model observation writes use a Rust effect plan

- The existence, family, keys, values, and reasons for router-direct model observation writes are Rust truth. TS only applies the returned effects to an available request-local MetadataCenter carrier.
- A valid effect requires both original client alias and assigned provider wire model; a missing half emits zero writes. Never recreate the pair or reason strings in TS.
- The prior cloned request payload carrier was dead: it was written but neither returned nor consumed. It is physically removed rather than retained as a second metadata path.
# 2026-07-13: direct model observation slice installed/live baseline

- Commit `2a2e5cf` is installed at version `0.90.3932`; global CLIs, install/current, and managed 5555 health versions match.
- Live 5555 Responses provider-request dry-run proves the installed path stops before provider send and emits the final provider request with the expected canonical model. Latest canonical client response sample is HTTP 200.
# 2026-07-13: router-direct runtime metadata attach uses a Rust action plan

- Carrier existence and valid provider-request dry-run control determine a closed Rust `skip` / `attach` action. TS may preserve opaque/non-JSON carrier fields and execute symbol attachment, but cannot infer attach or propagate dry-run independently.
- Invalid or disabled dry-run control projects to no control; missing runtime carrier always skips. Unknown actions fail-fast with no attach fallback.
# 2026-07-13: provider-request dry-run relay defect confirmed

- On 5555, a provider-request dry-run is green on same-protocol direct but fails with HTTP 502 when VR selects a relay OpenAI-chat target: the `routecodex.pipeline_dry_run` envelope incorrectly enters Hub response parsing and is rejected for missing `choices` (`500-220`).
- This is deterministic by selected route, not a restart readiness race. The repair owner must make provider-request dry-run terminal before relay response conversion while preserving the final provider request evidence; retrying until a direct provider is selected is invalid verification.
# 2026-07-13: provider-request dry-run terminal action is Rust-owned before provider postprocess

- A provider-request dry-run response is terminal immediately after provider transport returns. It must not enter provider response postprocessing or Hub response conversion.
- Rust owns the closed `return_dry_run_terminal` / `continue_normal_response` action. TS may only observe the opaque internal response marker and execute the action; payload-shape predicates and response-parser dry-run exceptions are forbidden.
- Live relay proof: `/v1/responses` dry-run with `glm-5.2` selected `orangeai.key1.glm-5.2` and returned HTTP 200 with `object=routecodex.pipeline_dry_run` and `stoppedBeforeProviderSend=true`, eliminating the prior route-specific `500-220 missing choices` failure.
# 2026-07-13: provider-response MetadataCenter sync planning is Rust-owned

- `hub.provider_response_metadata_sync_effect_plan` owns provider-response post-conversion MetadataCenter binding and write selection in Rust. The only legal write targets are `runtime_control.stopless`, `runtime_control.stopMessageCompareContext`, and `debug_snapshot.hubStageTop`.
- TS may observe request-local MetadataCenter identity, read opaque bridge snapshots, and execute the closed Rust plan; it must not choose keys, reasons, actions, or synthesize writes. Unknown actions fail-fast.
- Verified with Rust 2/2, converter Jest 22/22, required architecture/native/build/release gates, installed `0.90.3932`, managed 5555 restart, and a real relay `/v1/responses` HTTP 200 replay with no internal metadata/control leakage.
# 2026-07-13: provider-response retired servertool action handling is Rust-owned

- `hub.provider_response_servertool_retirement_effect_plan` owns validation and closed `continue` / `reject_legacy_actions` planning, including optional stop-gateway MetadataCenter write and the rejection message.
- `provider-response-effects.ts` may call the native planner, execute the returned write, return unchanged payload, or throw the returned error. It must not inspect action arrays, extract stopGateway, or own writer/reason/error strings.
- Verified by Rust 1/1, provider-response Jest 261/261, required architecture/native/base/release gates, installed `0.90.3932`, managed 5555 restart, and real relay HTTP 200 replay without internal action/control leakage.

# 2026-07-13: provider-response stopless runtime-control effect planning is Rust-owned

- `hub.provider_response_stopless_runtime_control_effect_plan` consumes the direct canonical `StoplessMetadataCenterWritePlan` shape. It must not reuse the generic `{ plan: ... }` projector contract or add compatibility fallback.
- Rust owns `no_op` / `apply_runtime_control`, the allowed `stopless` and `stopMessageCompareContext` projection, learned-note exclusion, writer/reason, and malformed/unknown-field rejection. TS only executes returned MetadataCenter IO and rejects unknown actions.
- Verified by Rust 1/1, provider-response Jest 261/261, required architecture/native/base/release gates, installed `0.90.3932`, managed 5555 restart, and real relay request `req_1783904054042_3dbaf9a4` returning HTTP 200 `pong` without internal stopless/runtime-control leakage.

# 2026-07-13: provider-response stream-pipe validation and action selection are Rust-owned

- `hub.provider_response_stream_pipe_effect_plan` owns `no_pipe` / `use_pipe`, canonical codec/requestId normalization, object payload validation, and malformed errors in Rust.
- TS may consume the returned pipe for Node SSE IO, return null for `no_pipe`, and reject unknown actions. It must not inspect streamPipe fields or recreate malformed-shape policy.
- Verified by Rust 1/1, provider-response Jest 261/261, required architecture/native/base/release gates, installed `0.90.3932`, managed 5555 restart, and relay SSE request `req_1783905286656_132cccdc` completing with `STREAM_PIPE_OK`, `response.completed`, and `response.done` without internal effect leakage.
# 2026-07-13: Complete Rust effect arguments pass unchanged to host IO

- When a Rust planner emits a complete serializable effect/store argument object, the TS executor must pass it unchanged to the host IO function.
- Rebuilding the object, truthy-filtering optional fields, or repeating owner/default constants in TS creates a second semantic owner even when the final operation is filesystem/stream/HTTP/store IO.
- Lock this boundary with a direct-object positive assertion and residue negatives for TS constants, optional spreads, and local reconstruction.
# 2026-07-13: Runtime effect shape validation belongs to the Rust consumer

- TS must not use `asRecord` or equivalent coercion to turn malformed Rust effect arrays/scalars into null before native consumption.
- The Rust consumer owns parse errors and the accepted object/null shape; TS may only project absent `undefined` to JSON null at the transport boundary.
- Pair canonical object/null positives with malformed array/scalar negatives and a residue gate that forbids TS coercion revival.
# 2026-07-13: Diagnostic alarm messages are Rust-owned effects

- Provider-response diagnostics are not harmless TS logging glue: alarm selection, normalization, details serialization, and complete message formatting belong to the Rust effect planner. TS may only perform the host console IO.
- A managed `/v1/responses` entry generates request-local session truth when the caller omits a session header, so `stopless_missing_session_id` cannot be forced naturally by header omission. Verify emit with the real native-binding integration path and verify no-op/payload isolation with live replay; do not mutate live config to manufacture the alarm.

# 2026-07-13: Provider-response total-plan materialization is Rust-owned

- Provider-response host code must pass the total native response plan to one Rust materializer. Rust owns payload/requestId/diagnostics/effect-plan validation and returns the closed payload, diagnostic input, and normalized runtime effects.
- TS may execute console, MetadataCenter, store, and stream IO, but must not inspect nested native-plan semantics, normalize effects, or retain a native-plan context cache. Old narrow normalize exports must be physically removed rather than aliased.
- Verified with Rust positive/negative 2/2, provider-response Jest 27/27, required architecture/native/build/release gates, installed `0.90.3932`, managed 5555 restart, and cross-protocol relay request `req_1783911950468_327981fa` returning HTTP 200 without internal carrier leakage.

# 2026-07-13: direct semantic classification top-down contract

- Provider/model authoring exposes one closed `direct.semantics` enum: missing or explicit `routing` keeps canonical routed model/thinking behavior; explicit `passthrough` preserves direct request and provider response model/thinking fields. Unknown values fail validation.
- `ConfigDirect02ValidatedPolicy` compiles only deterministic `config.provider_profile_projection`. After final real-target selection, `VrDirect03ResolvedSemantics` is the sole writer of request-scoped `direct.semantic_policy`.
- Direct request and response projectors consume the same resolved contract independently. Response projection must not depend on request projector output or infer class from payload deltas, `originalClientModel`, provider names, forwarder state, or MetadataCenter.
- The lifecycle is a side chain, not a new Hub request-mainline node. Current runtime remains unchanged while `dsc-01` through `dsc-04` are `binding_pending: true`.
- 2026-07-13：provider-response debug stage record 也是 Rust effect contract。`planProviderResponseStageRecorderEffectJson` 唯一拥有 stage9/stage10 名称、protocol 与 payload envelope；TS 只在 recorder 存在时执行 `record(stage,payload)`。已由 Rust 2/2、Jest 27/27、residue 234/234、build/release 及 5555 live `req_1783914007571_505e44b3` 验证。

# 2026-07-13: direct semantic classification runtime correction and live routing truth

- Supersedes the earlier design-only statement that `dsc-01..dsc-04` were pending. All four edges are now anchored to real Rust symbols, and architecture review reports `direct.semantic_classification.mainline: anchored=4, binding_pending=0`.
- Route-tier thinking is a separate runtime truth, not a `routeParams` field. The only accepted chain is `RoutePoolTier.thinking -> SelectionResult.route_thinking -> target.routeThinking -> VrDirect03ResolvedSemantics.route_thinking`; `routeParams.thinking` compatibility was physically removed.
- Tests for this lifecycle must use the real top-level route-tier authoring shape. Moving `thinking` into `routeParams` is invalid input and cannot prove request projection.
- Managed 5555 routing is verified on installed `0.90.3932`: same-entry provider-request dry-run projected `gpt-5.5` plus route `high` over client `low`; real JSON restored `client-visible-live-model`; real SSE restored `client-visible-sse-model` and route `xhigh`; provider/client artifacts contained no internal direct policy or MetadataCenter fields.
- Explicit passthrough is source/module-blackbox verified but not managed-live verified because no current provider config explicitly declares `semantics = "passthrough"`. Do not modify real provider config or claim live passthrough closure without Jason authorization.

# 2026-07-13: Route pool display uses route classification only

- Route pool authoring `id` / `poolId` is not runtime display truth. Rust `config.user_config_materialization` strips those fields from public compiled routing config, and route isolation uses only `routeParams.routePolicyGroup`.
- Virtual Router hit-log projection prints `routeName -> provider.model`; telemetry `pool` equals the route classification, not the standalone pool name.
- Server log rollup display and aggregation ignore `poolId`; rows group by route classification + provider + model.
- Verified source/config gates passed, including native build, focused Rust config/bootstrap/hit-log tests, focused config/hit-log/log-rollup/usage Jest, TypeScript, touched Rust format, function/resource/mainline/rustification/VR gates, generated wiki sync, base build, target diff check, and `routecodex config validate -c ~/.rcc/config.toml --no-reload`. Live runtime reload/replay was not run in this slice.

# 2026-07-13: Aggregate server restart supersedes single-port restart

- Supersedes the 2026-07-06 rule that treated explicit `restart --port` as a single-port lifecycle action.
- RouteCodex restart identity is one aggregate server process/listener PID set. `--port` is only a locator for that instance.
- Configured/listening member ports with the same PID identity receive exactly one `/daemon/restart-process` or SIGUSR2 request. Different non-empty PID identities fail before restart IO; per-port restart loops are forbidden.
- Restart success requires every configured member port to return healthy with one listener identity. The original managed parent/session restart contract remains unchanged.
- Verified on 2026-07-13: focused positive/negative restart contracts passed 23/23; TypeScript, runtime lifecycle/function-map/mainline/wiki/browser/native/base/release gates passed. Global install used locator 5520 and emitted one aggregate restart. PID changed `52949 -> 85361` under the same parent `24613`; 4444/5520/5555/10000 all reported ready/pipelineReady with version `0.90.3932`.

# 2026-07-13: direct semantic classification explicit passthrough was temporarily managed-live verified

- Supersedes the earlier same-day statement that managed-live explicit passthrough was unproven. Jason authorized a bounded real-config probe, not a production rollout. The temporary `[provider.models."gpt-5.5".direct] semantics = "passthrough"` block was removed after evidence capture.
- Installed `0.90.3932` on managed 5555 proves request passthrough: route `tools` has `thinking=xhigh`, but provider-request dry-run selected `cc.key1.gpt-5.5` and preserved client model `client-visible-passthrough-model` and effort `low`.
- JSON and SSE prove response passthrough. JSON provider/client responses both carried `gpt-5.5-anyint` and effort `low`. SSE provider/client frames are identical after removing only the client transport keepalive prefix and preserve model/effort/event sequence/text/terminal `[DONE]`.
- Real retry proves policy is request-target scoped: passthrough `cc` sent an invalid client model unchanged and failed 403; reroute selected routing `asxs.crsa.gpt-5.5`, whose raw response used canonical `gpt-5.5-2026-04-23` plus route `xhigh`, while client projection restored the original client model. No passthrough classification leaked across the target switch.
- Provider/client/error artifacts contain no internal direct policy, projector contract, or MetadataCenter carrier. Current design/runtime/Rust/Jest/resource/function/mainline/wiki/review/TypeScript/diff gates are green; direct mainline remains 4/4 anchored with zero pending.
- Current production config has no explicit direct passthrough policy. After withdrawal, `routecodex config validate` passed, one aggregate restart restored all four member ports at `0.90.3932`, and provider-request dry-run `direct-routing-after-config-withdrawal-*` projected canonical `model=gpt-5.5` plus route `reasoningEffort=xhigh`. Validation authorization must never be treated as rollout authorization.

# 2026-07-13: Request payload copy budget uses lazy ownership, not semantic trimming

- Request payload memory reduction must preserve exact live semantics. Legal optimizations are ownership moves, borrowed references, delayed materialization, and debug/snapshot-only containment; trimming real request/response payloads is forbidden.
- Retry seed now borrows object payloads on the successful first-attempt path and clones only when retry/reentry restore is actually requested. Success-path response conversion can read the borrowed source reference.
- Rust req_inbound Responses capture should borrow before mutation, then move raw request ownership into the normalized request owner. Do not hold raw and normalized full-payload copies at the same time unless a contract explicitly requires both.
- Verified source/native/build gates: request payload copy budget Jest/Cargo verifier, resource/function map gates, native hotpath build, and base build. No release/global install or live large-payload replay was run for this slice.

# 2026-07-13: Relay continuation store writes are Rust-planned Chat Process effects

- `/v1/responses` relay continuation save has one writer: Rust `publishResponsesRecordPlanJson` emits ordered `continuationStoreEffects` (`record_response` before `finalize_retention`) at `ChatProcRespContinuation07CanonicalSaved`; TS may only execute the returned store IO.
- Handler/request-bridge post-pipeline save helpers are forbidden continuation writers. Do not restore `finalizeResponsesPipelineResultForHttp`, `seedResponsesToolCallResponseForHttp`, `recordResponsesResponseForHttp`, or `readResponsesResponseIdFromHttp` as response-side relay save logic.
- Source gates passed for this slice: continuation writer uniqueness verifier/red fixture, focused Jest/Rust continuation suites, function/native/rustification gates, architecture mainline/wiki/manifest gates, `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`, and `git diff --check`.
- Remaining boundary: this is source/build closure only. Live install/restart/replay still requires explicit authorization and must not be implied by source gates.

# 2026-07-13: Hub standardization should consume owned payload parts

- Hub request standardization should avoid temporary wrapper objects that force the standardizer to clone large `payload` values back out of borrowed JSON.
- Use an owned parts entrypoint when the caller already owns the payload and normalized metadata. Keep the wrapper entrypoint only for external/NAPI compatibility and prove both paths are byte-equivalent at the Value level.
- This reduces internal copy count without changing `standardizedRequest` / `rawPayload` output contracts. Further reductions must not delete required semantic branches without a contract and test update.

# 2026-07-13: Responses request bridge writer and prompt finalization are Rust-planned

- For `/v1/responses` request pipeline metadata, Rust must emit complete MetadataCenter write descriptors including `writer.module`, `writer.symbol`, and `writer.stage`; TS bridge must pass `write.writer` unchanged and must not branch on `write.family` to select writer identity.
- System prompt override for Responses is split: TS may read optional prompt content from env/FS host IO via `getSystemPromptOverride()`, but Rust `finalizeResponsesHandlerPayloadForHttpJson` owns whether/how that prompt mutates `/v1/responses.instructions` and how it combines with existing instructions.
- Do not restore `applySystemPromptOverride` inside `responses-request-bridge.ts`, local `RESPONSES_PIPELINE_*_WRITER` constants, or `write.family === 'continuation_context' ? ...` writer branches. The residue gate is `npm run verify:responses-request-bridge-total-plan-shrink`.
- Verified source/build gates passed for this first cut, including Rust/Jest/TypeScript/native/base build. This does not close the full request-bridge total-plan slice; continuation action, client error descriptor, and errorsample classification still need later Rust total-plan work.

# 2026-07-13: Responses request bridge errorsample classification is Rust-planned

- Malformed `/v1/responses` inbound tool-history errorsample classification belongs to Rust `planResponsesInboundToolHistoryErrorsampleForHttpJson`, not the TS request bridge.
- TS may convert an `Error` into a serializable record, call the Rust plan, add a current timestamp, and execute `writeErrorsampleJson` file IO. It must not branch on `MALFORMED_REQUEST`, `Tool history contract violated`, or `toolHistoryContractViolation`.
- The residue gate is `npm run verify:responses-request-bridge-total-plan-shrink`; focused proof includes bridge Jest `responses-request-bridge.tool-history-errorsample.spec.ts` and Rust `inbound_tool_history_errorsample_plan`.

# 2026-07-13: Responses resume-error projection is Rust-planned

- `/v1/responses` request bridge resume-error projection belongs to Rust `planResponsesResumeErrorForHttpJson` / `plan_responses_resume_error_for_http`.
- TS may serialize a thrown error into `{name,message,status,code,origin,details}`, call the Rust plan, return the exact `client_error` descriptor, or rethrow the original error for `rethrow`. It must not keep split builder/projectability helpers or local defaults such as `responses_resume_failed` / `Unable to resume Responses conversation`.
- Residue gate: `npm run verify:responses-request-bridge-total-plan-shrink`; focused proof: Rust `responses_resume_error_plan`, bridge Jest client/non-client resume-error cases, and native binding smoke for `planResponsesResumeErrorForHttpJson`.
- Current source closure still does not close the full §11.16 request-bridge slice; continuation action execution effect arguments and live replay remain.

# 2026-07-13: Stopless third consecutive stop is original-response passthrough

- Stopless repeat count is a same-session consecutive missing/invalid-schema stop streak. Rounds 1 and 2 project CLI with `repeatCount=1/2`; round 3 reaches the limit and passes the original provider `finish_reason=stop` through unchanged. It must not project another CLI or synthesize a budget-exhausted terminal response.
- Non-stop progress, ordinary tool calls, valid terminal schema, `simple_question=true`, and session changes reset the streak. A later missing/invalid stop starts at `repeatCount=1`.
- CLI/manual `repeatCount >= maxRepeats` is invalid and must fail fast. Do not clamp it or restore the removed `build_terminal_stopless_output`.
- Repeated relay submit capture must use the materialized Chat Process payload when `MetadataCenter.continuation_context.responsesResume` exists. Raw HTTP `{tool_outputs}` is entry evidence only and must not replace the restored model/base payload.
- Verified source/build evidence: stop-message 22/22, servertool CLI contract 51/51, router-hotpath stopless 81/81, request-executor Jest 16/16, servertool CLI and stopless HTTP blackboxes, Rust-only/function/resource/mainline/wiki gates, TypeScript, target rustfmt, `build:base`, and diff check. The HTTP blackbox made exactly three upstream requests and returned the third original stop with no fourth CLI.
- This is source/build closure only. No release/global install, aggregate restart, or managed live replay was performed for this slice.

# 2026-07-13: Stopless third-stop passthrough is globally installed and managed-live verified

- Supersedes the same-day source-only closure gap. Global `routecodex`, `rcc`, install/current, and aggregate health now agree on release `0.90.3934`; configured members 4444/5520/5555/10000 are ready and pipelineReady.
- Release installation used one aggregate restart signal at `2026-07-13T13:58:56Z`; do not repeat restart per member port.
- Real managed sample `req_1783951138541_630f931a` proves the at-limit contract on the installed build: `stopless.active=true`, `repeatCount=3`, managed provider `orangeai.key1.glm-5.2`, original response completed, and no `reasoningStop`, `exec_command`, synthetic budget-exhausted response, or fourth CLI reached the client.
- A naked `/v1/responses` probe that lacks stopless runtime control is invalid evidence even if it asks the model to emit stop schema. Record it as `invalid_direct_or_no_stopless_path`; use real Codex managed request/runtime evidence for stopless acceptance.

# 2026-07-13: Responses request bridge continuation effects are Rust-planned

- `responses-request-bridge.ts` is host IO only for continuation execution: it may execute Rust-returned `lookup_continuation`, `materialize_provider_owned_submit`, `resume_relay`, and `materialize_scope` effects, then return the IO result plus opaque `resultPlanInput` to Rust.
- Rust `planResponsesContinuationRequestActionJson` owns response-id selection, lookup options, direct `previous_response_id` mutation, direct materialized input merge, relay resume args, scope materialize args, endpoint selection, resume metadata, missing/not-found/unknown-owner client descriptors, malformed result fail-fast, operation-token mismatch fail-fast, and final ok/expired/client-error descriptors.
- Request bridge must not restore local response-id/owner/scope/endpoint/default selection, resumeMeta parsing, materialized input merge, or relay-specific request-context reconstruction helpers. `buildCapturedRelayResumeRequestContextForHttp` is dead and removed; rct-03 binds `buildResponsesRequestContextForHttp -> captureReqInboundResponsesContextSnapshotJson`.
- Source/native/build closure evidence passed: Rust continuation action tests 7/7, request bridge Jest 28/28, submit handler 5/5, handler-executor E2E 17/17, total-plan positive/red gates, TypeScript, function-map compile gate, handler/native/rustification gates, architecture review/light with wiki/html sync, native hotpath build, base build, rustfmt target check, and diff check. Live install/restart/replay remains unauthorized and unproven.

# 2026-07-13: Provider-response converter preserves raw error evidence

- `src/server/runtime/http-server/executor/provider-response-converter.ts` is not an ErrorErr classifier. SSE wrapper handling may capture raw message/code/status/upstream fields under `response/details`, but it must not write normalized `code`, `status`, `statusCode`, `retryable`, or `upstreamCode`, apply provider-configured mapping, or classify rate/context/network/SSE errors by message.
- Gate: `npm run verify:provider-response-errorerr-bypass-closeout`; negative fixtures: `npm run test:provider-response-errorerr-bypass-closeout-red-fixtures`.
- This does not yet close provider-response ErrorErr item 3. `request-executor-provider-send-failure.ts` still owns a TS remap/retry predicate and must be migrated to the Rust ErrorErr decision chain before error-path closure.

# 2026-07-13: Provider-response TS SSE remapper is physically deleted

- Supersedes the same-day statement that `request-executor-provider-send-failure.ts` still owned `remapBridgeSseErrorToHttp`: the executor/report-plan TS remap and SSE message/status stage inference are absent in source and locked by `npm run verify:provider-response-errorerr-bypass-closeout`.
- `provider-response-sse-error-normalizer.ts` and `provider-response-converter-empty-sse.spec.ts` are dead semantics and must remain deleted. The provider-response ErrorErr verifier and red fixtures fail if either file is revived.
- Current source gates passed for this cleanup: positive/red provider-response ErrorErr gates, converter Jest 25/25, raw SSE focused Jest 2/2, provider failure stage regression 3/3, TypeScript, ErrorErr contract, function-map compile, host-split, resource-operation-map, manifest sync, wiki HTML sync, native hotpath build, and target diff check.
- Remaining closure gaps: `failure_policy.rs` still classifies 401/402/403/404 as unrecoverable under an active default-pool claim, so 403/quota/account provider errors are not fully proven reroutable; architecture/base gates are independently blocked by servertool `sth-req-03` missing `inject_reasoning_stop_tool`; no release/global install/restart/live replay was authorized or run.

# 2026-07-13: Servertool hook skeleton call-map drift is unblocked

- Supersedes the same-day provider-response cleanup note saying architecture/base gates were blocked by `servertool.hook_skeleton.mainline sth-req-03 -> inject_reasoning_stop_tool`.
- Current source truth is `sth-req-03` request-side servertool injection maps to `maybe_apply_servertool_orchestration` in `req_process_stage1_tool_governance_blocks/servertool_injection.rs`. The old `inject_reasoning_stop_tool` symbol is not the call-map callee for this edge; stopless schema guidance is represented separately by `stopless.session.mainline` edge `stl-07 -> inject_stopless_system_instruction`.
- Verified gates after map/wiki/generated sync: `npm run verify:architecture-wiki-html-sync`, `npm run verify:architecture-review-surface-light`, and `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base` all passed. A first `build:base` attempt hit a concurrent stopless import compile window, but focused `npm run verify:responses-history-protocol-contract` then passed 96/96 and the full base build passed.
- Remaining provider-response gap is still `failure_policy.rs` 401/402/403/404 recoverability under active `gate_id:default_pool_last_provider_no_remove`. No release/global install/restart/live replay was authorized or run for this continuation.

# 2026-07-13: Default pool singleton is not removable by request-local exclusion

- Supersedes any reading that `excludedProviderKeys` can make a configured `default` singleton terminal. `vr.route_availability_floor` derives default availability from configured default-route targets, emits `defaultPoolSingletonProvider`, and ErrorErr05 retries that same provider with its exclusion removed. Client projection remains forbidden while this configured default target exists.
- The inverse remains locked: a primary-route singleton with a separate default provider is not a default singleton; it must still exclude/reroute to the default pool.
- `RequestExecutor` must clear request-local exclusions after its singleton exhaustion blocking wait before replay. The shared error-action queue is the fixed blocking cycle `1s -> 2s -> 3s -> repeat`.
- Installed release `0.90.3934` proved both native decisions: availability returned `defaultPoolAvailable=true`, `defaultPoolSingletonProvider=true`, `policyExhausted=false`, `mayProject=false`; execution returned `shouldRetry=true`, `excludedCurrentProvider=false`, and an empty exclusion list.
- Managed 5555 is healthy and returned `DEFAULT_POOL_LIVE_OK` for request `default-pool-live-20260713-01`, but its current default route is multi-provider. Therefore managed-live singleton failure/replay remains structurally unproducible without changing real routing config; source, focused blackbox, and installed-native evidence cover the singleton branch without such mutation.

# 2026-07-13: Retired provider-response host effects return no semantic result

- When Rust has already materialized the provider-response payload/effect plan, a retired host effect executor must return `Promise<void>`. An empty retired-action list is host no-op; malformed or non-empty retired actions fail fast in the Rust-owned contract.
- The provider-response host consumes Rust `rawPayload` for body responses and `streamPipe.payload` for stream responses. It must not reconstruct a `HubRespChatProcess03Governed | unchanged` stage result or branch response payload selection on that dead stage union.
- Zero-production-caller TS projection wrappers must be physically deleted, including root native wrappers that turn malformed native output into `{}`. Keep the Rust projector and direct-native contract tests as the owner rather than retaining a TS compatibility export.
- Gate with a pre-fix positive verifier that names every live residue plus negative revival fixtures. Source/build closure requires focused provider-response contracts, TypeScript, function-map/architecture/thin-wrapper/rustification gates, native hotpath, base build, and diff check; it does not imply release or live verification.

# 2026-07-13: StreamPipe effect is metadata-only

- Supersedes the 2026-07-01 requirement that `streamPipe.payload` carry a second full client response and the same-day retired-host statement that stream truth is `streamPipe.payload`.
- `HubRespOutbound04ClientSemantic/rawPayload` is the sole full client-response owner for both JSON/body and SSE delivery. A StreamPipe effect contains only `codec` and `requestId`.
- Rust owns stream shape validation and must reject legacy effect-owned `payload` or `body`. TS may reuse the already materialized top-level response object reference for SSE frame encoding, but it must not copy the full response, reconstruct stream semantics, or fall back between payload owners.
- Regression evidence is `tests/sharedmodule/stream-pipe-payload-ownership.spec.ts`, focused Rust planner/normalizer/materializer tests, provider-response focused Jest, Hub stage residue audit, function/mainline/verification map gates, and `build:native-hotpath`.
- This is source/native/build proof only. It does not prove managed-live RSS reduction until an authorized installed-release concurrent large-payload replay is measured.

# 2026-07-13: Stopless continuation is transparent at the provider boundary

- Relay submit materialization may change the internal endpoint to `/v1/responses`; current-turn stopless state must therefore come from the current `MetadataCenter.continuation_context.responsesResume.toolOutputsDetailed` truth, not an endpoint substring.
- The transparent continuation user prompt is presentation only and must never be parsed as repeat state. Automatic CLI call/result evidence is private control state and must be absent from provider-facing history.
- Stop schema guidance is system-instruction-only. Missing/invalid schema emits the fixed transparent continuation prompt; valid `stopreason=2` emits exact `next_step`.
- Provider-request dry-run is the acceptance boundary: inspect final `providerRequest.body`, require the complete typed/required/optional/value/example schema contract plus the ordinary user prompt, and reject `reasoningStop`, `servertool`, hook identity, function-call output, repeat counters, schema feedback, and internal error markers.
- `npm run verify:stopless-contract-blackbox` passed `no_schema`, `invalid_schema`, and `next_step`, proving `stoppedBeforeProviderSend=true`, no second upstream send, and final provider-body transparency.

# 2026-07-13: Stopless transparent dry-run is globally installed and verified

- Supersedes the source-only closeout gap. Global release `0.90.3934` is installed, one aggregate restart was performed, and CLI/install/current plus configured members `4444/5520/5555/10000` all report ready `0.90.3934`.
- The packaged blackbox lives at `/opt/homebrew/lib/node_modules/routecodex/scripts/tests/stopless-contract-blackbox.mjs`. Executing that absolute script proves its relative imports resolve to the global package `dist`, while the repo working directory supplies only the tracked real-request fixture.
- The installed-artifact gate passed `no_schema`, `invalid_schema`, and `next_step`, inspecting final dry-run `providerRequest.body` for the complete system schema, transparent user continuation or exact `next_step`, internal-marker absence, `stoppedBeforeProviderSend=true`, and no second upstream request.
- Global installer isolated builds must copy tracked governance authoring sources required by architecture gates. Copy `.agent-collab/PROTOCOL.md`, `schema`, and `examples`, but never package runtime `runs`, `claims`, heartbeats, evidence, or kill-switch state.

# 2026-07-13: Provider-origin auth/quota/account/model errors remain reroutable until all pools are empty

- This supersedes older RouteCodex interpretations that provider-origin 401/402/403/404, `INVALID_API_KEY`, `INSUFFICIENT_QUOTA`, `ACCOUNT_DISABLED`, or missing-model errors are inherently unrecoverable.
- Rust ErrorErr03 classifies provider-origin auth/quota/account/model failures as recoverable. Rust ErrorErr05 permits client projection only when the authoritative route pool and configured default pool are both exhausted.
- Local/client contract failures remain a separate class: `MALFORMED_REQUEST`, `CLIENT_TOOL_ARGS_INVALID`, provider runtime request contract, and local response contract are unrecoverable. `client_disconnect` remains health-neutral and does not enter provider reroute/health policy.
- Provider-response Node/TS code may capture raw error evidence and execute host IO, but must not reconstruct normalized status/code/retryability, message-based auth/quota policy, or SSE/provider-response remapping. Classification and execution decisions remain Rust-owned.
- Verified source/native/build evidence: Rust failure policy 47/47; provider-origin auth/quota focused 2/2; local-contract negative 1/1; client-disconnect 1/1; focused executor/Jest; provider-response ErrorErr positive/red gates; ErrorErr/function/architecture/TypeScript/native gates; provider-failure blackbox rerouted 401, 403, and insufficient-quota primary failures to backup with HTTP 200; full base build passed.
- This record is source/native/build truth only. No release/global install, aggregate restart, production configuration mutation, or managed-live replay was authorized for this closeout.

# 2026-07-14: Debug provider replay requires one explicit isolation copy

- `ProviderPreprocessHarness.executeForward` accepts caller-owned captured request/response objects, while provider context, preprocess, and postprocess hooks may mutate their input. Until every harness caller provides a verifiable unique-ownership transfer contract, one independent replay execution graph is semantically necessary.
- The single clone owner is `src/debug/harness/provider.ts::cloneProviderReplayInput`, using Node.js `structuredClone`. JSON stringify/parse compatibility cloning is forbidden because it changes circular, BigInt, undefined, and typed-value replay semantics.
- The captured replay input must retain its original nested values and must not receive provider runtime metadata. The independent execution graph releases with harness/provider execution and cannot become provider/client live payload truth or MetadataCenter state.
- Regression evidence is `tests/debug/harness-provider-payload-copy-budget.spec.ts`, `feature_id: debug.harness_replay_payload_copy_budget`, and `resource_id: debug.harness_replay_execution_copy`.

# 2026-07-14: Legacy DebugUtils deepClone is dead and must stay deleted

- `DebugUtilsImpl.deepClone`, `DebugUtilsStatic.deepClone`, and `DebugUtils.deepClone` had no caller and duplicated a generic full-payload clone API outside the unified debug owner. They are physically deleted.
- `src/utils/debug-utils.ts` remains because `src/utils/logger.ts` still uses `DebugUtilsStatic.sanitizeData`; do not delete or migrate sanitizer/logger behavior without a separate logger/sanitize owner slice.
- Regression evidence is `tests/debug/debug-utils-deepclone-removal.spec.ts`. Reintroducing a clone helper, `structuredClone`, or JSON round-trip clone in `src/utils/debug-utils.ts` is forbidden.

# 2026-07-14: Unified Hub shadow compare must diff by borrowing, not JSON cloning

- `scripts/unified-hub-shadow-compare.mjs` is a debug-only black-box comparison script. Its baseline/candidate debug wrappers must go directly into `diffPayloads`; do not reintroduce `cloneJsonSafe` or `JSON.parse(JSON.stringify(...))` before comparison.
- A real shadow diff must still persist complete baseline and candidate debug outputs through `writeCompareErrorSample`; only the pre-diff comparison clone is removed.
- Regression evidence is `tests/scripts/unified-hub-shadow-compare-payload-copy-budget.spec.ts`, `feature_id: debug.unified_hub_shadow_compare_payload_copy_budget`, and `resource_id: debug.unified_hub_shadow_compare_diff_projection`.

# 2026-07-14: Hub Pipeline retry exclusions are typed native input only

- `route.retry_exclusion_set` / top-level `HubPipelineRequest.retryExclusionSet` is the only native Hub Pipeline retry-exclusion input accepted by the engine/VR path. Flat `metadata.excludedProviderKeys` must not create or mirror retry exclusion truth.
- Compiled `.node` evidence: `tests/sharedmodule/hub-pipeline-engine-failfast-direct-native.spec.ts` proves explicit `providerProtocol="openai-responses"` plus `retryExclusionSet=["openai.key1.gpt-5.5"]` selects `openai.key2.gpt-5.5`, while flat `metadata.excludedProviderKeys` alone still selects `openai.key1.gpt-5.5`.
- §11.16 item 5 source/native/build closeout gates include `verify:hub-pipeline-engine-failfast-closeout`, 13/13 red fixtures, Rust `hub_pipeline_engine_failfast` 11/11, TS executor focused 8/8, direct native replay 2/2, resource/function/mainline/review gates, native hotpath build, base build, and diff check. This does not imply release/global install/restart/live replay without authorization.

# 2026-07-14: Hub bridge actions borrow reads and move mutations

- `hub.bridge_action_payload_copy_budget` is owned by `hub_bridge_actions/pipeline.rs::run_bridge_action_pipeline`.
- Read-only bridge actions borrow raw request/response state. Actions that may mutate state take the exact `Option<Value>` or `Option<Vec<Value>>` owner and return it to the same pipeline slot before the next configured action.
- Ownership transfer must preserve semantic presence: `Some([])`, non-object metadata, and unmatched captured tool results cannot collapse to `None`. Internal retained-owner fields must remain serde-skipped and absent from N-API JSON output.
- Request-outbound bridge history must not clone raw request `tools` when the active history builder does not consume that input.
- This is source/native/build evidence for fewer Rust object-graph copies, not installed-runtime RSS proof. The JSON-string N-API boundary remains a separate open contract.

# 2026-07-14: GLM tool schema sanitizer owns and mutates provider-wire branches

- `conversion.glm_tool_schema_payload_copy_budget` is owned by `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/compat_tool_schema.rs`.
- The GLM sanitizer must consume the already parsed owned provider-wire `Value`; use `remove()` / owned maps / `into_iter()` for tools, shell parameters, `tool_choice`, messages, and tool calls. Do not clone the full payload object or full branch objects before editing small compatibility fields.
- The N-API wrapper remains a thin parse-owned-JSON -> `sanitize_glm_tools_schema_owned` -> serialize path. Do not add a TS fallback, provider-config branch, MetadataCenter carrier, routing hook, or second semantic sanitizer.
- Regression evidence is the Rust source-residue test inside `compat_tool_schema.rs`; it rejects full-branch clone patterns such as `payload_obj.clone()`, `tool_obj.clone()`, `message_obj.clone()`, and `tool_call_obj.clone()`.
- This is source/native/build evidence only. Installed-runtime RSS reduction still requires authorized release install, managed restart, and large-payload replay.

# 2026-07-14: Debug replay scripts should use shallow replay owners for top-level mutation

- `scripts/tools/responses-provider-replay.mjs` is debug-only provider replay. It must not deep-clone captured chat payloads with `deepClone` or `JSON.parse(JSON.stringify(...))` just to default `model`, replace system prompts, or call the Responses request builder.
- Use `createReplayChatOwner` for one shallow top-level owner; use `ensureReplayChatModel` for top-level model mutation; use `replaceSystemMessages` to create a new top-level chat object and message array while preserving unaffected nested message/tool/metadata references.
- Importing replay scripts for unit tests must not trigger provider IO. CLI provider replay remains explicit execution only.
- Regression evidence is `tests/scripts/responses-provider-replay-payload-copy-budget.spec.ts`, `feature_id: debug.responses_provider_replay_payload_copy_budget`, and `resource_id: debug.responses_provider_replay_projection`.
- This rule does not apply to the separate `debug.harness_replay_execution_copy`, which remains necessary for provider preprocess/postprocess mutation isolation until a unique-ownership transfer contract exists.

# 2026-07-14: Debug compatibility probes must yield variants lazily

- `scripts/responses-fai-capture.mjs` is debug-only FAI-compatible Responses capture. It must not build an eager array of full request variants or use `JSON.parse(JSON.stringify(...))`, `structuredClone`, or `deepClone` to prepare compatibility probes.
- Use `buildResponseProbeVariants` as the single variant projection owner. It returns a lazy iterator; early variants only shallow-own the top-level request, and tool-shape variants allocate only the changed `tools` wrappers while preserving shared parameter schema and input/content references.
- Explicit sample mode must fail fast for missing or invalid sample bodies. It must not silently switch to generated variants, because that changes the diagnostic truth from "same request" to "new probe request".
- Regression evidence is `tests/scripts/responses-fai-capture-payload-copy-budget.spec.ts`, `feature_id: debug.responses_fai_capture_payload_copy_budget`, and `resource_id: debug.responses_fai_capture_variant_projection`.
- This rule is source/debug-script evidence only. It does not prove live provider behavior or installed-runtime RSS reduction without authorized provider capture or release replay.

# 2026-07-14: Debug capture overrides should shallow-own the request

- `scripts/responses-sse-capture.mjs` applies only top-level capture overrides after loading or converting a request. It must use `createResponsesCaptureRequestOwner` instead of JSON round-trip, structured, or recursive cloning.
- Top-level `model`, `tool_choice`, `instructions`, and `stream` changes belong to the shallow capture owner. Unchanged `input`, `tools`, parameter schemas, metadata, and extension branches remain borrowed until explicit provider/artifact serialization.
- Importing a provider capture script for tests must not read provider configuration, initialize provider clients, call the network, or write artifacts. Provider capture remains direct CLI execution only.
- Regression evidence is `tests/scripts/responses-sse-capture-payload-copy-budget.spec.ts`, `feature_id: debug.responses_sse_capture_payload_copy_budget`, and `resource_id: debug.responses_sse_capture_request_projection`.
- This is debug-script source evidence only; no provider capture or installed-runtime RSS reduction is proven.

# 2026-07-14: Outbound provider regression requires one fail-fast execution copy

- `scripts/outbound-regression-codex-samples.mjs` reuses one built request across provider attempts, while provider converters and runtimes may mutate their input. Each attempt therefore needs one independent execution graph owned by `cloneOutboundRegressionExecutionPayload`.
- Node `structuredClone` is the sole copy contract. JSON stringify/parse cloning and return-original fallback are forbidden because they change structured values or silently expose the caller-owned request to provider mutation.
- The copy must be created immediately before provider conversion/send and release with that attempt. It cannot become live provider/client payload truth, route truth, MetadataCenter state, provider configuration, or process-global retained state.
- Importing the regression script for tests must not scan configs/samples, initialize providers, rate-wait, call the network, or write artifacts.
- Regression evidence is `tests/scripts/outbound-regression-payload-copy-budget.spec.ts`, `feature_id: debug.outbound_regression_payload_copy_budget`, and `resource_id: debug.outbound_regression_execution_copy`.

# 2026-07-14: RouteCodex V3 Responses direct MVP architecture is project-level Rust-only

- Marker: routecodex-v3-responses-direct-rust-only-20260714.
- V3 is the next RouteCodex project architecture under `v3/`, not a llmswitch-core sub-version.
- The first V3 executable target is `/v1/responses` direct. Relay, continuation, servertool/stopless, TypeScript bridge, dynamic hooks, and V2 compatibility execution are out of MVP scope.
- V3 MVP modules are Rust-owned: `routecodex-v3-config`, `routecodex-v3-server`, `routecodex-v3-runtime`, `routecodex-v3-provider-responses`, and `routecodex-v3-cli`.
- Runtime kernel is the only full lifecycle/resource executor. Flow modules register static hooks only and cannot own independent lifecycles. Shared pure functions own small parser/validator/projector logic; module code orchestrates typed node and hook transitions.
- Responses direct remains a full resource path: config authoring -> validated manifest -> server raw request -> standardized Responses request -> selected route -> direct policy -> provider wire -> transport request -> provider raw response -> client payload -> server HTTP frame.
- Direct provider wire follows the existing direct rule: keep current request semantics as provider wire; no provider-wire preflight, sanitize, repair, raw replay, forced relay, or server/CLI/provider shortcut.
- Canonical draft docs/maps: `docs/design/v3-routecodex-rust-module-boundaries.md`, `docs/design/v3-routecodex-runtime-resource-contract.md`, `docs/goals/v3-responses-direct-mvp-test-design.md`, `docs/architecture/v3-resource-operation-map.yml`, `docs/architecture/v3-mainline-call-map.yml`, `docs/architecture/v3-verification-map.yml`, and `docs/architecture/wiki/v3-responses-direct-mainline.md`.
- Evidence: `npm run verify:v3-architecture-docs`, existing architecture/resource/mainline/function-map gates, wiki/manifest sync, agent-collab gate, package JSON parse, and target diff check passed for the docs slice. This is documentation/map/gate evidence only; no V3 Rust source or runtime execution is complete yet.
# 2026-07-14: Responses SSE utils completed-response projection borrows immutable debug payloads

- Completed `response.completed` event payloads in `sharedmodule/llmswitch-core/scripts/lib/responses-sse-utils.mjs` are already the authoritative debug projection for golden roundtrip; if the immediate consumer only encodes them and does not mutate, return the same object reference instead of JSON-cloning a full response graph.
- Aggregation fallback is only for streams without a completed response; duplicate `response.completed` clone branches inside the aggregator are dead semantics and should be physically deleted, not retained as compatibility.
- Feature/map truth: `debug.responses_sse_utils_payload_copy_budget` owns `debug.responses_sse_completed_response_projection`; it is diagnostic-only and forbidden from provider/client payload truth, route truth, MetadataCenter, provider config, and live runtime state.
- Verification used: focused SSE utils Jest 3/3, resource/function/mainline gates, generated wiki/html sync, TypeScript, and target diff check. This is source/Jest evidence only, not installed-runtime RSS evidence.
# 2026-07-14: Codex sample replay request preparation is path-local copy-on-write

- `scripts/replay-codex-sample.mjs` must not JSON-clone complete captured request bodies just to strip replay-only metadata or project provider-request samples into replayable client requests.
- Use path-local shallow owners for metadata rewriting: preserve unchanged `input`, `tools`, extensions, content blocks, and nested metadata references; do not mutate the captured source sample.
- Provider-request-to-Responses replay conversion is read-only over the captured provider body and returns a new client envelope that borrows typed content blocks, tools, metadata, and stream intent. Non-Responses provider replay can return the original body when no script-local mutation is required.
- Feature/map truth: `debug.replay_codex_sample_payload_copy_budget` owns `debug.replay_codex_sample_request_projection`; it is diagnostic-only and forbidden from provider/client payload truth, route truth, MetadataCenter, provider config, and live runtime state.
- Verification used: focused replay-codex-sample Jest 9/9, resource/function/mainline gates, generated wiki/html sync, TypeScript, no-fallback diff, and target diff check. This is source/Jest evidence only, not installed-runtime RSS evidence.

# 2026-07-14: Cross-protocol matrix canonicalization uses path-local owners

- `debug.cross_protocol_matrix_payload_copy_budget` is owned by `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs::canonicalizeChat`.
- The canonicalizer must not JSON-clone complete chat payloads or function tool parameter schemas. It creates only path-local owners for top-level, metadata, messages, tool-call wrappers/functions, and function-tool wrappers before normalization.
- Unchanged schema branches must keep exact reference identity, and the original chat sample must remain untouched.
- Feature/map truth: `debug.cross_protocol_matrix_payload_copy_budget` owns `debug.cross_protocol_matrix_chat_projection`; it is diagnostic-only and forbidden from provider/client payload truth, route truth, MetadataCenter, provider config, and live runtime state.
- Verification used: focused cross-protocol matrix Jest 2/2, resource/function/mainline/wiki/html/manifest sync, TypeScript, no-fallback diff, target diff check, MemoryPalace mine, and MemoryPalace search. This is source/Jest evidence only, not installed-runtime RSS evidence.

# 2026-07-14: Debug parity coverage should compare directly, not JSON clone

- `debug.coverage_hub_standardized_payload_copy_budget` is owned by `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-envelope-to-standardized-native.mjs::chatEnvelopeToStandardizedWithNative`.
- The coverage helper must not run TS/native standardized outputs through `JSON.parse(JSON.stringify(value))` just to compare them. Use direct `assert.deepEqual` unless a concrete semantic mismatch requires a narrower comparator.
- Feature/map truth: `debug.coverage_hub_standardized_payload_copy_budget` owns `debug.coverage_hub_standardized_parity_projection`; it is diagnostic-only and forbidden from provider/client payload truth, route truth, MetadataCenter, provider config, and live runtime state.
- Verification used: focused coverage Jest 1/1, resource/function/mainline/wiki/html/manifest sync, TypeScript, no-fallback diff, inventory spec, and target diff check. This is source/Jest evidence only, not installed-runtime RSS evidence.

# 2026-07-14: Debug report summaries need one authoritative owner

- `debug.v2_consistency_payload_copy_budget` is owned by `scripts/v2-consistency/comprehensive-consistency-test.mjs::runAllTests`.
- Generate the summary once, assign it to `this.testResults.summary`, then borrow it for artifact serialization and console display. Do not JSON parse/stringify clone diagnostic summaries between those steps.
- The final `JSON.stringify(summary, null, 2)` for report file IO is required serialization, not an in-memory clone helper.
- Feature/map truth: `debug.v2_consistency_payload_copy_budget` owns `debug.v2_consistency_summary_projection` and cannot write provider/client payload truth, route truth, MetadataCenter, provider config, or live runtime state.
- Verification used: focused Jest 2/2, node parse check, resource/function/mainline/wiki/html/manifest sync, TypeScript, no-fallback diff, inventory gate, target diff, MemoryPalace mine, and MemoryPalace retrieval.

# 2026-07-14: Responses split custom_tool_call_output is req-inbound semantic normalization

- Marker: responses-split-custom-tool-output-live-closeout-20260714.
- For `/v1/responses`, `custom_tool_call_output` rows with the same custom-call `call_id` are one semantic async tool output split across chunks. They may be non-adjacent when a separate `wait` function call/output is interleaved. Merge them only in Rust req-inbound context capture before bridge conversion.
- Do not generalize this normalization to ordinary function outputs. A result without a matching custom call remains a true orphan and must fail fast.
- The continuation immutable interval remains hard: after `resp_chatprocess save` and before next `req_chatprocess restore`, `capturedChatRequest`, `entryOriginRequest`, `requestSemantics`, session-only scope, handler, resp_outbound, SSE, and store transport must not restore context, repair history, infer required_action, or rebuild request semantics. Only semantic-equivalent normalization, projection, transport, scope check, and release are allowed.
- Installed-runtime evidence: release snapshot `routecodex-0.90.3934-2026-07-14T055610Z`; `routecodex --version` and `rcc --version` returned `0.90.3934`; active config members 5520/10000/5555/4444 all returned `/health` with `status=ok`, `ready=true`, `pipelineReady=true`, `version=0.90.3934`.
- Live positive evidence: exact diag request `/Volumes/extension/.rcc/diag/error-openai-responses-router-gpt-5.6-sol-20260714T124247513-524573-3922.json` replayed to `http://127.0.0.1:5520/v1/responses` and returned HTTP 200 SSE with stream start for split `call_f7bdbbaec1f947d485d9d0787179c887`.
- Live evidence update: exact sample `openai-responses-router-gpt-5.6-sol-20260714T165507733-527078-6427` contains custom exec output chunks at input 81-84 and 89, separated by a `wait` function call/output at 87-88. Runtime `0.90.3934` replay returned HTTP 200 after owner-based merge; the normalized custom call has one output containing the final `running build-native-hotpath` chunk.

# 2026-07-14: RouteCodex V3 Responses direct MVP has a verified Rust-only controlled-upstream path

- Marker: `routecodex-v3-responses-direct-mvp-implemented-20260714`.
- The project-level V3 runtime lives under `v3/` with Rust crates for config, server, runtime, Responses provider, and CLI. No V3 MVP TypeScript source is allowed.
- The runtime kernel is the only complete lifecycle executor. Static hook registration means callable typed functions/effects that the kernel actually executes; a list of hook names alone is insufficient.
- Small route/response semantics live in one shared pure Rust layer. Hook modules orchestrate. Server uniquely owns HTTP listener/request entry/`V3Server11HttpFrame`; provider uniquely owns Responses wire/auth resolution/HTTP transport/raw response; config uniquely owns strict authoring IO and deterministic validated manifest.
- Responses direct preserves the current request body as provider wire. Missing/unsupported content-type, malformed JSON, provider errors, missing auth env, and invalid config fail explicitly; there is no preflight, sanitize, repair, raw replay, forced relay, or fallback.
- Controlled-upstream evidence covers JSON, SSE byte/content-type preservation, provider-facing wire equality, secret/internal carrier absence, typed node order, typed `V3Error01` through `V3Error05`, wrong method/path non-entry, and CLI smoke through the same runtime kernel.
- Compile locking uses Rust-only/module/static-hook/resource gates plus temporary Rust compile-fail crates proving server and CLI cannot import provider transport.
- Canonical verification: `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`; `cargo clippy --manifest-path v3/Cargo.toml --workspace --all-targets -- -D warnings`; `cargo test --manifest-path v3/Cargo.toml --workspace -- --nocapture`; all `verify:v3-*` gates; `test:v3-compile-fail`; `test:v3-responses-direct-blackbox`; existing architecture/resource/mainline/function-map baselines.
- This proves the controlled-upstream V3 MVP only. It does not claim global installation, production replacement, real-provider reachability, relay, continuation, or servertool/stopless.
# 2026-07-14: Provider golden capture config projection is path-local copy-on-write

- `debug.provider_golden_capture_payload_copy_budget` is owned by `scripts/tools/capture-provider-goldens.mjs::buildDerivedConfig` and writes only `debug.provider_golden_capture_config_projection`.
- Temporary capture configs must own only top-level, `virtualrouter`, `providers`, selected provider wrapper, `routing`, and `httpserver` paths that are rewritten. Unchanged model catalogs, auth/header/extensions, and unrelated config branches remain borrowed until temporary artifact serialization.
- Importing the capture script must not scan provider configuration, write artifacts, spawn RouteCodex, or call provider IO; direct CLI execution is the only capture entry.
- This source/Jest rule does not authorize changes to live provider configuration, `config.toml`, `~/.rcc`, normalization semantics, global install, restart, provider capture, or RSS claims.
- Verification used: focused Jest 2/2, node parse check, resource/function/mainline/wiki/html/manifest gates, TypeScript, no-fallback diff, inventory gate, and target diff check.
# 2026-07-14: Both Hub coverage conversion directions compare without JSON clones

- `debug.coverage_hub_chat_projection_payload_copy_budget` owns `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-standardized-to-chat-native.mjs::standardizedToChatEnvelopeWithNative` parity observation.
- Standardized-to-chat full and minimal fixtures compare already materialized TS/native outputs directly. They must not recreate `stableJson`, JSON round-trip, structured, or recursive clone helpers for equality.
- This complements `debug.coverage_hub_standardized_payload_copy_budget`; parity copy audits must inspect both conversion directions rather than assuming one fixed helper closes the pair.
- Direct CLI parity requires built sharedmodule dist artifacts. Missing `dist/conversion/hub/standardized-bridge.js` is an explicit verification gap, not permission for fallback or a runtime/RSS claim.
- Verification used: focused Jest 1/1, node parse check, resource/function/mainline/wiki/html/manifest gates, TypeScript, no-fallback diff, inventory gate, and target diff check.
# 2026-07-14: Hub chain equivalence sanitization is path-local

- `debug.hub_chain_equivalence_payload_copy_budget` owns `sharedmodule/llmswitch-core/scripts/tests/hub-chain-equivalence.mjs::sanitizePayload` and writes only `debug.hub_chain_equivalence_sanitized_payload`.
- Diagnostic field stripping must not JSON-clone complete protocol payloads. Shallow-own only the top-level object and metadata object when removing `__rcc_tools_field_present`, `__rcc_raw_system`, or `__rcc_provider_metadata` comparison fields.
- Unchanged messages, tools, content/schema, extension, and unrelated branches stay borrowed until the diagnostic diff/JSON comparison boundary.
- Importing equivalence scripts for focused tests must not load built dist modules, run conversion chains, read samples, or call provider/native IO.
- Verification used: focused Jest 2/2, node parse check, resource/function/mainline/wiki/html/manifest gates, TypeScript, no-fallback diff, inventory gate, and target diff check. Direct CLI was blocked by missing `openai-chat` sample, so no runtime/RSS claim.
# 2026-07-14: LM Studio compatibility simulation uses path-local ownership

- `debug.lmstudio_compat_tools_payload_copy_budget` owns `sharedmodule/llmswitch-core/scripts/tests/lmstudio-compatibility-tools-test.mjs::applyLMStudioCompatibility` and writes only `debug.lmstudio_compat_tools_projection`.
- The debug compatibility helper shallow-owns the top-level request and parameters projection and allocates normalized tool/function wrappers only where rewritten. It must not JSON-clone complete messages, tools, schemas, content, or extension branches.
- Unchanged nested request branches remain borrowed until explicit debug network/report serialization, and the caller-owned request stays unchanged.
- Importing the helper for focused tests must not call localhost LM Studio, create report directories, or write artifacts. Direct network execution is a separate explicit action and cannot support RSS/runtime claims unless actually authorized and evidenced.
- Verification used: focused Jest 2/2, node parse check, resource/function/mainline/wiki/html/manifest gates, TypeScript, no-fallback diff, inventory gate, and target diff check.
# 2026-07-14: Anthropic response regression uses the Rust native owner directly

- `debug.anthropic_response_regression_payload_copy_budget` owns `sharedmodule/llmswitch-core/scripts/tests/anthropic-response-regression.mjs::buildAnthropicRegressionProjectionWithNative` and writes only `debug.anthropic_response_regression_projection`.
- The regression script must not import the removed TS `response-runtime-anthropic.js` path or deep-clone the tracked sample. It serializes the payload once at the required JS/Rust native boundary and delegates response semantics to `buildOpenAIChatFromAnthropicMessageFullWithNative`.
- Native envelope/result parsing must fail fast when malformed or when the compiled native artifact/capability is missing. Importing the script must not execute native work; direct CLI execution is the regression entry.
- Verification used: focused Jest 3/3, node parse check, direct local native CLI replay, resource/function/mainline/wiki/html/manifest gates, TypeScript, no-fallback diff, inventory gate, and target diff check. This does not prove installed runtime, live provider equivalence, concurrency, memory RSS, or provider configuration behavior.
# 2026-07-14: Mainline manifest generation reuses one projection

- `architecture.mainline_chain_manifest_payload_copy_budget` owns `scripts/architecture/generate-mainline-chain-manifests.mjs::buildMainlineChainManifest` and writes only `architecture.mainline_chain_manifest_projection`.
- The generator must pass each built manifest directly to `YAML.stringify`; do not recreate `manifestClean` through JSON serialization/parsing. JSON round-trip did not strip null fields and only created a redundant complete graph.
- Importing the generator must not read/write repository artifacts or log. `generateMainlineChainManifests` under direct CLI execution is the sole artifact-write entry, and `verify:architecture-mainline-manifest-sync` locks the generated schema.
- Verification used: focused Jest 2/2, node parse/direct 20-manifest generation, mainline manifest sync, resource/function/mainline/wiki/html gates, TypeScript, no-fallback diff, inventory gate, and target diff check. This is architecture artifact evidence, not runtime request/response RSS evidence.

# 2026-07-14: V3 P0-P2 foundation truth

- P0-P2 completion means P0 docs/maps/gates green, P1 full config.v3.toml compiler through V3ConfigStore, and P2 one Rust CLI process starting every enabled listener with real health probes.
- Config Manifest is declaration/index only. Do not reintroduce single-server, default-tier, provider auth-env, selected provider/model, expanded forwarder, or routing interpretation fields.
- P2 pending endpoints traverse Server -> Debug event -> Error projection -> Server frame. Handler-local errors, provider calls, and business pipeline execution are invalid P2 behavior.
- Verified fixture v3/fixtures/config.p2.toml uses local ports 45444 and 45445. The actual built CLI started both, returned listener-specific health, returned structured pending endpoint errors, stopped through the exact session, and released both ports.
# 2026-07-14: Retry restore must not JSON-compensate clone failure

- `gate_id:retry_seed_no_json_compensation` locks `src/server/runtime/http-server/executor/retry-payload-snapshot.ts` so borrowed retry seeds perform no eager serialization and restore performs no JSON serialize/parse compensation.
- `restoreRequestPayloadFromRetrySeed()` returns an owned `structuredClone` result or explicit `undefined`. It must not revive `serialized` retry seeds, `serializeRequestPayloadForRetry`, `restoreRequestPayloadFromRetrySnapshot`, or shallow-spread snapshot backup.
- This keeps first-attempt residency borrowed and retry/reentry materialization explicit. It does not remove the semantically required independent clone on actual retry while downstream mutation consumers still need isolation.
- Verification used: focused retry payload Jest 4/4, `npm run verify:request-payload-copy-budget`, TypeScript, no-fallback diff, inventory gate, and target diff check.
# 2026-07-14: Snapshot queues require byte and count budgets

- A bounded item count is insufficient for diagnostic queues carrying full provider payloads. The Rust snapshot queue now limits both jobs (default 10) and estimated retained bytes (default 8 MiB), reserves bytes before enqueue, and releases accounting on receive or failed enqueue.
- Estimate diagnostic payload size by borrowing the existing JSON value; serializing solely to compute queue size creates the same temporary memory amplification the budget is intended to prevent.
- Snapshot overflow may drop debug-only artifacts with an explicit reason, but live provider/client payload semantics must remain untouched.

# 2026-07-14: V3 P3/P4 Debug and Error foundation truth

- V3 Debug is one shared Rust runtime across all listeners. It owns ordered events, console/file sinks, retained raw request/response projections, transient snapshots, Dry Run fixtures, and centralized secret redaction.
- Dry Run must use the Runtime foundation entry, return the current execution's transient snapshots, stop with `no_network_send` before Provider transport, then release its snapshot session. Fixture request/response projections must pass through Debug redaction.
- Debug sink/capture/event/snapshot/fixture failures are runtime errors and traverse the global six-node Error chain. Ignoring `Result`, using `expect`, or continuing with memory-only success is forbidden.
- `routecodex-v3-error` is the only owner of `V3Error01SourceRaised` through `V3Error06ClientProjected`. Server projects Runtime output only; it does not classify errors or build action/exhaustion decisions.

# 2026-07-14: V3 P5 Router/Target foundation truth

- V3 Virtual Router truth is `v3/crates/routecodex-v3-virtual-router`: resolve the listener's configured route group, require the explicit `default` pool, consume a non-Clone pool token, and publish exactly one opaque `V3Router07OpaqueTargetHitOnce`. It cannot import Provider health/availability or interpret Provider/Forwarder/auth/model internals.
- V3 Target truth is `v3/crates/routecodex-v3-target`: recursively expand the one opaque direct/Forwarder target, apply deterministic priority/weighted/round-robin order, read Provider availability, and keep invalid-member/availability reselection internal until concrete selection or full selected-target exhaustion. Target never calls Router.
- The P5 Server path must traverse the unique Runtime-owned adjacent contracts `V3Server03HttpRequestRaw -> V3Req04StandardizedResponses -> V3Router05RequestClassified -> V3Router06RoutePoolResolved -> V3Router07OpaqueTargetHitOnce -> V3Target08KindClassified -> V3Target09CandidateSetExpanded -> V3Target10ConcreteProviderSelected`. Server-local duplicate request DTOs and Server03 -> Router05 shortcuts are gated violations.
- Provider configured-disabled state is exposed through Provider-owned `V3ProviderAvailabilityRegistry`; mutation stays private to Provider and Target receives only `V3ProviderAvailabilityReader`.
- Verified live fixture `v3/fixtures/config.p5.toml`: port 45454 skipped disabled `cc`, selected `asxs` on Target attempt 2 with Router hit count 1 and no network send; port 45455 exhausted its selected target and returned the complete six-node Error chain. Exact Ctrl-C closed both ports.
- P5 evidence does not prove P6 Provider transport, real upstream availability, P7 relay/protocol expansion, V2 compatibility, global installation, or `~/.rcc` changes.
- Provider alone owns provider-instance/auth-key/canonical-model cooldown, quota, concurrency, and health mutation. Mutation methods are crate-private; future Target code receives only the read-only availability contract, and Router receives no health dependency.
- Verified dedicated fixture ports remain 45444 and 45445. Actual CLI/HTTP evidence proved shared Debug state, secret isolation, complete pending Error chain, six transient Dry Run snapshots, snapshot release, malformed Dry Run Error projection, exact Ctrl-C shutdown, and closed ports.

# 2026-07-14: Responses bridge input conversion has one borrowed internal core

- `BridgeInputToChatBorrowedInput<'a>` and `convert_bridge_input_to_chat_messages_borrowed` are the internal request projection path for req-inbound context capture and Responses standardization.
- The existing owned converter is a thin wrapper over the borrowed core; do not create a second semantic implementation or clone complete `input`, `tools`, content-block, or tool-call arrays merely to call the projector.
- Independently owned normalized tools/messages may still copy the exact output values they retain. This is output ownership, not permission to restore call-argument owner clones.
- Verification used: focused residue Jest, `verify:request-payload-copy-budget`, resource/function/mainline gates, inventory gate, rustfmt, native hotpath build, and base build. No live RSS improvement is claimed without installed-runtime concurrent large-payload replay.
# 2026-07-14: Terminal provider failure observation

- Final provider failures must preserve the selected target as diagnostic observation on the original error: `providerKey` plus provider wire `providerModel`.
- `ErrorErr06` request logging may render those fields, but must not infer them from text, overwrite existing observation truth, alter message/status/code, change client/provider payloads, or affect retry/reroute policy.
# 2026-07-14: V3 P6 prototype evidence cannot advance architecture binding state

- Verified P0-P5 lifecycle stops at `V3Target10ConcreteProviderSelected` before network send. P6 owns only adjacent transitions `10->11->12->13->14->15->16`.
- Early P6-shaped Rust symbols, unit tests, and controlled-upstream harnesses are prototype evidence until red-first source/compile gates, final owner review, adjacent source binding, and mapped runtime evidence all agree.
- Unverified P6 resources and edges remain `binding_pending` with no caller/callee symbol or source path. `routecodex-v3-provider-responses` is a generic protocol Provider and production source must not branch on deployment provider IDs or provider families.
- Parallel Provider implementation does not block independent contract/map/gate calibration. Contract work proceeds and commits exact non-runtime scope; only actively changing runtime compilation/format checks wait for integration.

# 2026-07-14: V3 P6 generic Responses Provider slice is source-bound

- The generic Rust Provider owns `V3Provider12ResponsesWirePayload -> V3Transport13ResponsesHttpRequest -> V3ProviderResp14Raw`; map edges `v3-rd-10..12` and their three Provider resources are anchored to real source under `routecodex-v3-provider-responses`.
- Provider wire preserves the current request body except the selected wire model; transport resolves environment or token-file auth only at send time; JSON/SSE bytes and typed provider failures stay explicit.
- Controlled-upstream tests and an actual local V3 CLI replay proved JSON/SSE transport, secret isolation, client-disconnect/error polarity, Target-local reselection without Router re-entry, and Server/CLI no transport shortcut.
- `v3-rd-09`, `v3-rd-13`, and `v3-rd-14` remain `binding_pending`; end-to-end smoke does not by itself authorize anchoring those Runtime/client/Server edges.
- Scope excludes relay, continuation, servertool, other protocols, V2 compatibility, global install, real `~/.rcc` mutation, live RouteCodex restart, and real provider traffic.

# 2026-07-14: Controlled upstream failures are required for multi-listener reselection tests

- Do not model provider failure by releasing an ephemeral port before starting RouteCodex listeners. The port can be reused by the process under test and create recursive or unrelated traffic.
- Keep a controlled upstream listener alive, return the intended provider error such as HTTP 503, and shut it down explicitly. Focused raw transport tests may use a closed port only when no subsequent listener allocation can reuse it.
- Verification baseline: ten consecutive target-local reselection replays plus the full V3 workspace and mapped P0-P5 gates.
# 2026-07-14: Default pool floor applies to default-route requests too

- A default-pool floor is not only a cross-route fallback. When a request is already classified as `default`, temporary health cooldown, concurrency busy state, or retry exclusions must not empty all configuration-valid default candidates and project `PROVIDER_NOT_AVAILABLE`/temporary-unavailable errors to the client.
- Rust Virtual Router selection is the unique owner. If normal availability filtering empties the configured default pool, retain its first configuration-valid candidate and mark `defaultFloorProtected=true`; explicitly disabled/unregistered/capability-invalid candidates remain invalid and must not be revived.
- Required regression shape: at least two enabled default providers, both in active recoverable cooldown, positive assertion that the first configured candidate is selected, plus negative assertion that an explicitly disabled-only default still fails fast.

# 2026-07-14: V3 P6 Responses Direct MVP is source and local-live verified

- Marker: `routecodex-v3-p6-responses-direct-live-verified-20260714`.
- Supersedes the earlier Provider-slice-only pending statement: P6 is anchored from `V3Target10ConcreteProviderSelected` through `V3Server16HttpFrame`; `v3-rd-09..14` bind Direct policy, generic Provider wire/transport/raw, Runtime client projection, and Server frame.
- Dry Run rule: Debug registers fixtures and side-channel artifacts but never hard-codes business topology. Runtime supplies the trace and replaces only Transport13 with a no-network transport. Required truth is `provider_pipeline_executed=true`, `provider_network_send=false`, `stopped_before_network_send=true`.
- Server response rule: success enters `build_v3_server_16_http_frame_from_v3_resp_15`; Server does not emit directly from Resp15 or default a missing content type.
- Gates reject Debug-owned topology, Server16 bypass, false pre-Provider Dry Run claims, provider transport outside Provider, route shortcuts, provider identity branches, old Provider nodes, and repair/fallback semantics.
- Local-live evidence: actual V3 CLI on 45464/45465/45466 plus controlled upstreams 45467/45468 proved JSON, raw SSE, wire model/auth boundary, Target-local 503 reselection without Router re-entry, terminal Error01-06 exhaustion, redacted no-network Dry Run, and snapshot release. Exact Ctrl-C stopped processes; ports 45464-45469 closed.
- Boundary: relay, continuation, servertool, other protocols, V2 compatibility, global install, production restart, `~/.rcc` mutation, and real provider calls remain outside P6.

# 2026-07-14: V3 Hub v1 must replace P6 Direct before Relay

- Marker: `routecodex-v3-hub-v1-static-skeleton-contract-20260714`.
- P6 Direct is a verified migration source but not the final Hub Pipeline because it lacks request/response Chat Process, continuation ownership, execution mode, routed/pinned target merge, and a fixed sole response exit.
- Published P6 node numbering cannot accept inserted stages. Build a new Hub v1 chain version, freeze P6 against feature growth, migrate P6 behavior behind static Rust hooks, cut Server to Hub v1 only, then physically delete the old lifecycle. Permanent dual paths and fallback are forbidden.
- Hub branching has four independent axes: entry protocol, continuation ownership, execution mode, and provider wire protocol. Same protocol does not imply Direct; Responses does not imply remote continuation; provider family/model prefix cannot select a Hub branch.
- Non-GPT Responses providers may use RouteCodex-local continuation. Local context is immutable from response Chat Process save through next request Chat Process restore; only round-trip-equivalent normalization, scope validation, storage/transport, expiry, and release are allowed.
- Contract/maps/gates are defined only; all Hub v1 edges/resources remain `binding_pending`. No Hub v1 runtime, Relay, continuation, or additional provider protocol implementation is claimed.

# 2026-07-14: V3 H2 P6 equivalence baseline is verified

- Marker: `routecodex-v3-h2-p6-equivalence-harness-verified-20260714`.
- `v3.responses_direct_h2_equivalence_harness` is the required pre-migration baseline for moving P6 Responses Direct behind Hub v1 hooks. It starts the actual `routecodex-v3` CLI server and controlled upstreams; it must not call internal Runtime kernels, Server library entrypoints, Provider helpers, or H1 symbols.
- Required H2 coverage: JSON, SSE, Target-local reselection with one Router hit, terminal default exhaustion through Error01-06, Dry Run with provider pipeline executed but no network send, Debug side-channel isolation, full client/provider/raw/client response payload observations, secret redaction, and listener/upstream port closure.
- Verification truth: H2 verifier/red fixtures, controlled replay, P6 provider/unit/blackbox, V3 fmt/clippy/workspace, architecture/module/resource/function/mainline gates, compile-fail, diff check, and latest evidence artifact audit passed. Verification-map status is `characterization_harness_verified`.
- Boundary: this does not migrate Hub v1 Direct, switch Server entry, implement Relay/continuation/servertool/other protocols, delete P6, touch V2, mutate `~/.rcc`, global install, restart production, or call a real provider.

# 2026-07-14: Error action backoff is always three seconds

- `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts` is the sole owner and returns a fixed `3000ms` delay for every consecutive error in the same category/scope.
- Do not restore a `1s/2s/3s` or `1s/3s/5s` sequence in provider, executor, or projection layers. Tests, server help, function map, verification map, and error-chain audit docs must assert the same fixed delay.
- Verified by five focused Jest suites (36 tests), function-map compile gate, resource-operation map gate, diff check, and stale-contract scan.

# 2026-07-14: V3 Hub v1 H1 typed skeleton is source-verified

- Marker: `routecodex-v3-hub-h1-static-registry-verified-20260714`.
- P6 Responses Direct remains the only running baseline, but its lifecycle is source-frozen against Chat Process, Relay, continuation, additional entry protocols, provider identity/family/model-prefix branching, dynamic hooks/fallback, second lifecycle, Server->Provider shortcuts, and second response exits.
- Hub v1 H1 owns only the Rust typed skeleton and startup contracts: opaque request/response node types with private fields, 13 unique adjacent builders, four independent branch-axis enums, a closed callable 13-slot static hook registry, deterministic Config manifest validation, and explicit `not_implemented` hooks for unimplemented business branches.
- Config publishes Hub v1 skeleton/protocol/hook/capability/execution/continuation scope declarations only. It must not choose request-specific Direct/Relay, continuation owner, target, provider, model, or hook plan.
- H1 map binding rule: builder edges may be `anchored` only as `binding_kind: h1_typed_test` when tied to real test caller plus real builder symbols; this is not production Runtime call binding. Unimplemented Hub business resources remain `binding_pending`.
- Verified gates: P6 freeze/source red fixtures, H1 static registry/source red fixtures, H1 Runtime tests, Config contract, compile-fail private-field/non-adjacent boundaries, architecture/resource/module/rust-only gates, source/doc red fixtures, cargo fmt, Clippy, workspace tests, and diff check.
- Compile-fail fixture rule: for private node construction evidence, use a valid publicly built previous node and then attempt the private field write. Avoid `todo!()` or wrong field names because they can fail for unrelated warning or unknown-field diagnostics.
- Not completed by H1: Hub v1 Provider network execution, Server `/v1/responses` cutover, Relay, continuation save/restore, additional provider protocols, P6 migration/deletion, global install, `~/.rcc`, live runtime, or real provider traffic.
# 2026-07-14 V3 Config/Server full-function source and runtime closeout

- V3 Config/Server full-function scope is source/runtime verified for the supported subset: config.v3.toml is read through V3ConfigStore; Config publishes declaration-only deterministic manifest surfaces for Hub declarations, route-pool match, provider health/capability/alias/protocol validation, endpoint declarations, execution modes, static hook IDs, and continuation scope declarations.
- V3 Server full-function scope is verified against v3/fixtures/config.full.toml: aggregate startup binds all enabled listeners before spawn; invalid method/path/content-type/body-size/malformed JSON is projected before Runtime through the typed Error chain; synthetic malformed/body-read business payloads are absent.
- Current executable business boundary remains P6 /v1/responses Direct only. In the full fixture, valid /v1/responses reaches the P6 Runtime/Router/Target path and returns selected_target_exhausted because the placeholder provider is disabled; /v1/messages and other non-Responses protocols remain explicit not_implemented.
- Verification evidence: V3 architecture/resource/module/rust-only/static-hook/source-red/compile-fail/fmt/clippy/workspace/build gates passed; actual V3 CLI config check, server status, two-listener HTTP probes, boundary error probes with x-routecodex-v3-error-node and six-node x-routecodex-v3-error-chain, debug status, clean Ctrl-C shutdown, and port-closed probes passed. Browser render verification for the new HTML wiki remains unproven because no browser was available.
- Follow-up render evidence: in-app Browser stayed unavailable, but independent Playwright CLI rendered docs/architecture/wiki/v3-config-server-full-function.html to /tmp/v3-config-server-full-function.png; visual inspection passed after HTML node wrapping CSS was added, and npm run verify:v3-architecture-docs stayed green.

# 2026-07-15: V3 Relay response source slice is verified

- Marker: `routecodex-v3-relay-response-source-slice-verified-20260715`.
- Source scope is strictly `V3ProviderRespInbound01Raw -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed -> V3HubRespContinuation04Committed`; do not cite it as request-side, Config/resource hook, live Relay, continuation end-to-end, Server cutover, P6 deletion, or production runtime completion.
- Unique owner is `v3/crates/routecodex-v3-runtime/src/hub_v1.rs` via `compile_v3_hub_relay_response_hooks()`. Resp02 only checks Relay/object response and records JSON/SSE kind; Resp03 alone harvests tool calls, servertool response action, and terminality; Resp04 alone commits `None` or one local canonical context from Resp03 finalized truth.
- Response payload ownership is `Arc<Value>`; canonical local context uses exactly one `Arc::clone` and the source gate rejects full response/body/context materialization in governance, SSE repair, Resp05, Server handler, required_action inference, and second response exits.
- Verification truth for this slice: focused Rust response test, H1 hub tests, H1 contract test, response semantic/source red gates, V3 architecture/resource/module/rust-only/static-hook/doc gates, compile-fail, cargo fmt, clippy, workspace tests, and diff check passed in a clean verification worktree containing only the staged response slice. The shared worktree also contains unrelated concurrent Config/request/resource edits and must not use those dirty files as response-slice proof.
# 2026-07-15: V3 Relay request source slice Req01-Req04 is source-verified

- Marker: `routecodex-v3-relay-request-source-slice-verified-20260715`.
- Unique owner is `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs`; scope ends at `V3HubReqChatProcess04Governed`.
- Req02 is lossless Chat normalization; Req03 only classifies new/remote/local continuation owner with exact entry/server/group/session scope and rejects dual local+remote truth; Req04 is the sole local-context restore/tool-history/servertool request governance point.
- Request payload moves forward without full `Value` clone or JSON round trip. Local canonical context is `Arc<Value>` and only Req04 restore performs one pointer clone.
- Required proof is focused Rust request tests plus request source/red fixtures, compile-fail topology locks, architecture/resource/module/rust-only/static-hook/docs/fmt, Clippy, and the V3 workspace.
- Do not cite this marker as Req05-Req09, response, resource/hook config, live Relay, continuation E2E, Server cutover, P6 deletion, global install, `~/.rcc`, or production completion.

# 2026-07-15: V3 Relay resource/hook declaration surface is verified

- Marker: `routecodex-v3-relay-resource-hook-declaration-surface-verified-20260715`.
- Unique owners are `routecodex-v3-config/src/types.rs`, `routecodex-v3-config/src/validate.rs`, and `routecodex-v3-runtime/src/hub_v1/resource_hooks.rs`.
- Config is declaration-only: every static hook slot must be declared explicitly with fixed node, entry/exit phase, required/optional requirement, enabled flag, deterministic priority/order, allowed resources, forbidden resources, and optional typed profile. Config still must not choose request-specific Direct/Relay mode, continuation owner, target, provider, or per-request hook plan.
- Runtime is Manifest-only: `compile_v3_hub_v1_static_registry_from_config(&V3Config05ManifestPublished)` borrows manifest hook/resource declarations, rejects missing/duplicate/unknown slots, exposes the closed 15 fixed-node × entry/exit registry, returns typed disabled optional no-op, and surfaces required not-implemented callbacks as explicit errors.
- Servertool hook profile is only valid at `V3HubReqChatProcess04Governed` and `V3HubRespChatProcess03Governed`; do not move servertool to inbound/outbound, provider runtime, direct path, or a separate lifecycle.
- Resource declarations are side-channel only for this slice: `may_enter_provider_body=false` and `may_enter_client_body=false`. Current node payloads are accessed through scoped borrowed views; do not retain, full-clone, JSON-round-trip, SSE-materialize, or snapshot-copy hook payloads as live truth.
- Verified gates: resource/config focused tests, static hook verifier, H1 source red fixtures, dedicated resource verifier/red fixtures, compile-fail borrowed-view lifetime boundary, architecture/resource/module/rust-only gates, cargo fmt, Clippy, V3 workspace tests, and diff check. This marker does not prove live Relay, request/response runtime completion, continuation E2E, Server cutover, P6 deletion, global install, `~/.rcc`, or production replacement.

# 2026-07-15: V3 Relay architecture review surface is locked

- Marker: `routecodex-v3-relay-architecture-review-surface-locked-20260715`.
- `v3.hub_relay_request_semantics`, `v3.hub_relay_response_semantics`, `v3.hub_relay_runtime_resources_hooks`, and `v3.hub_relay_gate_review_surface` are mutually queryable through V3 resource/function/mainline/verification maps and the Relay wiki.
- D gate requires every worker row to bind declared resources and existing mainline steps, match npm-backed gates in function and verification maps, and expose allowed/forbidden paths plus completion limits.
- Fixed node IDs reject fractional/reused forms such as `03a`, `03_1`, and `03.5`; copy budget rejects unbounded deep copy, full SSE materialization, and Debug/snapshot copies as business or continuation truth.
- Verified D gates: `verify:v3-architecture-docs`, `verify:v3-resource-map`, `verify:v3-module-boundaries`, `verify:v3-rust-only`, `verify:v3-static-hook-registry`, `test:v3-hub-skeleton-doc-red-fixtures` with 11 rejected mutations, `test:v3-compile-fail`, and `git diff --check`.
- This marker proves only Relay contracts/maps/wiki/gates. It does not prove live Relay, usable continuation, servertool runtime hooks, Hub v1 cutover, P6 deletion, global install/restart, `~/.rcc`, or production replacement.
# 2026-07-15: V3 Relay payload-copy probes are mutation-gated

- Marker: `routecodex-v3-relay-payload-copy-probes-gated-20260715`.
- `v3.hub_relay_payload_copy_runtime_probes` binds four test-only observations to the existing Relay chain: JSON request move-through, SSE shared canonical response without materialization, local context retention/release, and servertool Resp03/Resp04 to next Req04 ordering.
- Runtime ownership evidence is paired: executable probes assert visible semantics and `Arc` sharing; the source gate rejects deep clone, JSON serialization roundtrip, SSE collection, Debug/snapshot truth substitution, hook-plan payload retention, canonical-sharing removal, and Req04-restore removal.
- Verified with 4 focused Rust probes, 7 mutation fixtures, V3 module/rust-only/resource/fmt/architecture/static-hook gates, Clippy, and the full V3 workspace.
- This marker proves copy-budget probes/gates only, not live Relay, continuation persistence/E2E, servertool execution, Server cutover, P6 deletion, install/restart, or production replacement.

# 2026-07-15: V3 H4 remote continuation contract/store codec pre-module verified

- Marker: `routecodex-v3-h4-remote-continuation-contract-store-verified-20260715`.
- `v3.remote_continuation_contract_store` is the isolated Rust owner for an immutable direct remote locator, exact Responses entry/scope/provider-model-auth pin checks, expiry, commit/load/release, and a strict locator-only JSON codec.
- Commit rejects invalid expiry and duplicate remote response IDs. Load rejects protocol/endpoint/owner/session/conversation/port/group/pin mismatch, expiry, and provider unavailability without cross-provider reselection or local-owner fallback.
- Codec structs use unknown-field denial, so local Chat Process context, history, tool state, and other undeclared state cannot enter remote store truth.
- Verified with 12 focused tests, V3 architecture/resource/module/Rust-only/fmt gates, Clippy `-D warnings`, full V3 workspace tests, forbidden live-wiring scans, and diff check.
- `v3.continuation.remote_binding` intentionally remains `binding_pending`. This marker does not prove Hub Resp04 commit, Hub Req03 load/classification, pinned Target execution, Server endpoint, local continuation, Relay materialization, live replay, Server cutover, P6 deletion, global install/restart, `~/.rcc`, or production replacement.

# 2026-07-15: V3 Anthropic Relay controlled-upstream harness is integration-ready and intentionally red

- Marker: `routecodex-v3-anthropic-relay-controlled-replay-harness-red-ready-20260715`.
- `gate_id:v3_anthropic_relay_controlled_replay_harness` owns four deterministic JSON fixtures, an external-driver loopback Responses upstream harness, a strict evidence schema, source verification, and mutation/red gates; it owns no Runtime, Server, Provider, P6, map, or package semantics.
- JSON/SSE fixtures cover thinking/reasoning and tool_use; provider-error fixture requires Error01-06 polarity; isolation fixture and recursive checks forbid RouteCodex control/debug/resource fields in provider or client normal payloads.
- With no real Runtime driver the harness exits 1 with `V3_ANTHROPIC_RELAY_WIRING_MISSING`, `status=wiring_missing`, zero upstream captures, four `not_run` cases, stable fixture digest, and eight explicit missing adjacent edges. A driver that fabricates output/trace without sending to the controlled upstream fails capture enforcement.
- This marker proves only that the later integration worker can consume a deterministic harness and that the present unwired state cannot go falsely green. It does not prove Anthropic Relay Runtime wiring, Server entry, Responses Provider integration, live Relay, P6 expansion, install, restart, or production replacement.
## V3 local continuation immutable store（2026-07-15）

- V3 Relay 本地 continuation 的独立真源位于 `v3/crates/routecodex-v3-runtime/src/local_continuation.rs`：只允许 `Resp04` 通过 `commit_at_resp04` 保存，只允许 `Req04` 通过 `restore_at_req04` 恢复。
- immutable interval 只允许 lossless codec、entry protocol/endpoint/session/conversation/port/routing-group scope 校验、expiry 和 release；禁止 remote-owner fallback、provider pin、debug/snapshot truth 或 payload rebuild。
- terminal success/failure/already-terminal 必须返回 typed non-save 结果，不能生成或复活 continuation；此切片不代表 Hub/Server wiring、continuation E2E 或 live Relay 已完成。
- required gates：focused contract/store tests、mutation red fixtures、V3 module-boundaries、rust-only、fmt、clippy、full workspace + doctest。
# 2026-07-15 V3 live Responses Direct baseline

- Live port ownership is now split: V2 aggregate owns 5520/10000/4444; isolated V3 owns 5555 through `~/.rcc/config.v3.toml`. The old V2 5555 listener and `gateway_priority_5555` group were physically removed from `~/.rcc/config.toml`.
- The verified V3 minimum is one `responses_v3_5555` listener, one `cc_sol` Responses provider, canonical/wire model `gpt-5.6-sol`, and one explicit default pool. V3 auth authoring uses an environment handle, never a literal secret.
- Verified live evidence: V3 `/health` returned manifest version 3; `/v1/models` bound the model to `provider:cc_sol`; real JSON Responses Direct returned `v3-5555-ok`; real SSE returned `v3-stream-ok`, `response.completed`, and `[DONE]`; V2 5520/10000/4444 remained healthy on 0.90.3934.
# 2026-07-15: V3 Anthropic Relay controlled Runtime integration truth

- `v3.anthropic_relay_runtime_integration` is the controlled-runtime owner for `/v1/messages -> Hub v1 Req01-Req09 -> Responses transport -> Hub v1 Resp01-Resp06 -> Anthropic projection`.
- Controlled evidence truth is fixture digest `74e56c98d05ced968949acdd5d73a05d2a78330cc58a50cae5445a30f50ff50e` with four passing cases (`json_thinking_tool_use`, `sse_thinking_tool_use`, `provider_error`, `side_channel_isolation`) and exactly one captured upstream request per case.
- Node traces are evidence only when appended after the actual owning action. Req05 must precede VR/Target selection; Req06 carries selected-target truth; Responses wire and transport construction must finish before Req08/Req09 trace emission.
- A Server-owned controlled driver must keep fixture/config authoring IO outside Server semantics: accept only case input over stdin and load the harness config through `V3ConfigStore`. It must not read expected fixture fields or recreate route selection.
- This truth does not establish live 5555, continuation E2E, P6 deletion, install/restart/release, real-provider compatibility, or production cutover.

# 2026-07-15 V3 managed live server lifecycle truth

- Live V3 5555 is now owned by managed lifecycle instance `v3-87782d1e6721ce4f567f`, not a foreground agent exec session. Current verified managed child after restart was PID 90733 with PPID 1 and independent PGID 90733.
- V3 process lifecycle truth is `routecodex-v3-lifecycle`; CLI `server start/status/restart/stop` is a thin caller, Server only supplies aggregate listener/shutdown handle, and Runtime remains the business request/response lifecycle.
- Config source identity for lifecycle is Config-owned through `V3ConfigStore::load_snapshot_with_source_identity()`; lifecycle must consume canonical path + source SHA-256 + Manifest from Config, never read raw authoring bytes directly.
- `~/.rcc/config.v3.toml` uses `token_file = "/Users/fanzhang/.rcc/secrets/v3/cc-sol.token"`; the token directory is 0700 and file is 0600. Config/state/log/argv/evidence were verified not to contain the token literal.
- Verified live after managed restart: V3 `/health` reports manifest_version 3, `/v1/models` binds `provider:cc_sol` / `gpt-5.6-sol`, real JSON `/v1/responses` completed exact marker, real SSE emitted `response.completed`, `[DONE]`, and exact delta/completed marker. V2 5520/10000/4444 stayed healthy on 0.90.3934 throughout.
- Stopping legacy foreground 5555 must use its exact owner session/control path when available. If a test managed child loses TempDir state/control truth, do not kill or take over; record the orphan and avoid claiming lifecycle control over it.
# 2026-07-15 5520 forwarder cooldown diagnostic truth

- Virtual Router route candidates may be forwarder IDs while health/cooldown truth is owned by their real provider targets. Any recoverable-cooldown/error-wait projection for a forwarder candidate must expand through `ForwarderRegistry` and inspect the real target keys; otherwise `retryAfterMs` disappears and route selection can project bare `PROVIDER_NOT_AVAILABLE` before the cooldown-wait lifecycle starts.
- Provider status availability is not request eligibility. A provider can be globally enabled/healthy yet be excluded for one session by route capability (for example multimodal), routing instructions, request exclusions, concurrency, or health state, while another default/text/tools session selects it successfully.
- In a multi-port aggregate, the current log truth can live under the aggregate locator log (for the observed 5520 instance, `server-4444.log`). Confirm timestamps and process lifecycle before treating `server-<requested-port>.log` as current.
- Source-level correction is Rust Virtual Router only. Do not compensate with TS retry, handler error swallowing, provider-specific Hub logic, or a synthetic fallback pool.

# 2026-07-15 V3 Responses image body/token boundary truth

- HTTP request byte limits and routing token estimates are separate contracts. V3 Server uses the V2-compatible finite 64MiB request-body cap for allocation safety; it must not reuse the former 1MiB cap as a model-context limit.
- V3 routing token estimation is Rust-owned and follows the established media-omission behavior: image/video URL or base64 bytes, including stringified structured content, contribute only fixed structural cost. This omission is estimation-only; provider wire payloads retain the original media unchanged.
- Required regression pair: a valid image-bearing Responses request above 1MiB reaches the provider, while a request above 64MiB still returns typed 413. Live 5555 accepted a 3.24MiB valid PNG request with HTTP 200 after managed restart.

# 2026-07-15 V3 review closeout invariants

- Responses Direct Resp04 rebind is atomic in V3RemoteContinuationStore::rebind_for_resp04: a new locator is fully validated before the previous locator is removed, and any collision/error preserves the old continuation truth.
- Managed lifecycle stale cleanup is terminal-only. Existing Starting, Running, or Stopping state, and runtime caches without a matching Stopped/Failed status, are never reaped merely because a control probe failed.
- Managed lifecycle terminal cleanup must also validate control ownership before deleting sockets: control instance ID must match the expected declaration and socket path must equal that instance's canonical managed socket. A foreign/corrupted control record fails closed and leaves the foreign socket intact.
- Focused red/green evidence covers failed rebind truth preservation, non-terminal lifecycle cache preservation, and foreign control-socket preservation; continuation JSON/SSE and managed CLI lifecycle regressions remain green.

# 2026-07-15 V3 WebSocket SSE incremental transport invariant

- Provider Responses WebSocket v2 SSE must return an incremental stream immediately after the request event is sent. It must not wait for response.completed or accumulate server events into a Vec before returning.
- The stream owns the single connection guard until terminal drain. After response.completed it emits exactly one [DONE]; only a fully drained terminal stream keeps the connection reusable. Early stream drop, protocol/provider error, closed socket, or client disconnect discards the connection.
- Controlled positive evidence holds response.completed behind a signal and proves transport send plus the first delta frame complete before terminal release. Source/mutation gates reject frame accumulation, collect-to-Vec, fallback, and HTTP retry.

# 2026-07-15 V3 remote continuation is transport-bound

- `remote_continuation` is not a model-only capability. V3 Config must reject it unless the provider declares Responses `websocket_v2` plus an explicit `ws://` or `wss://` endpoint.
- HTTP first-turn success is not continuation availability evidence. The observed upstream accepts normal HTTP Responses but rejects HTTP `previous_response_id` because continuation is supported only on Responses WebSocket v2.
- Provider transport is the unique WebSocket owner: handshake auth, provider/model/auth/url connection identity, `response.create`, connection-local state, cancellation, event correlation, JSON/SSE raw projection, and typed failures remain outside Hub/Server/handler semantics.
- Runtime must reuse one Provider transport instance across the two client HTTP turns; creating a new transport per request loses connection-local `store=false` continuation truth.
- Live completion requires a provider-verified WebSocket endpoint and real managed JSON/SSE two-turn replay. Guessing an endpoint, retaining HTTP remote-continuation capability, or using Relay/local materialization is forbidden.

# 2026-07-15 V3 Anthropic Relay local continuation truth

- Anthropic Relay local continuation is Rust Runtime owned. The legal lifecycle is `Resp04 save -> immutable store interval -> next Req04 exact-scope restore -> terminal release`; Server, OpenAI Chat Runtime, Responses Direct/remote continuation, Provider WebSocket, SSE framing, and handler projection must not own this truth.
- Save condition: pending Anthropic Relay tool calls store the exact canonical provider response under every pending call ID. Success/failure/already-terminal outcomes do not save or revive local truth.
- Restore condition: next Anthropic `tool_result.tool_use_id` must match entry endpoint, session, conversation, port, routing group, owner, and expiry. Multiple tool results must resolve to the same immutable canonical context before Req04 prepends saved reasoning/function_call before function_call_output.
- Error condition: scope mismatch fails before provider send; provider error after restore enters Error01-06 and retains saved truth. No owner/scope/store/debug/metadata/auth/route-control field may enter provider or client normal payload.
- Verified source: controlled JSON two-turn, SSE-first two-turn, multi-tool alias, scope mismatch, provider error retention, local store matrix, verifier, and mutation gates. Live provider compatibility, install/restart, and production cutover are not proven by this source closeout.

# 2026-07-15 V3 Responses WebSocket v2 transport hardening verified closeout

- Provider Responses WebSocket v2 connection reuse is legal only after full terminal drain. Early SSE drop, protocol/provider error, closed socket, read cancellation, cancellation before connect/send, and client disconnect must clear the cached connection before returning or dropping the stream.
- JSON WebSocket protocol errors are connection-poisoning events: malformed JSON, missing `type`, `response.completed` without `response`, and response serialization failure must set the Provider-owned connection slot to `None` before surfacing the typed Provider error.
- Controlled evidence now covers reuse, early drop, provider/protocol error matrix, disconnect, strict in-flight serialization, ping/pong, binary events, split UTF-8 fragmented frames, and incremental SSE first-frame-before-terminal. Source/mutation gates reject Vec/collect/full materialization, HTTP retry/fallback, Server socket ownership, missing connection clear, and removal of the concurrency case.
- Current verification passed: WebSocket focused 9/9, Provider package 9+4+9 plus doctests, dedicated verifier, 6 red mutations, V3 fmt, Clippy, full V3 workspace, module/Rust-only, architecture docs/resource map, and diff check. Live/provider endpoint testing remains outside this source-controlled hardening claim.

# 2026-07-15 V3 OpenAI Chat Relay controlled Runtime truth

- OpenAI Chat Relay controlled Runtime is Rust-owned by `v3.openai_chat_relay_runtime_integration`: Server `/v1/chat/completions` calls `execute_v3_openai_chat_relay_runtime_with_default_transport`, then returns the Runtime-provided `V3OpenAiChatRelayClientBody::{Json,Sse}`. Server must not infer client body type from the original request `stream` flag.
- Legal SSE path: Runtime consumes provider SSE with shared `SseIncrementalDecoder`, validates OpenAI Chat chunks incrementally, emits client frames before terminal, requires terminal `finish_reason` before `[DONE]`, requires `[DONE]` before stream end, and uses Server `Body::from_stream` for transport. Full raw SSE materialization and Server-side Chat parsing are forbidden.
- Verified source: controlled JSON, split SSE, first-frame-before-terminal, `[DONE]`/terminal negatives, provider 429 Error01-06, `metadata_center` pre-transport rejection, Server loopback JSON/SSE/error/isolation, source/mutation gates, maps/manifest/wiki/html/browser, fmt, Clippy, and full V3 workspace. Live provider compatibility, install/restart, release, and production cutover remain unproven.

# 2026-07-15: Responses direct continuation pin must not override provider failure exclusion
- Verified root cause for 5520 client-visible HTTP 402: request `openai-responses-router-gpt-5.6-sol-20260715T210706792-538250-5993` logged `switch=exclude_and_reroute` for `cc.key1.gpt-5.5`, then next VR hit selected the same provider and projected 402. The retry decision was correct; attempt metadata later revived `responsesResume.providerKey` as `runtime_control.retryProviderKey` and deleted `excludedProviderKeys`.
- Fix truth: `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` must let ErrorErr05 exclusions override stale direct continuation retry pins. If the resolved retry provider is in `excludedProviderKeys`, release `runtime_control.retryProviderKey` and keep the exclusion list; if not excluded, direct continuation affinity remains valid.
- Verification: attempt-state red test failed before fix and passed after; controlled provider-failure blackbox now includes HTTP 402 and proves `primaryHits=1`, `backupHits=1`, `clientStatus=200`; `tsc --noEmit`, `build:base`, global install/restart, and 4444/5520/10000 health passed. Live replay at 5520 returned HTTP 200 with marker, but upstream no longer reproduced 402 at replay time.
# 2026-07-15 VR route token estimation and bodyLimit boundary

- Route token estimation truth for `feature_id: vr.route_token_estimation` is Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs` using `tiktoken-rs` while preserving the retired JS `tiktoken@1.0.22` model table semantics: unknown provider aliases use default `cl100k_base`; known retired-table models such as `gpt-5` use their explicit encoding.
- Image/video payload bytes must be omitted from route token estimates. Text and non-media structured request fields still count. Do not trim or mutate client payload to make routing cheaper.
- `server.bodyLimit` / `ROUTECODEX_HTTP_BODY_LIMIT` is the HTTP parser allocation guard only. Hub format nodes must not own a second fixed semantic byte cap such as `MAX_PAYLOAD_SIZE_BYTES`; payload-size policy belongs at transport parsing, not Hub semantics.
- `scripts/install-global.sh` isolated builds must copy `v3/` because `build:min` architecture gates validate V3 source bindings from docs/manifests even when the current feature is V2/VR.
- Release/global install is expected to carry the V3 tree/artifacts needed for the V3 binary and tests; do not treat adding `v3` to installer copy scope as a bug. Local llms inline packing must remain offline/no-script (`npm install ... --offline --ignore-scripts --omit=optional`) so install validation does not hang on registry metadata. Source-binding maps must not point at git-untracked empty directories such as old TS compat folders; clean install worktrees will not have those directories.
# 2026-07-15 Codex Responses WebSocket mode alignment fact

- Current `~/code/codex` Responses WebSocket implementation requires handshake header `OpenAI-Beta: responses_websockets=2026-02-06` for `/v1/responses` WebSocket mode. RouteCodex V3 provider WebSocket transport now sends and tests this header in `ProviderResponsesTransport::send_websocket_v2`; `websocket_v2` remains an internal RouteCodex transport label, not the official protocol name.
- Verified source gates for this fact: provider WebSocket matrix 9/9, `verify:v3-responses-websocket-v2-transport-hardening`, WebSocket red fixtures 7/7, fmt, targeted provider clippy, resource/module/Rust-only/architecture-doc gates, and `git diff --check`. Full V3 workspace still has an unrelated runtime test compile blocker: `hub_v1_h1_contract.rs` missing `entry_protocol_bindings` in `V3HubV1Manifest` initializer.

## 2026-07-15 gpt-5.6 historical tool-image cleanup switch

- `cc-sol/gpt-5.6-sol` live provider config uses `[provider.models."gpt-5.6-sol".direct] historyToolImageCleanup = true` to arm Rust direct hook cleanup for historical tool-output images.
- The cleanup must remain provider/model-config driven: replace only historical tool-output images with placeholders, preserve current-turn tool images, and keep missing config as no cleanup.
- Config validation evidence: `npx tsx src/cli.ts config validate` passed after the live config edit; Rust provider v2 loader reads the new `direct.historyToolImageCleanup = true` field.
# 2026-07-15 V3 entry protocol endpoint binding review gate

- `v3.entry_protocol_endpoint_binding` is the review/gate surface for endpoint-to-entry-protocol binding. Current gate `npm run verify:v3-entry-protocol-endpoint-binding` verifies the four closed protocols (`responses`, `anthropic`, `openai_chat`, `gemini`), endpoint patterns, execution modes/status/owners, map/resource/mainline/wiki/html presence, Config registry source, Server registry consumer, explicit Gemini `pending_not_implemented`, no raw-path Server bypass, and no provider/client body leakage of binding resources.
- Verified current-state gates for the review slice: entry binding verifier, 9 red fixtures, V3 architecture docs, V3 resource map, V3 module boundaries, V3 rust-only, wiki markdown sync, wiki HTML sync after render, browser smoke, and `git diff --check`. A/B Config and Server claims still remain `running`, so this is source-level C review/gate closure, not an A/B integration-closed or live/prod claim.

# 2026-07-16 RouteCodex stale claim vs active worker distinction

- `.agent-collab/claims/*/owner.json` can remain `status=active` after the worker has stopped. Treat that as stale/unclosed runtime state unless the matching `runs/<run_id>/heartbeat.json` is fresh and a live agent/process is actually present.
- Before declaring a semantic area blocked by another worker, check owner, heartbeat timestamp, events/evidence, handoff/merge-queue, and current live agents. If heartbeat is stale and no live agent exists, continue by claiming a new run or writing a checked handoff instead of excluding that task.
- Concrete correction: `feature_id:sse.transport_core_shared` had an `active` owner from `20260715T061836Z-Macstudio-74436-rxsyma`, but no live agent and no fresh heartbeat; future V3/SSE work must not skip SSE solely because this stale claim was not closed.

# 2026-07-16 V3 `rccv3` distribution surface truth

- V3 distributed CLI command and artifact are now `rccv3` and `dist/bin/rccv3`. Cargo `[[bin]]` and Clap command name are also `rccv3`; `routecodex-v3` may remain only as crate/package namespace text, not as an installed command or published npm bin.
- V3 CLI `--config` is optional. When omitted, CLI resolves `$HOME/.rcc/config.v3.toml` via `routecodex-v3-config::default_v3_config_path`; missing `HOME` without explicit `--config` fails fast with `HOME is required to resolve config.v3.toml`.
- Build/install scripts must remove stale `dist/bin/routecodex-v3` and stale `routecodex-v3` shims while publishing/verifying `rccv3`. Release verification checks `routecodex` plus extra bin `rccv3`; global/release install checks run `rccv3 --help`.
- Validation note: `npm run build:base` auto-bumps package version unless `ROUTECODEX_SKIP_AUTO_BUMP=1` is set. For validation-only builds, use `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`, then verify `./dist/bin/rccv3 --help` and absence of `dist/bin/routecodex-v3`.
- Evidence: red tests first failed on old package bin/CLI required config; green gates passed for V3 distribution Jest, CLI default-config tests, V3 CLI full tests, managed lifecycle/H2/VR controlled replays, V3 Clippy, full V3 workspace, H2 verifier/red fixtures, function-map build wiring, build:base with skip bump, script syntax checks, `git diff --check`, and `./dist/bin/rccv3 --help`.

# 2026-07-15 `/v1/models` built-in gpt-5.6 Codex catalog

- `/v1/models` must always expose built-in bare Codex catalog entries `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` from `src/server/runtime/http-server/routes.ts`, independent of provider-prefixed aliases. Provider-prefixed aliases may still add runtime-derived `context_window`, `supports_streaming`, or provider descriptions.
- `gpt-5.6-*` built-ins use `minimal_client_version=0.144.0`, `context_window=max_context_window=372000`, `use_responses_lite=true`, `tool_mode=code_mode_only`, `input_modalities=[text,image]`, `supports_search_tool=true`, and `supports_parallel_tool_calls=true`. Sol/Terra support `ultra`; Luna stops at `max`.
- Verification evidence: `npm run verify:models-capability-contract`, `npm run verify:function-map-compile-gate`, `npm run verify:resource-operation-map`, `npx tsc --noEmit --pretty false`, and `git diff --check` passed after replacing dead `buildCodexAdvancedModelMetadata()` with `buildBuiltinCodexModelMetadata()` and updating the model capability contract.

# 2026-07-15 direct Responses SSE 402 reroute truth

- Same-protocol direct `/v1/responses` can receive HTTP 200 and then get provider failure in the SSE body (`event: response.failed` or `event: error`). Those frames must be classified before client streaming starts; router-direct HTTP status handling cannot see them because the status is already 200.
- The legal fix is in provider runtime SSE pre-stream guards: map 401/402/403/429/5xx provider-failure frames to retryable typed provider errors with `statusCode/status/code/upstreamCode/requestExecutorProviderErrorStage`, so ErrorErr05 can exclude and reroute. Client projection, router fallback, and rate-limit-only checks are insufficient.
- Verification evidence for the 402 fix: focused direct/guard Jest 33/33, `verify:error-pipeline-contract`, `verify:provider-failure-ban-blackbox` (`scenario402`: primary 1, backup 1, client 200), `build:base`, global install `0.90.3935`, installed `ResponsesProvider` direct SSE 402 replay, `routecodex restart --port 5520`, `/health` version `0.90.3935`, and live 5520 `/v1/responses` SSE success without provider failure frame.

# 2026-07-16 V3 Hub Relay controlled Runtime closeout truth

- Marker: `v3-hub-relay-controlled-closeout-20260716`.
- `v3.hub_relay_runtime_closeout` is verified at the controlled Rust Runtime boundary. JSON and SSE traverse fixed Req01-Req09 plus Resp01-Resp06 and each reach one `V3ServerRespOutbound06ClientFrame`.
- Local continuation is saved at Resp04, restored before next Req04 governance, and released after terminal success. The Runtime response hook profile observes `servertool.exec`; provider errors enter Error01-06 without Resp01 success projection; provider/client normal payloads exclude session/conversation, continuation-store, MetadataCenter, and RouteCodex control truth.
- Copy-budget probes prove the controlled request/response/SSE/local-continuation/servertool surfaces do not add full payload/SSE materialization. Closeout mutation gates independently reject non-adjacent topology, late Resp04 commit, second response exit, dynamic hook discovery, P6 shortcut, fallback, hook-profile loss, and map/gate drift.
- Current-state evidence: closeout Runtime 3/3; closeout red 10/10; copy probes 4/4; copy red 7/7; V3 architecture/resource/module/Rust-only/static-hook/fmt/Clippy/full-workspace/diff gates all pass.
- This does not authorize or prove P6 deletion, live Relay Server cutover, `~/.rcc` mutation, global install, restart, release, real-provider compatibility, or production replacement.

# 2026-07-16 V3 Gemini Relay controlled Runtime truth

- Marker: `v3-gemini-relay-controlled-runtime-20260716`.
- `v3.gemini_relay_runtime_integration` is verified at the controlled Rust Runtime and Server loopback boundary. `/v1beta/models/:model/generateContent` now compiles as a `relay` entry binding with owner `execute_v3_gemini_relay_runtime_with_default_transport`.
- Gemini-specific semantics stay in the Gemini codec/runtime owner: dynamic URL model extraction, candidate/usage projection, `functionCall` name preservation, incremental SSE decode, malformed/non-terminal/post-terminal SSE rejection, and provider 429 Error01-06 projection.
- Server consumes the entry binding registry and projects typed runtime output only; it does not parse candidate/functionCall/finishReason semantics. Virtual Router classifies dynamic `/v1beta/models/.../generateContent` endpoints as `gemini` facts without provider-specific Hub/Server branches.
- Verification evidence: Gemini runtime/server tests, Gemini verifier and 10 red mutations, entry binding verifier/red fixtures, V3 resource/module/Rust-only/static-hook/wiki/manifest/fmt/Clippy/full-workspace/diff gates all pass.
- This does not prove real Gemini upstream compatibility, live config, production cutover, credentials, or release routing beyond the controlled loopback boundary.

# 2026-07-16 V3 Gemini malformed provider error projection

- `v3.gemini_relay_runtime_integration` must project malformed non-JSON provider HTTP error bodies as explicit `provider_error_body_malformed` client errors through Error01-06. Do not use `unwrap_or_else` / `unwrap_or_default` generic fallback bodies in this owner.
- Review correction: release/global install copying `v3/` is expected because the V3 bin and tests must be globally installable. Treat the copy scope as required install surface, not as dirty-code evidence to remove.

# 2026-07-16 SSE transport core V2 parser retirement truth

- V2 `hub_resp_inbound_sse_stream_sniffer` must consume shared `sse-transport-core` frames/fields via `SseIncrementalDecoder`; local line parser owners `parse_sse_line`, `assemble_sse_event`, and NAPI `assembleSseEventFromLinesJson` are retired and must not be restored.
- Semantic SSE parsing remains outside the transport core: shared transport only decodes/encodes frames/fields, while V2 parser code maps `event/id/data/retry/timestamp` to protocol JSON and strict validation. Multi-line `data:` is joined per SSE spec before semantic JSON parse; it must not accept two independent JSON objects as one event.
- V2 old direct passthrough SSE replay is now locked by `tests/sharedmodule/sse-runtime-rust-dispatch.spec.ts` marker `direct-passthrough-sse-20260713T055458`: provider event sequence, model/reasoning, `PASSTHROUGH_SSE_OK`, `[DONE]`, native `buildJsonFromSseDirectNative`, and client keepalive-stripped byte equality.
- Verification evidence: V2 sniffer Rust 19/19, native hotpath build, V2 replay Jest 5/5, SSE transport core 7/7, V3 provider adapter tests, SSE shared/source gates, resource/function/mainline/review gates, shared fmt, SSE core Clippy, V3 fmt/Clippy/controlled replay/full workspace, and `git diff --check` passed. No live config, `~/.rcc`, global install, restart, or release was changed.

# 2026-07-16T02:00:11+08:00 SSE transport core shared stream truth

- sse.transport_core_shared uses sse-transport-core as the only protocol-neutral Rust SSE framing owner. V3 Responses Direct must carry SSE as V3ClientBody::Sse through Runtime and Server Body::from_stream; provider SSE must not be accumulated into a complete Vec<u8> before client projection.
- Direct remote continuation over SSE is stream-driven: commit after an observed pending SSE chunk, release a previous locator only after clean stream EOF, and preserve previous locator truth on provider/body stream error. Do not use response header/node trace to claim an async stream commit occurred before the stream has been consumed.
- Server-side SSE projection must call shared transport builders/encoder and fail malformed/missing event fields explicitly. Silent unwrap_or_default empty streams, Ok(None) event skips, manual format!(event...) writers, and Body::from materialized SSE bytes are forbidden in this path.
- Verified current source gates for this truth: SSE core tests, V2 sniffer tests, V3 provider adapter tests, Responses Direct continuation 8/8, Server multi-listener 14/14, full V3 workspace, V3 Clippy, shared SSE core Clippy, architecture/resource/function/mainline/review gates, and git diff --check.

# 2026-07-16 VR token estimate metadata override boundary

- `vr.route_token_estimation` must derive route `estimated_tokens` from Rust tiktoken request counting, not from client-provided `estimatedInputTokens` / `estimatedTokens` / `estimated_tokens` metadata. Client metadata can remain for diagnostics/usage projection but must not control longcontext classification.
- Top-level `/v1/responses` `input` is part of the Rust estimate, with image/video media bytes omitted and real text/tool/function output counted. The estimator uses `max(top_level_input, semantics.responses.context.input)` to avoid duplicate counting when both carriers mirror the same Responses context.
- `server.bodyLimit` remains only an HTTP request allocation guard. It is not a token policy and must not be reintroduced inside Hub semantic nodes.

# 2026-07-16 V3 live provider compat parity matrix closeout

- `v3.live_provider_compat_parity_closeout` is a docs/verifier matrix closeout, not a production provider compatibility claim. The manifest `docs/architecture/manifests/v3.live_provider_compat.parity.yml` covers Responses Direct, Responses Relay, Anthropic Messages, OpenAI Chat, and Gemini across JSON HTTP, SSE HTTP, and WebSocket v2.
- Completion truth: matrix contract and controlled/source evidence indexing are verified; production-ready cases remain zero unless controlled + live evidence are both present and blockers are empty. Current live V3 provider replay is pending/blocker and must not be presented as production-ready.
- Verified gates for the closeout: `npm run verify:v3-live-provider-compat-parity`, `npm run test:v3-live-provider-compat-parity-red-fixtures`, V3 architecture docs/resource/module/Rust-only/cargo-fmt/clippy/workspace, and `git diff --check`.

# 2026-07-16 V3 inbound WebSocket and Relay parity dirty-review truth

- v3.responses_inbound_websocket_proxy is a Server-owned client WebSocket upgrade/frame projection shell for GET /v1/responses; it requires OpenAI-Beta: responses_websockets=2026-02-06, parses flat response.create, enters the existing Responses Direct Runtime once, and forbids provider socket ownership, HTTP fallback, history/tool repair, and full SSE materialization in Server.
- Inbound WebSocket runtime errors must be explicit client WebSocket error events before close. Invalid Runtime byte JSON projects runtime_error; malformed or unterminated Runtime SSE projects runtime_stream_error. Silent close is not a valid error projection.
- v3.relay_tool_servertool_multiturn_parity_closeout is controlled Runtime parity only: Req04 validates tool outputs against current/restored tool calls, preserves current-turn media while placeholdering historical attachments, rejects side-channel leakage, and Resp03 classifies function/custom/servertool/apply_patch/MCP/native before Resp04 continuation commit.
- Global/release install including v3/ is expected for V3 bin/test validation. Verified installed surface: routecodex --version = 0.90.3935, routecodex-v3 --help works. Port 5555 has no listener, so V3 live provider replay remains pending and must not be claimed complete.

# 2026-07-16 V3 inbound Responses WebSocket proxy controlled closeout

- `v3.responses_inbound_websocket_proxy` now has controlled Server tests for handshake/upgrade, ping/pong, flat text and binary `response.create`, malformed JSON, missing `type`, unsupported `response.cancel`, nested `response` rejection before provider send, JSON/SSE projection, same-socket `previous_response_id` + `function_call_output` continuation without Router re-entry, scope mismatch before provider send, provider error as WebSocket error event, and client disconnect during incremental SSE projection.
- Server SSE-to-WebSocket projection must concurrently watch the client WebSocket while reading the Runtime SSE stream. If client close/error arrives, `send_responses_websocket_sse_stream` returns early and drops the Runtime/provider stream; it must not silently drain provider events to terminal behind a disconnected client.
- The inbound proxy remains a Server transport shell only. Provider WebSocket connection/cache/session/cancellation semantics stay in `v3.responses_websocket_v2_transport_hardening`; continuation save/restore stays in existing Responses Direct Runtime/Chat Process owner; no HTTP fallback, history/tool repair, or provider socket state is allowed in Server.
- Verified source gates: inbound WebSocket package test 9/9, inbound verifier, inbound red fixtures 10/10, function-map compile gate, owner queryability, feature-map growth, V3 architecture docs/resource/module/Rust-only/fmt/clippy/workspace, adjacent provider WebSocket hardening test/verifier/red fixtures, and `git diff --check`. No live config, `~/.rcc`, global install, restart, release, or production cutover is claimed.

# 2026-07-16 V3 Responses Direct remote continuation live 5555 capability gate

- Current global install evidence: `routecodex --version` = `0.90.3935`, `routecodex-v3 --help` works, and `http://127.0.0.1:5555/health` returns V3 manifest server `responses_v3_5555`.
- Controlled owner gate `npm run test:v3-responses-direct-remote-continuation` passes, covering config binding, provider WebSocket v2 transport, Runtime JSON/SSE remote continuation, and Server JSON/SSE two-turn replay.
- Current 5555 live replay is blocked by profile capability, not by controlled source wiring: JSON first turn projects `provider cc_sol model gpt-5.6-sol lacks required remote_continuation capability` at `V3HubRespContinuation04Committed`, and inbound client WebSocket returns the same `runtime_error` event after handshake.
- The live trace still uses `V3Transport13ResponsesHttpRequest`; current 5555 provider/profile has not published WebSocket v2 `remote_continuation`. Do not claim live JSON/SSE/WS two-turn closeout until Jason authorizes live config/restart and a new replay proves same provider/model/auth/transport pin.
- V3 Responses Direct SSE observer truth: `response.created` / `status=in_progress` is only a response-id candidate in streaming mode, not a pending remote continuation by itself. Resp04 commit or capability error must wait for real pending evidence (`function_call` / `custom_tool_call` item, output function call, or `requires_action`). HTTP-only terminal SSE may stream without remote continuation; HTTP-only SSE function calls must fail explicitly and not leak as continuable client success.
- Managed V3 5555 live replay can also be blocked before provider send by lifecycle identity state: `server status` may report `state="stopped"` while `server start` refuses with `IdentityMismatch("refusing to reap state for a different instance declaration")`. Do not delete lifecycle state or kill processes as a workaround; fix the managed lifecycle owner or use an authorized exact-identity stop/start path.
- 2026-07-16 verified correction: when service instance ID/config path/config digest/listener set are unchanged and status is terminal `stopped|failed`, lifecycle may advance only the exact launch provenance to a new release executable. Running, missing-terminal, foreign, or otherwise different declarations still fail without reaping state. Installed snapshot `routecodex-0.90.3935-2026-07-16T025310Z` completed one managed restart with changed PID/nonce; live 5555 JSON/SSE returned `V3_RESTART_JSON_OK` / `V3_RESTART_SSE_OK`, `response.completed`, and `[DONE]`, while V2 5520/4444/10000 remained healthy. This does not enable HTTP remote continuation or tool-output continuation.
- Current V3 Responses Direct remote continuation truth: source/controlled JSON/SSE/WebSocket-v2 gates pass for Config transport-bound capability, provider WebSocket v2 lifecycle, Runtime Req03 load, Req06 exact pin, Router hit=0 continuation, and Server two-turn replay. Live ordinary HTTP JSON/SSE on 5555 is now running and verified after managed lifecycle rollover, but remote continuation/tool-output live closeout remains pending because current live configs still declare `cc_sol` Responses transport as HTTP and omit `remote_continuation` / `tool_outputs`. Do not claim live JSON/SSE/client-WS two-turn remote-continuation completion until Jason authorizes live config/restart and replay evidence proves same provider/model/auth/transport pin.

# 2026-07-16 V3 `/v1/models` built-in catalog truth

- `v3.models_capability_catalog` is owned by `routecodex-v3-server::build_v3_models_catalog` and projects only the compiled Manifest plus stable Codex client metadata. It does not route, resolve auth, mutate Provider state, or enter provider payloads.
- Bare `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` must always be listed and deduplicated against configured visible IDs. Configured non-duplicate aliases keep allowed runtime-derived context/streaming fields; generic aliases retain `minimal_client_version=0.98.0`.
- Source evidence: missing-built-in red test failed first; focused V3 Server catalog tests passed 2/2 after the owner fix; V3 architecture/resource/module/Rust-only/fmt/Clippy/full-workspace and live-parity verifier/red fixtures passed. Live managed 5555 replay is now recorded in the 2026-07-16 V3 5555 live provider compat partial closeout section.

# 2026-07-16 V3 5555 live provider compat partial closeout

- Final managed V3 5555 profile is responses + openai_chat; Anthropic was not kept enabled because Anthropic Messages SSE live replay still has a separate structured-SSE blocker and must not be claimed in this closeout.
- Installed runtime truth: global install succeeded and refreshed snapshots to routecodex-0.90.3935-2026-07-16T032522Z under /Users/fanzhang/.rcc and routecodex-0.90.3935-2026-07-16T032531Z under /Volumes/extension/.rcc; managed V3 restart ran PID 3130 from /Users/fanzhang/.rcc/install/current/dist/bin/routecodex-v3.
- Live 5555 /v1/models now returns gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna; gpt-5.6-sol includes all required Codex fields (supports_reasoning_summaries, support_verbosity, supports_parallel_tool_calls, context_window, max_context_window, supports_search_tool, use_responses_lite, tool_mode, input_modalities) and data == models.
- Real provider replay PASS on 5555: Responses Direct JSON marker V3_COMPAT_DIRECT_JSON_OK, Responses Direct SSE marker V3_COMPAT_DIRECT_SSE_OK with [DONE], client-facing Responses WebSocket marker V3_COMPAT_DIRECT_WS_OK with response.completed, OpenAI Chat Relay JSON marker V3_COMPAT_OPENAI_CHAT_JSON_OK, and OpenAI Chat Relay SSE marker V3_COMPAT_OPENAI_CHAT_SSE_OK with [DONE].
- V2 health stayed green after V3 restart: 5520, 4444, and 10000 returned RouteCodex 0.90.3935.
- Matrix boundary: only the verified Direct JSON/SSE/client-WS, OpenAI Chat Relay JSON/SSE, and models catalog cases are production-ready in docs/architecture/manifests/v3.live_provider_compat.parity.yml; /v1/responses Relay cutover, Anthropic Messages live replay, Gemini live replay, and unverified live error cases remain explicit blockers.

# 2026-07-16 V3 live compat matrix partial closeout
- Live Responses provider can emit JSON output as output[].type=message with nested content[].type=output_text, and data-only SSE frames whose event name lives in data.type; Anthropic Relay projection must accept both in its Rust codec owner and must not push provider-specific fixes into Hub Pipeline or Virtual Router.
- Current managed V3 5555 final profile declares only responses and openai_chat. Verified live cases: /v1/models capability catalog for gpt-5.6-sol, Responses Direct JSON/SSE/client WebSocket, and OpenAI Chat Relay JSON/SSE. Evidence: .agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json.
- Anthropic Messages and Gemini Generate Content remain live profile blockers, not runtime closure: both return explicit endpoint_not_enabled in final 5555 unless config is intentionally changed and restarted. Do not mark them production-ready from controlled tests or from older non-final profile probes.

# 2026-07-16 V3 V2 TOML 5555 compat truth

- `v3.v2_config_toml_compat_5555` is a Config-owner closeout: V3 Config Store explicitly recognizes V2 root TOML plus `provider/<providerId>/config.v2.toml`, compiles it into V3 manifest truth, publishes Hub V1 endpoint bindings and server execution policy, and materializes literal V2 `apiKey` values as local `token_file` handles instead of manifest/debug secrets.
- 5555 route contract truth: `thinking/coding/longcontext` = `glm-5.2` primary then GPT free then GPT paid; `tools/search/web_search` = `MiniMax-M3` primary then `glm-5.2`; `multimodal` = `MiniMax-M3` primary then GPT free then GPT paid `gpt-5.4`; `default` = de-duplicated ordered union of those targets and must remain non-empty.
- Global V3 install/live evidence for this config slice: installed `routecodex/rcc` `0.90.3935` from `/Volumes/extension/.rcc/install/releases/routecodex-0.90.3935-2026-07-16T051745Z`; `routecodex-v3 config check --config /Volumes/extension/.rcc/config.5555.v2.toml` returned `config ok: version=3 servers=1`; managed 5555 `/health` returned V3 `status=ok`; `/v1/responses` `model=glm-5.2` returned HTTP 200 completed.
- V2 TOML listener health alone is not endpoint binding proof. Closure required `/v1/models` plus same-entry `/v1/responses` live smoke after global install/start.
- MiniMax tools/search is not live-ready yet despite route order being correct. Current evidence shows `MiniMax-M3` selected first, provider send failed, target-local reselected `glm-5.2`, and `/v1/messages` against MiniMax returns HTTP 404. Root cause is V3 Provider Runtime protocol support: Anthropic Relay currently uses Responses wire/transport for a V2 `type="anthropic"` MiniMax provider. The next module must implement Anthropic upstream provider wire/transport or protocol-neutral provider dispatch in Provider Runtime, not Config/Hub/VR.

# 2026-07-16 V3 selected provider protocol dispatch truth

- Correction to the earlier MiniMax tools/search blocker: `V3TargetCandidate` and `V3ResponsesProviderTarget` now preserve selected `provider_type` into the Provider Runtime. For HTTP `provider_type=anthropic`, the Provider Runtime owns the protocol dispatch and uses Anthropic Messages `/v1/messages`, `x-api-key`, `anthropic-version`, Anthropic request wire, and Responses client projection. Config, Hub Pipeline, and Virtual Router remain provider-neutral; provider IDs are not branched on.
- `V3Transport13ResponsesRequest` is sealed behind Provider-owned builders; runtime relay helpers may request a protocol URL via `build_v3_transport_13_responses_http_request_from_parts`, but non-owner code cannot construct transport node variants directly.
- Global installed 5555 live proof is current: `routecodex`, `rcc`, and install package version are `0.90.3935`; V3 `/health` is green; a `/v1/responses` request declaring `web_search_preview` and selecting `MiniMax-M3` returned HTTP 200, `status=completed`, `model=MiniMax-M3`, and `output_text=OK` without target-local reselection.
- This evidence proves selected Anthropic protocol dispatch and the exercised JSON request/response shape. It does not prove real search execution quality, multimodal parity, full Anthropic SSE/tool-use parity, remote continuation, or the remaining protocol/error live matrix.

# 2026-07-16 V3 V2 TOML Responses transport projection truth

- `v3.v2_config_toml_compat_5555` now projects V2 `[provider.responses] transport` and `websocket_v2_url` / `websocketV2Url` into the V3 provider manifest. Omitted transport remains HTTP; `remote_continuation` still requires `tool_outputs` and WebSocket v2 at Config compile; WebSocket v2 without endpoint fails before Runtime/Provider send.
- Existing V2 5555 provider-protocol endpoint enablement remains separate from this transport projection; Runtime and Provider transport must consume the compiled Config truth rather than infer or expand endpoint availability.
- Current live 5555 gap remains external/config truth, not source wiring: `cc-sol` V2 provider config lacks `remote_continuation`, `tool_outputs`, and `websocket_v2_url`; no live config, credential, install, restart, or provider endpoint guessing was performed. Live remote-continuation closure still requires authorized config/restart and real two-turn replay proving the exact provider/model/auth/transport pin.

# 2026-07-16 V3 Gemini live 5555 profile blocker after 60d0c90f4

- 60d0c90f4 fixed the live Gemini misroute class: V2 TOML projection no longer enables Gemini without an enabled Gemini provider, and Gemini runtime rejects non-Gemini selected targets before provider send.
- Verified after global rccv3 install snapshot 0.90.3935 and managed restart of /Volumes/extension/.rcc/config.5555.v2.toml: Gemini /v1beta/models/gemini-wire/generateContent JSON and SSE both returned HTTP 501 endpoint_not_enabled at V3Server03HttpRequestRaw through Error01-06. The sanitized active config contains no Gemini provider endpoint.
- Current Gemini live state is an unauthorized profile blocker, not production readiness and not the previous model_not_found default-OpenAI-target runtime bug. Do not mark Gemini live provider replay ready until an authorized Gemini endpoint/provider profile is configured, restarted, and JSON/SSE provider replay succeeds.

# 2026-07-16: V3 resource relation vs call-path edge rule
- V3 resources are nodes/truths, not standalone call edges. Callable/runtime paths must be represented by adjacent `from_node -> to_node` edges in `docs/architecture/v3-mainline-call-map.yml` or lifecycle manifests.
- Resource relationships are carried by each edge's `resource_flow` (`consumes`, `produces`, `side_channel_reads`, `side_channel_writes`). Multiple callable paths or resource relationships require multiple explicit edges.
- `docs/architecture/v3-function-map.yml` `allowed_paths` / `forbidden_paths` are feature file-scope constraints only; do not treat them as call-path or resource-relation edges.

# 2026-07-16 V3 5555 Responses Relay live provider replay

- Globally installed `routecodex/rcc/rccv3` 0.90.3935 with matching `rccv3` sha256 across `~/.rcc/install/current` and `/Volumes/extension/.rcc/install/current`; managed 5555 ran from `/Volumes/extension/.rcc/config.5555.v2.toml` as instance `v3-2412d59aaae7317c9867`.
- Managed lifecycle can safely recover stale `running` state after release executable rollover only when same config/listener identity is proven, control socket is gone, pid/control ownership is valid, and all listener addresses are available. Do not hand-delete V3 runtime state or kill ports to fix this class.
- Current POST `/v1/responses` on 5555 is Responses Relay. Live JSON/SSE replay returned HTTP 200 with exact markers and the full fixed Req01-Req09/Resp01-Resp06 trace; Direct/P6 markers were absent. `/v1/models` returned required Codex capability fields.
- Direct client WebSocket on GET `/v1/responses` remains live verified. Direct JSON/SSE evidence for the matrix is the same-day pre-cutover Direct POST replay; do not re-label current Relay POST replay as Direct.
- Evidence: `.agent-collab/runs/20260716T110035Z-Macstudio.local-31201-f5633c/logs/live-provider-matrix-20260716T114218Z/summary.json`.

# 2026-07-16 asxs 单 key 事实

- ~/.rcc/provider/asxs/config.v2.toml current active auth entry is only crsa, and it still binds to CRS_OAI_KEY1; crsb has been removed from the active config.
- Verification: routecodex config validate passed, and 5520/4444/10000 health all returned ok.
- Live smoke: POST /v1/chat/completions with messages containing <**!asxs.gpt-5.5**> routed to asxs[crsa].gpt-5.5 and returned ASXS_OKASXS_OK.
- Observation: /v1/responses provider-request dry-run on the same textual marker still selected cc.key1.gpt-5.5, so asxs credential verification should use the chat/completions live smoke path instead of that responses dry-run marker as proof.

# 2026-07-17 V3 Responses WebSocket V2 Codex error events

- Latest Codex commit `315195492c80fdade38e917c18f9584efd599304` treats Responses WebSocket V2 as provider-enabled via `supports_websockets`, sends `OpenAI-Beta: responses_websockets=2026-02-06`, sends Responses Lite through `x-openai-internal-codex-responses-lite: true`, and maps upstream `type:"error"` WebSocket events with `status` or `status_code` plus `error.code` or `error.type` into typed provider errors. RouteCodex V3 must preserve those fields; missing `code` is not proof of an unclassified provider failure if `error.type` exists.
- V3 source truth: upstream provider WebSocket errors are handled only in `v3.responses_websocket_v2_transport_hardening` / `ProviderResponsesTransport`. On error, clear the provider-owned WebSocket connection and return a typed error. Do not retry over HTTP, reselect provider, rebuild continuation, or mutate the request. Client-owned retry may resend the same `previous_response_id` on a fresh WebSocket connection.

# 2026-07-16: V3 resource relation edge lock gate
- Source gate npm run verify:v3-resource-relation-edge-lock is wired into npm run verify:v3-architecture-docs.
- The gate enforces: resources stay registry nodes; callable paths are scalar adjacent mainline edges; resource relationships appear only under edge resource_flow; every declared resource and function-map resource binding is carried by some edge resource_flow; duplicate edge ids, same-node edges, and multi-source/multi-target shortcuts fail.
- Current map closure: 69 resources are bound through 178 mainline edge resource_flow payloads; mutation red fixture rejects 15 forbidden changes.

# 2026-07-17: V3 mainline edge owner queryability is not optional

- V3 resource/edge lock can pass while mainline `chain.owner_feature_id` or `edge.owner_feature_id` is absent from `docs/architecture/v3-function-map.yml`; this is an architecture gap, not a harmless doc mismatch.
- Current audit found 69 resources and 178 edge `resource_flow` payloads closed, but these owner IDs were not function-map queryable: `v3.config_interpreter_contract`, `v3.debug_error_foundation`, `v3.foundation_p0_p2`, `v3.responses_direct_mvp_architecture`, `v3.responses_provider_runtime`, `v3.virtual_router_target_interpreter`.
- Rule: V3 mainline owner IDs must resolve through function-map first, then verification-map and source/manifest anchors. Verification-only owner IDs are insufficient for traceable writes and edge-locked module calls.
- Follow-up gate target: `verify:v3-resource-relation-edge-lock` or a sibling verifier must fail when any V3 mainline chain/edge owner is missing from function-map, and red fixtures must cover missing chain owner and missing edge owner.

# 2026-07-16: V3 5555 Direct fresh replay truth
- V3 5555 is non-production for this live compat task per Jason, so V3 connection/config/restart/live replay did not need extra approval.
- Fresh Direct JSON/SSE/WS evidence now exists at `.agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/direct-fresh-live-20260716T122025Z/summary.json`: Direct JSON and SSE returned HTTP 200 with markers `V3_DIRECT_FRESH_JSON_OK` / `V3_DIRECT_FRESH_SSE_OK`, SSE had `response.completed`, and WebSocket returned marker `V3_DIRECT_FRESH_WS_OK`.
- The temporary native V3 Direct config was generated from `/Volumes/extension/.rcc/config.5555.v2.toml`, validated, used only for replay, then removed. Original `/Volumes/extension/.rcc/config.5555.v2.toml` was restarted and restored evidence at `.agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/relay-restored-live-20260716T122141Z/summary.json` proves `/v1/models` plus Responses Relay JSON/SSE still pass on the final binding.
- This is not two-turn remote continuation/tool_outputs exact-pin evidence; that live gate remains separate.
- Matrix docs now treat Direct JSON/SSE/WS and Relay JSON/SSE as fresh real-provider replayed surfaces; Anthropic/Gemini and live 401/403/5xx/timeout remain explicit pending/blocker surfaces.

# 2026-07-16: V3 5555 Config A live endpoint blocker
- After Jason authorized non-production V3 5555 config/restart/live work, Config A was re-audited from `/Volumes/extension/.rcc/config.5555.v2.toml` and `cc-sol` provider profiles without changing credentials or persistent config.
- Active `cc-sol` still declares Responses HTTP shape only: `[provider.responses] process="chat", streaming="always"`; `gpt-5.6-sol` lacks `remote_continuation` / `tool_outputs`; no `websocket_v2_url` exists. `/v1/models` lists Codex fields but `prefer_websockets=false`.
- Provider endpoint probes using the existing auth and `OpenAI-Beta: responses_websockets=2026-02-06` timed out during opening handshake for `wss://api.anyint.ai/openai/v1/responses` and the model query variant. Plain HTTPS on `/responses` returns an auth-shaped response, while WebSocket Upgrade gets zero bytes until timeout.
- Do not persist `transport="websocket_v2"` by guessing this endpoint. Live remote continuation still needs a provider-verified WebSocket v2 endpoint or a different verified profile before config mutation, managed restart, and two-turn replay.

# 2026-07-16: V3 5555 configured provider WS v2 matrix blocker
- The provider WebSocket v2 closeout probe covered all currently configured `type="responses"` provider ids from `/Volumes/extension/.rcc/provider` and `~/.rcc/provider`: 13 providers x 4 candidate endpoints (`/responses`, `/responses/ws`, `/responses/websocket`, `/realtime`) with real WebSocket Upgrade, configured auth when present, and `OpenAI-Beta: responses_websockets=2026-02-06`.
- Result: 52 authenticated upgrade candidates, 0 HTTP 101. Counts were `200=6`, `400=2`, `401=4`, `403=1`, `404=25`, `405=1`, `ConnectionRefusedError=2`, `TimeoutError=11`. Evidence summary: `.agent-collab/runs/20260716T125019Z-Macstudio-75061-1d19c963/provider-ws-upgrade-summary.json`.
- Inventory truth: no configured Responses provider declares `websocket_v2_url`; transport is omitted/HTTP; no model declares both `remote_continuation` and `tool_outputs`.
- Therefore live two-turn provider-owned remote continuation remains blocked by provider/profile availability, not RouteCodex source wiring. Do not guess WebSocket endpoints or treat HTTP/Relay/client-facing WebSocket success as provider WebSocket v2 evidence.

# 2026-07-16: V3 5555 WS v2 provider discovery blocker
- Broader Config A discovery scanned locally resolvable Responses providers `55ai`, `cc`, `cc-sol`, `llmgate`, `llmtoken`, and `xl` for Responses WebSocket v2 handshakes using existing auth and `OpenAI-Beta: responses_websockets=2026-02-06`; zero endpoints opened.
- Providers whose auth was env-referenced or missing in the current agent shell (`1token`, `asxs`, `dibittai`, `grok`, `lmstudio`, `sdfv`, `ykk`) were not marked failed; they are unresolved for this execution environment.
- The current `OPENAI_API_KEY` environment variable does not unblock the task: authenticated official OpenAI WebSocket upgrade returned `invalid_api_key` after sanitization.
- Next valid closeout step is not guessing TOML fields; it is obtaining or selecting a provider profile that first proves a successful Responses WebSocket v2 upgrade and terminal `response.completed`, then doing managed 5555 config/restart and two-turn `function_call_output` replay.

# 2026-07-16: 5520 `PROVIDER_NOT_AVAILABLE` must not be explained as allowed pool-empty
- Project contract: every routing group must keep explicit non-empty `routing.default`; default last provider must not be removed into an empty pool. A live `VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE` with non-empty route/default forwarder pools is a bug/stale-runtime/config/health-diagnostic candidate, not a valid terminal explanation.
- For 5520, current config after asxs single-key correction has `gateway_priority_5520:default` pools `fwd.free.gpt-5.5` and `fwd.paid.gpt-5.5`; active forwarders expand to `cc.key1.gpt-5.5`, `asxs.crsa.gpt-5.5`, `1token.key1.gpt-5.5`, `55ai.key1.gpt-5.5`.
- Current source/live diagnostic evidence: Rust regression `non_default_route_with_forwarder_pools_preserves_default_floor_after_all_real_targets_excluded` passes, `verify:vr-route-availability-default-floor` passes, and `routecodex port dry-run 5520` with `metadataCenterSnapshot.excludedProviderKeys` for all 5520 GPT targets selects `default -> cc.key1.gpt-5.5` with `defaultFloorProtected=true` and `wouldReturnProviderNotAvailable=false`.
- Debug rule: use the active aggregate listener log (`server-4444.log` for the 5520/4444/10000 process in this run) plus `routecodex port dry-run ... --metadata-json '{"metadataCenterSnapshot": ...}'`; top-level request `metadata.excludedProviderKeys` on `/v1/responses` is client payload and is not an internal VR exclusion control.

# 2026-07-16: default forwarder exclusions must preserve the default floor
- Default-route forwarder tests must not expect `PROVIDER_NOT_AVAILABLE` merely because request-level exclusions cover every real target. The no-empty-default contract means Rust VR must preserve the ordered default floor provider and mark `defaultFloorProtected=true`.
- Diagnostic dry-run for this shape should return `ok=true`, `selectedRouteName=default`, `wouldReturnProviderNotAvailable=false`; stale tests or docs that expect default forwarder exhaustion are wrong and should be rewritten, not worked around in TS.
- Verified gate set: targeted Rust default-floor tests, `verify:vr-forwarder-runtime`, `verify:vr-route-availability-default-floor`, `verify:error-pipeline-contract`, `verify:provider-failure-ban-blackbox`, `verify:function-map-compile-gate`, `verify:config-ssot`, and `git diff --check`.
- Live installed-runtime proof: global `routecodex/rcc` 0.90.3935, 5520 `/health` ok, dry-run with all GPT forwarder real targets excluded selected `default -> cc.key1.gpt-5.5` with `defaultFloorProtected=true`; real `/v1/responses` request `openai-responses-router-gpt-5.5-20260716T213655538-552657-11468` returned HTTP 200/completed and exact marker `RCC_5520_SHOWSTOPPER_CHECK_20260716T133655Z`. Runtime sample truth is under `~/.rcc/codex-samples/openai-responses/ports/5520/openai-responses-router-gpt-5.5-20260716T213655538-552657-11468/`.

# 2026-07-16: V3 lifecycle CLI must match the old top-level command shape

- Canonical user-facing lifecycle commands are `rccv3 start|status|restart|stop -c|--config <path>`, matching the established RouteCodex CLI parse shape. The Rust CLI is still only a thin caller of `routecodex-v3-lifecycle`.
- `rccv3 server start|status|restart|stop` remains parse-compatible for existing scripts but is hidden from the main help and must not be documented as the normal startup path. `server run-managed-child` remains internal-only.
- Required delivery proof is the globally installed `rccv3`: main help lists top-level lifecycle commands, `rccv3 start/status/restart/stop` works against a managed instance, and `rccv3 server ...` compatibility remains green. Source-only tests are not enough.
- `rccv3 start` must also preserve old `rcc start` takeover semantics. If the configured listener set is occupied, V3 first uses exact managed control stop; if the port is still held, it signals only explicit PIDs listening on those configured ports, escalating SIGTERM -> SIGKILL. Duplicate managed `start` must restart the same service identity instead of returning `AlreadyRunning`. Broad kill, state deletion, and foreign config takeover remain forbidden.

- 2026-07-16: router-direct must not veto Rust VR default-floor reselect just because the selected provider was excluded on an earlier route tier. Live 5520 sample 553044-11855 selected `default -> cc.key1.gpt-5.5` after `cc-sol -> cc -> asxs -> 1token -> 55ai` failures, but TS excluded-provider guard projected the previous 55ai ECONNRESET before sending cc. Contract: consume Rust `defaultFloorProtected=true` / ErrorErr05 verified-last-provider truth; reject excluded reselects only when Rust availability says alternatives remain or the reselect is unverified.

# 2026-07-16: 5520 router-direct default-floor fix requires install/restart closeout

- Router-direct default-floor excluded-provider guard fix was globally installed and live restarted after Jason correction. Delivery evidence must include global install, exactly one `routecodex restart --port 5520`, health/version/PID alignment, installed dist grep, and live VR default-floor dry-run; source tests alone are not enough for this class.
- Verified live install state: global `routecodex`/`rcc` and `~/.rcc/install/current/package.json` all `0.90.3935`; active aggregate PID 83285 runs `/Users/fanzhang/.rcc/install/current/dist/index.js` and listens on 5520/4444/10000 with `/health.version=0.90.3935`. Port 5555 is a separate `rccv3` process and must not be treated as the 5520 aggregate member.
- Verified runtime behavior after restart: live 5520 VR dry-run with internal `metadataCenterSnapshot.excludedProviderKeys` for `cc-sol`, `cc`, `asxs`, `1token`, and `55ai` returns `default -> cc.key1.gpt-5.5`, `defaultFloorProtected=true`, `wouldReturnProviderNotAvailable=false`. The active log for this aggregate is `~/.rcc/logs/server-4444.log`; `server-5520.log` can be stale.
- 5520 route truth after restart: multimodal/default pools include `cc.key1.gpt-5.5` through `fwd.free.gpt-5.5` and `asxs.crsa.gpt-5.5` through `fwd.paid.gpt-5.5`; asxs is not absent from 5520 multimodal/default.

# 2026-07-16: V3 `rccv3 start` console parity and Relay JSON continuation truth

- Canonical V3 lifecycle user commands are top-level `rccv3 start|status|restart|stop -c|--config <path>`. `rccv3 start` with no `-c` resolves to `~/.rcc/config.v3.toml`; `--snap` forces V3 debug snapshots. `rccv3 server ...` is hidden compatibility only.
- Foreground `rccv3 start` must own the terminal like old `rcc start`: no invented `starting...` line and no status JSON then exit. It forces server console independent of config `debug.log_console`, prints startup listener events, and common server entry logging must emit `V3Server03HttpRequestRaw` for both Direct and Relay requests.
- V3 start listener takeover semantics match old `rcc start`: first exact managed control stop for the configured instance, then only explicit listener PIDs for the configured ports are signaled SIGTERM then SIGKILL if necessary. Broad kill, state deletion, and foreign-config takeover remain forbidden.
- V3 Responses Relay JSON local continuation truth: Resp04 saves pending tool calls into a server-scoped local continuation store; next Req04 restores the saved function call context before the current `function_call_output`, preserves `tools`, and wrong/missing `call_id` fails before provider send. Live 5555 JSON two-turn tool replay passed; SSE local continuation save/restore is not implemented or claimed.
- Live closeout evidence: globally installed routecodex/rcc/rccv3 0.90.3935; 5555 `/health`, `/v1/models`, JSON `/v1/responses`, SSE `/v1/responses`, foreground startup/request console, `--snap` debug status, and real-provider JSON two-turn tool replay passed. SSE emitted marker plus `response.completed` but no `[DONE]`. V2 ports 5520/4444/10000 stayed healthy while V3 5555 ran and after `rccv3 stop`.

# 2026-07-17: 5520 router-direct original replay no client-visible 400
- Router-direct default-floor retry is finite: Rust VR may preserve the default-floor provider, but Rust ErrorErr05 must stop request-local retry on route=default once every concrete default candidate is excluded; the executor must not loop directAttempt>=7 by repeatedly reselecting the floor.
- ErrorErr05 bridge/executor must pass routeName; primary/non-default routes may still use the default pool beyond normal attempt budget, while the default route may only continue if a concrete default candidate remains.
- Non-projectable provider retry stop must not expose raw upstream 400 as client error.code. Use ROUTECODEX_PROVIDER_RETRY_STOPPED with HTTP 502 and keep upstream code/status only in non-projecting debug evidence such as retryStoppedEvidence.
- Online closeout for this class requires global install, managed routecodex restart --port 5520, and replay of the original reconstructed request. Final verified replay openai-responses-router-gpt-5.5-20260717T012323938-554447-581 returned HTTP 502 with SSE code=ROUTECODEX_PROVIDER_RETRY_STOPPED, no HTTP_400/literal 400 in the client SSE, direct attempts [1..6], no directAttempt>=7, and no final HTTP_400 log. Upstream provider-level 400 can still appear before backoff/switch; do not call that client-visible 400.

# 2026-07-17: GPT provider router-direct request cleaning is forbidden
- Current 5520 GPT provider direct targets such as `asxs`, `cc`, `1token`, and `55ai` must receive the standard direct request semantically intact. Do not add `compatibilityProfile`, provider capability branches, or Rust/TS sanitizers that remove `reasoning.summary`, `instructions`, `client_metadata`, `prompt_cache_key`, `include`, `tools`, or history items to work around GPT provider 4xx/5xx.
- Verified guard: `tests/server/runtime/http-server/router-direct-pipeline.spec.ts` locks asxs/openai-family direct `/v1/responses` to preserve the exact request object and key fields even when model capabilities include `no_reasoning_summary`.
- Minimal 2026-07-17 asxs root cause: the single isolated invalid part was top-level legacy `reasoning_effort` on an OpenAI Responses direct payload. Direct upstream replay to asxs returned HTTP 200 with `reasoning.effort=medium` and no top-level `reasoning_effort`, then HTTP 502 when only top-level `reasoning_effort=medium` was added. RouteCodex must project route thinking to `reasoning.effort` for `providerProtocol=openai-responses`; it must not inject top-level `reasoning_effort` there.
- Installed/live evidence after global install and managed 5520 aggregate restart: dry-run `model=asxs.gpt-5.5` selected `asxs.crsa.gpt-5.5` with `hasTopReasoningEffort=false`; live `/v1/responses` through 5520 using `model=asxs.gpt-5.5` returned HTTP 200 and `outputText=ok`.

# 2026-07-17: V3 transparency for headers and continuation scope
- V3 is a transparent server for client/provider protocol data. It must not invent protocol-visible headers, session IDs, thread IDs, or continuation identity. Client-provided headers and body fields remain protocol data plane; RouteCodex may read them for routing/continuation scope, but must not add replacement session headers or synthesize a client identity.
- For Responses continuation, valid scope truth comes from transparent client input such as `session-id`/`thread-id`, `x-codex-turn-metadata`, or body `client_metadata.session_id` / `client_metadata.thread_id`. If a request can create or consume continuation state and no client scope exists, fail explicitly instead of using `request_id` as a fake session.
- Internal request-scoped identifiers may be used only for non-continuation single-turn execution and must never enter provider/client normal payloads or headers.

# 2026-07-17: V3 F1 mainline owner queryability gate is locked
- V3 mainline chain/edge `owner_feature_id` is now checked by `npm run verify:v3-resource-relation-edge-lock`: every owner used in `docs/architecture/v3-mainline-call-map.yml` must resolve through both `docs/architecture/v3-function-map.yml` and `docs/architecture/v3-verification-map.yml`.
- The F1 missing owners are registered in V3 function map: `v3.config_interpreter_contract`, `v3.debug_error_foundation`, `v3.foundation_p0_p2`, `v3.responses_direct_mvp_architecture`, `v3.responses_provider_runtime`, and `v3.virtual_router_target_interpreter`; `v3.config_interpreter_contract` also has its verification-map row.
- Red fixtures lock the regression: missing chain owner, missing edge owner, and missing verification owner all fail in `npm run test:v3-resource-relation-edge-lock-red-fixtures`. This closes only F1; F2/F3/F4 stay independent.

# 2026-07-17: V3 foreground monitor and Responses Relay full-history continuation truth

- `rccv3 start` foreground stdout is a human operator monitor, while structured startup/request node events remain debug/log truth. Installed startup must print one minimal `[RouteCodexV3] Server started on <address>` line without lifecycle status JSON or raw node JSON; `/v1/responses` prints the old-production request shape with ANSI session color and highlighted key/value fields, and projected failures print red `❌` with ErrorErr chain identifiers.
- Console color is display-only. It may be derived from transparent client headers/body/turn metadata or a request-local display key, but must never create a protocol-visible session/header, continuation scope, or provider/client payload field.
- Responses Relay local continuation restore applies only to orphan tool outputs. If the current full-history `input` already contains a tool call and matching output with the same `call_id`, that pair is complete transcript truth and must not query the local continuation store.
- Live installed 5555 evidence after the correction: minimal foreground startup line; colored request and error monitor lines; `/health` and `/v1/models` success; real provider single-turn JSON success; body-only `client_metadata` two-turn tool replay success without invented headers; no-session paired full-history replay HTTP 200/completed; V2 5520/4444/10000 stayed healthy concurrently.

# 2026-07-18: V3 live observability closeout requires entry+exit blackbox

- V3 foreground console alone is not sufficient evidence for `/v1/responses` live closeout. A closed debug/sample loop must prove both sides: `/_routecodex/debug/status` raw request/response counts increment, `~/.rcc/logs/server-<port>.log` receives human monitor lines, and canonical `~/.rcc/codex-samples/openai-responses/ports/<port>/<requestId>/request.json|response.json` exist.
- `rccv3 start --snap` with no configured `debug.log_file` must project `~/.rcc/logs/server-<first listener port>.log` and keep snapshots enabled. Blackbox proof is a real provider-request dry-run through the running server, not only debug crate unit tests.
- For Responses Relay SSE replay, success evidence is HTTP 200 plus semantic terminal (`response.completed`/`response.done`) and `[DONE]`, absence of synthetic failure/local continuation/provider availability errors, and matching route/usage/finishReason console lines. On 2026-07-18, prior 561899 payload replayed on installed 5555 with `response.completed=2`, `[DONE]=1`, and usage `in:162538 out:653 total=163191`.

# 2026-07-17: `/v1/models` capability catalog uses explicit route-surface authority

- For `server.models_capability_contract`, installed/live `/v1/models` must derive visible bare Codex model capabilities from compiled Virtual Router runtime status when it exists. Source-config projection is only for construction/test contexts without runtime status; it must not recover empty/malformed/conflicting runtime status.
- The regression test must include a conflict case: source config advertises a different model, compiled runtime status advertises the actual route-surface models, and `/v1/models` exposes only runtime-status models.
- Verified closeout: global install `0.90.3937`, one aggregate restart via install script, health ok on 4444/5520/10000, live 5520 `/v1/models` returned only `gpt-5.5` and `gpt-5.6-sol`; `gpt-5.5` had no `use_responses_lite`, `gpt-5.6-sol` retained `use_responses_lite=true`, and terra/luna were absent. Current 5520 VR status still includes `gpt-5.6-sol` in coding/thinking, so exposing `gpt-5.6-sol` is config truth, not model-catalog leakage.

# 2026-07-17: V3 stopless hook belongs to servertool Chat Process skeleton

- V3 normalization/projection nodes (`ReqInbound`, `RespInbound`, `ReqOutbound`, `RespOutbound`) must remain logic-free for tool governance and hook payload processing. The gate `verify:v3-normalization-payload-logic-boundary` plus red fixtures locks tool governance, schema judgment, tool-result rewrite, servertool/stopless hook logic, continuation restore/save semantics, and payload repair out of these boundary nodes.
- V3 stopless is the first built-in hook on `v3.servertool_hook_skeleton_lifecycle`, not a separate lifecycle skeleton. Response-side stopless runs inside Resp03 before Resp04 continuation commit; request-side stopless runs inside Req04 after continuation/context restore and before request tool-output governance.
- Current implemented slice is controlled runtime only: response hook projects missing terminal stop schema into client-visible `exec_command(routecodex hook run reasoningStop ...)`; request hook parses that CLI result, rewrites to a normal user prompt, and injects stop schema instructions. No live cutover, global install/restart, servertool followup reenter, or apply_patch lifecycle completion is claimed for this slice.

# 2026-07-17: V3 normalization maps protocols; Chat Process owns tool identity governance

- Inbound normalization means entry/upstream protocol -> Hub chat process semantics; outbound normalization means Hub chat process semantics -> target provider/client-entry protocol. Adjacent protocol mapping, field projection, and shape/type validation are valid normalization work.
- Tool identity pairing/uniqueness/orphan judgment, tool-result governance, servertool/stopless/apply_patch hooks, and continuation save/restore decisions are not normalization. Request-side identity governance runs in Chat Process after context/continuation restore; response-side identity governance runs before continuation commit.
- Chat Process must select protocol governance from typed entry-protocol truth, not by guessing from payload keys such as `messages` or `contents`; otherwise unrelated protocols can be governed accidentally.
- `ProviderReqCompat06ProviderCompat` and `ProviderRespCompat02ProviderCompat` are currently `binding_pending` skeleton contracts. Compat may apply provider-family micro-adjustments, but must not remap the whole protocol, re-run tool governance, select route/model, inject side-channel state, or fallback/silently repair.
- Regression truth: `verify:v3-normalization-payload-logic-boundary` rejects OpenAI Chat request/response and Gemini request identity governance inside normalization, rejects tool governance in either compat node, and explicitly permits Anthropic protocol mapping.

# 2026-07-17: V3 owns an independent SSE transport crate and Anthropic provider SSE projection

- V3 SSE framing/lifecycle transport truth is `v3/crates/routecodex-v3-sse`; V3 provider/runtime/server crates must depend on `routecodex-v3-sse`, not the V2 `sharedmodule/llmswitch-core/.../sse-transport-core`. The crate is transport-only: incremental decode/encode, limits, backpressure/lifecycle terminal state; it must not own tool governance, continuation, stopless, routing, or provider selection.
- Responses -> Anthropic Messages provider compat must preserve role/content input items even when they omit `type`, and must fail before provider send if the resulting `messages` array is empty. For Anthropic streaming, `content_block_start` with `tool_use` plus `input_json_delta` is provider protocol truth and must be projected to Responses tool items instead of being dropped as non-text.
- `apply_patch` streamed through Anthropic provider compat is client-visible as Responses `custom_tool_call` with raw `input`; do not leak the patch through `function_call.arguments`. A tool-use stop projects `requires_action`.
- Verified installed/live baseline: RouteCodex `0.90.3937`; 5555 normal SSE completed; apply_patch provider dry-run produced `MiniMax-M3` with one message; online freeform apply_patch replay exited 0 with exact raw patch and no arguments leak. Source baseline: V3 SSE 7 tests, provider-responses 28 tests, V3 fmt/clippy, function-map/mainline/Relay-closeout gates all pass.
- Known separate lifecycle gap: `routecodex restart --port 5555` can report no managed server while V3 health/models and its listener remain live. Do not bypass this with broad/manual process killing; fix the managed lifecycle owner separately.

# 2026-07-17: V3 SSE closeout must distinguish terminal-close from pre-terminal drop

- In server-side SSE console closeout, Body drop alone is not proof of client disconnect. Codex/client may stop reading after receiving terminal `response.completed`, `response.done`, `response.failed`, `response.incomplete`, or `[DONE]`; this must be logged as completed/terminal, not `499 client_disconnect`.
- `V3SseConsoleCloseoutStream` must observe outbound SSE frames before classifying Drop. Only drop before any terminal frame is a pre-terminal disconnect. Drop after a terminal frame is normal terminal-close.
- Regression proof: `relay_sse_closeout_treats_drop_after_terminal_frame_as_completed` keeps the provider stream pending after a terminal frame and then drops the body; expected closeout is `Completed`, not `Dropped`.

# 2026-07-17: V3 Responses Relay SSE requires a semantic terminal, not bare EOF

- For `/v1/responses` Relay SSE, `[DONE]` and transport EOF are transport markers only. Success requires a semantic terminal event such as `response.completed` or `response.done`; failure terminals are `response.failed`, `response.incomplete`, or `response.error`.
- If provider SSE EOF or provider stream error occurs before a semantic terminal, V3 must project a client-visible `response.failed` event and then close with `data: [DONE]`. Abrupt stream close causes Codex to report `Stream disconnected before completion: stream closed before response.completed`.
- Console closeout must mirror the semantic terminal: success terminal prints ✅, failure terminal or no-terminal EOF prints ❌, and error observability must not additionally print a green completed line after 4xx/error.
- Verified live baseline on 5555 after global install `0.90.3937`: real `/v1/responses` SSE through `orangeai/glm-5.2` returned HTTP 200 with `response.completed`, detailed usage (`in/out/cache/total`), and console `✅ responseStatus=completed`; controlled red/green tests cover EOF-without-terminal and provider-stream-error projection to `response.failed + [DONE]`.

# 2026-07-17: V3 Responses Relay provider failures are shared-health governed

- Responses Relay provider failure handling must use a server/aggregate-shared `V3ProviderHealthStore`; request-local exclusions alone cannot enforce cross-request cooldown and can cause repeated provider storms.
- Selection rule: if excluding the failed providerKey leaves another candidate, reselect immediately with no 5s wait; if there is no alternate candidate, retry the same candidate three times, waiting 5s before each retry by default.
- Cooldown rule: providerKey identity is `provider_id:auth_alias:model_id`. Three consecutive provider failures trip a default 15 minute process-local cooldown; success clears partial failures when no active cooldown exists; other auth keys/models must stay selectable.
- Verified source baseline: clean staged-patch worktree passed Hub Relay runtime closeout 8/8, provider health contract 5/5, server provider reselect focused blackbox, and server cargo check. Full server package still has an unrelated boundary-test failure outside this provider retry/cooldown slice.

# 2026-07-17: V3 provider compat nodes are runtime-adjacent, not declaration-only

- V3 provider compat now has typed runtime landing points on the two correct adjacent edges: `V3HubReqOutbound07ProviderSemantic -> ProviderReqCompat06ProviderCompat -> V3ProviderReqOutbound08WirePayload` and `V3ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized`.
- The current profile is explicit `compat:passthrough`; this closes the runtime/map/hook landing point only. It does not claim V2 provider-specific profile loader parity or migration of the old 7 compat JSON profiles.
- Compat boundary: provider-family micro-adjustments may live here later, but tool governance, apply_patch/servertool/stopless lifecycle, tool identity pairing, route/model selection, fallback, silent repair, and MetadataCenter/side-channel injection must remain outside these compat nodes.
- Verified source baseline: V3 static hook/resource/normalization/module/architecture/function-map/mainline gates, V3 fmt/clippy, controlled Relay runtime integration tests, continuation/config/managed lifecycle tests, build:v3-cli, and red fixtures passed. No global install, restart, or live 5555 replay is claimed for this source slice.
# 2026-07-17: 5555 glm-5.2 context overflow truth

- Historical 5555 context-over-limit errors with message `maximum context length is 202752 tokens ... messages resulted in 203475 tokens` were caused by the selected `orangeai/glm-5.2` upstream path hitting its real provider-side limit around 202752 tokens, not by MiniMax M3 being limited to 200k and not by a confirmed local hardcoded Rust cap.
- Evidence: live logs in `/Volumes/extension/.rcc/logs/server-4444.log` around 2026-07-03 06:28-06:29 show 5555 longcontext selecting `orangeai[key1].glm-5.2` for requests with ~1.02M estimated text chars and provider usage totals rising to exactly `202752`; current `/v1/models` still projects `glm-5.2` from config as 1048576 while `MiniMax-M3` projects 1000000.
- Config implication: provider config/capability catalog for `orangeai/glm-5.2` over-advertised context versus observed upstream behavior. Do not hardcode the cap in code; either live-probe provider context and update provider config, or let provider context errors enter failure policy and reselect/cooldown. Current V3 regression locks a context-length provider error reselecting from a limited provider to `minimax:key1:MiniMax-M3` before client projection.

# 2026-07-17: V3 stopless continuation closeout

- The reported `local continuation is already committed: call_stopless_reasoning` was a local Resp04 store collision, not an SSE projection failure. A fixed stopless call id must be keyed by the full continuation scope; local continuation records now use `(scope, context_id)`.
- Resp04 releases every consumed tool-output context before committing the finalized stopless continuation. Only unpaired current outputs are restored; paired full-history outputs are not restored a second time.
- The stopless CLI projection is executable with `routecodex hook run reasoningStop --input-json '{}'`; `continuationPrompt` is parsed as the next ordinary user prompt.
- For `stopreason=2`, the response hook must pass the parsed stop schema as CLI status/control input instead of downgrading to `{}`; otherwise the next provider turn receives a generic `继续。` prompt and can one-round stop silently.
- Finish reason inference is observability-only: when the provider omits a finish reason, finalized `LocalContext` may display `tool_calls`, but the inferred value cannot trigger hook/schema decisions.
- Verified focused tests (8 response, 8 request, 8 Responses continuation, 11 store, 15 servertool parity), V3 architecture/red gates, global install, managed V3 5555 restart, and live three-state probe. Live result was `requires_action -> requires_action -> completed` with no duplicate commit or provider/client error.

# 2026-07-18: V3 apply_patch guidance and Anthropic custom-tool compat

- V3 apply_patch request guidance belongs to the Req04 Chat Process hook, after local continuation restore and before provider outbound. It must inject at most one `[Codex Tool Guidance]` block only when the current Responses request declares `apply_patch`; requests without that tool must remain unchanged.
- Provider-specific apply_patch schema compatibility belongs in provider transport/compat, not normalization, SSE, server handler, store transport, MetadataCenter, or direct request cleanup.
- Anthropic schema-less custom `apply_patch` maps to a required `patch` string schema with `additionalProperties=true`; unrelated schema-less custom tools use a generic object schema and must not inherit apply_patch schema.
- Verified with focused positive/reverse Req04 tests, Anthropic provider compat tests, V3 relay/module/fmt/clippy/provider gates, function/verification-map gates, global install 0.90.3937, managed V3 5555 restart, `/health`, and live apply_patch replay on `http://127.0.0.1:5555/v1/responses` preserving the exact raw patch with zero function-arguments or JSON-wrapper leaks.

# 2026-07-18: V3 stopless console activation observability

- V3 stopless console printing must not infer activation from `finishReason=stop`. After stopless projection, finalized observability can be `responseStatus=requires_action` with `finishReason=tool_calls`.
- The stable runtime truth for console activation is an internal observability bit derived from finalized stopless projection evidence: `output[].call_id=call_stopless_reasoning` and `name=exec_command`.
- Server console may print the fixed purple `🧭 [stopless]` human monitor line from that observability bit, but must not mutate protocol-visible headers, session IDs, provider/client body, MetadataCenter payload, or SSE semantics.
- Verified live on installed 5555: `scripts/tests/stopless-5555-live-probe.mjs` completed `requires_action -> requires_action -> completed`, and foreground tmux capture showed two ANSI purple `\x1b[35m[5555] 🧭 [stopless]` lines with `hook=reasoningStop callId=call_stopless_reasoning action=exec_command finishReason=tool_calls`.

# 2026-07-18: V3 live Responses stopless must accept completed Responses object without finish_reason

- Real 5555 Responses Relay providers can return canonical Responses JSON with `object=response,status=completed` and no top-level `finish_reason`. Stopless response hook decisions must not depend on later console finishReason inference.
- In Resp03, when stopless profile is active and the assistant output has missing/invalid terminal schema, `object=response,status=completed` is a valid stop candidate for projecting `exec_command(routecodex hook run reasoningStop ...)`. This belongs only to Chat Process response hook owner, not SSE/server handler/resp_outbound/logging.
- Verified installed/live on 5555 after global install `0.90.3937`: `/tmp/stopless-5555-live-schema-matrix-after-fix-full-20260718T021415Z.json` ran schema_correct/schema_missing/schema_invalid with 3 attempts each and submit continuation rounds up to 3; all scenarios were `ok=true`, with no `local continuation not found` and no `local continuation is already committed`.

## 2026-07-18 5520 asxs 502 route fix
- 5520 live log truth remains aggregate logs, not stale `server-5520.log`: latest evidence during this incident was `/Volumes/extension/.rcc/logs/server-4444.log` (with a short post-restart window in `server-10000.log`).
- `asxs.crsa.gpt-5.5` can intermittently surface Cloudflare/Bad Gateway/invalid JSON behavior; do not fix by adding request sanitizer/compatProfile or payload trimming in RouteCodex.
- For this incident, provider probes showed `55ai.gpt-5.5` healthy (`routecodex provider doctor 55ai --model gpt-5.5` -> OK), `asxs.gpt-5.5` not reliable (`Invalid JSON response` in provider doctor / prior 502 evidence), and `1token.gpt-5.5` not a valid 5520 paid-route fix (`Forbidden` in provider doctor). The verified live config fix was `fwd.paid.gpt-5.5` priority `55ai > asxs`, with 1token not in that paid forwarder.
- Verification for the fix: both `/Volumes/extension/.rcc/config.toml` and `~/.rcc/config.toml` validated; aggregate `routecodex restart --port 5520`; `/health` OK on 5520/4444/10000 at version 0.90.3937; `routecodex port status 5520 --json` showed paid targets `55ai.key1.gpt-5.5`, `asxs.crsa.gpt-5.5`; live `POST /v1/chat/completions model=55ai.gpt-5.5` and normal `POST /v1/responses model=gpt-5.5` returned HTTP 200.

## 2026-07-18 5520 asxs 502 request construction correction
- Supersedes the earlier `2026-07-18 5520 asxs 502 route fix` note: changing `fwd.paid.gpt-5.5` to `55ai > asxs` was the wrong remediation for Jason's asxs task. The correct baseline is the restored paid forwarder order `asxs.crsa.gpt-5.5` before `55ai.key1.gpt-5.5`; do not remove/demote asxs for this class of issue without explicit authorization.
- Verified root request-construction defect: OpenAI Responses same-protocol direct routing used to preserve client-supplied top-level legacy `reasoning_effort` on provider wire. The red test against old code failed because `providerRequest.body.reasoning_effort` remained present. The fix is in Rust `direct_route_model_hooks.rs`: for `providerProtocol=openai-responses` + routing semantics, remove `reasoning_effort` / `reasoningEffort` and write/map the value only to nested `reasoning.effort`; explicit passthrough remains semantically intact.
- Verified installed/live after global install `0.90.3940` and one aggregate `routecodex restart --port 5520`: 5520/4444/10000 health all report version `0.90.3940`, `port status` keeps `fwd.paid.gpt-5.5` as `asxs.crsa.gpt-5.5`, `55ai.key1.gpt-5.5`, and live dry-run `model=asxs.gpt-5.5` with both legacy top-level fields produces provider body keys `input,max_output_tokens,model,reasoning,store,stream` with no top-level `reasoning_effort` / `reasoningEffort` and nested `reasoning.effort` preserved.
- Current live limitation: after the RouteCodex request body is clean, asxs still returns upstream HTTP 503 `service_unavailable` for both the exact clean RouteCodex body and a minimal clean no-reasoning upstream probe. Therefore do not claim end-to-end asxs availability is fixed; claim only that the RouteCodex invalid top-level legacy-field construction is fixed and the remaining live 502 is provider/account/upstream availability.

## 2026-07-18  V3 stopless hook now uses V2 trigger semantics and budget gate
- `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs` no longer emits the invented `schema_continue` trigger. Response-side stopless projection now maps `stopreason=2` to `non_terminal_schema` and malformed stop schema to `invalid_schema`, while `finish_reason=stop` / completed response objects without schema still follow `no_schema`.
- Repeat budget exhaustion now stops CLI projection entirely for `no_schema`, `invalid_schema`, and `non_terminal_schema`; the hook returns the original completed response instead of fabricating an empty reasoningStop command.
- Verified with white-box tests for `non_terminal_schema` / `invalid_schema` trigger hints and budget closure, plus cross-request black-box coverage for both `json_stopless_no_schema_stops_after_three_cross_request_rounds` and `json_stopless_invalid_schema_stops_after_three_cross_request_rounds`.


# 2026-07-18: Codex Responses reasoning effort wire shape and RouteCodex no-loss projection
- Current `~/code/codex` (`/Volumes/extension/code/codex`, observed HEAD `1bbdb32789`) does not build `/v1/responses` provider requests with top-level `reasoning_effort` / `reasoningEffort`. Codex `ResponsesApiRequest` / `ResponseCreateWsRequest` carry `reasoning: Option<Reasoning>`, where `Reasoning` contains nested `effort`, `summary`, and `context`; `core/src/client.rs` sends this struct through HTTP or WebSocket without a top-level effort alias.
- Same-name field caution: Codex uses `reasoning_effort` for config/session/thread metadata, analytics, app-server protocol, and subagent/multi-agent tool parameters. A live RouteCodex sample can contain `reasoning_effort` under a tool schema path such as `input[].tools[].parameters.properties.reasoning_effort`; that is not provider-wire top-level request data.
- RouteCodex OpenAI Responses same-protocol direct routing must treat top-level `reasoning_effort` / `reasoningEffort` only as a legacy provider-wire alias. In Rust `direct_route_model_hooks.rs`, remove the alias before provider send; preserve existing canonical `reasoning.effort` unless `routeThinking` intentionally overrides it; map legacy alias into nested effort only when nested effort is absent. Preserve `reasoning.summary` and the rest of the GPT direct payload.
- This is a protocol projection/no-loss rule, not an `asxs` compatibility profile, sanitizer, provider-specific branch, request cleanup, fallback, or route demotion. If a clean asxs provider request still returns HTTP 503, report remaining provider/account/upstream availability separately from RouteCodex request-shape correctness.
