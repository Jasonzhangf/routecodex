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
