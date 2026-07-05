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
- Provider health restart recovery must clean expired persisted cooldowns during `refresh_provider_health_from_store()`, not wait for a later health write. Verified live on 5555 with `orangeai.1.glm-5.2` `cooldownExpiresAt=null`, `state=healthy`, `available=true`.
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
- Verified rule: imported persisted provider cooldown may be read for cleanup/compatibility, but it must be cleared during `VirtualRouterEngineCore::refresh_provider_health_from_store()` before Virtual Router startup selection/availability treats it as live health truth. Fresh runtime failures still own health/cooldown truth and clear the imported marker before persistence.
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
