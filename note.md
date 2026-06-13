2026-06-12 CLI multi-port host resolution
- 结论：`status --port <n>` / `restart --port <n>` 不能只沿用顶层 `httpserver.host`；多端口配置时必须按目标端口读对应 `[[httpserver.ports]]` 的 host，否则会把 10000 这类端口的健康探测和 restart 误导到 loopback。
- 证据：`tests/cli/status-command.spec.ts` 与 `tests/cli/restart-command.spec.ts` 新增定向回归已绿，覆盖 explicit `--port 10000` 不再 probe `127.0.0.1:10000`。
- 可复用动作：CLI 端口相关动作先解出 target port 的实际 host，再做健康探测/重启；不要把顶层 host 当所有端口的默认真源。

2026-06-12 stopless goal-state audit
- Current state: TS bridge state-integrations.ts still contains stopless sync/read/persist logic and native calls; stopless-goal-state.ts is not the only owner.
- Risk: worktree has many unrelated modified files from other work; must avoid broad edits.
- Next focus: create red tests that lock current mismatch / TS bridge dependency / persisted 503-reprobe residue, then repair only the unique owner path.
- Evidence to verify: sync/read/persist call chain, router-hotpath-napi bridge exports, health/selection/status behavior, and live/sample replay if possible.
2026-06-12 stopless bridge + persisted 503 closeout progress
- stopless focused Jest green: stopless-goal-state, state-integrations-stopless-goal.red, provider-startup-health-red.
- Rust health suite green: cargo test -p router-hotpath-napi --lib virtual_router_engine::health -- --nocapture.
- Selection residue identified: obsolete persisted reprobe test in selection.rs removed physically; re-running selection + required TS focused suites.

2026-06-12 CLI 10000 probe-host bug
- Root cause confirmed: `status --port 10000` and `restart --port 10000` could inherit top-level `httpserver.host=127.0.0.1` instead of the target `[[httpserver.ports]] host=0.0.0.0`, so CLI health probes could hit loopback and misidentify another local service as RouteCodex.
- Unique owner fixed: `src/cli/commands/port-group-resolver.ts` now resolves per-target host for multi-port configs; `src/cli/commands/status.ts` now uses that same per-port host resolution when `--port` is provided.
- Red tests added: `tests/cli/status-command.spec.ts` and `tests/cli/restart-command.spec.ts` now lock that `10000` explicit-target probes must not reuse top-level loopback host.
2026-06-12 provider-response hot-path log repair
- Audit blocker: provider-response slice tests were green, but unguarded console.log diagnostics remained in response conversion hot paths.
- Unique repair point: remove those diagnostics and their dedicated shape helper from provider-response/provider-response-converter; no response semantics changed.

2026-06-12 DF alias/canonical model audit
- Root cause confirmed in Rust VR bootstrap owner: `provider_bootstrap.rs` mixed declared `provider.models.<modelId>` and `aliases` into one `modelIndex.models`, while `routing/bootstrap.rs` and `build_provider_profiles()` treated route target third segment as final `model_id`. Result: client alias could leak into `targetRuntime.modelId` and upstream request `body.model`.
- Repair direction implemented in Rust owner only: split `ModelIndexEntry` semantics into canonical `models` plus `alias_to_model`; routing may accept alias input but must expand to canonical target key; provider profile/target runtime `modelId` must always be canonical provider model id.
- Verification in progress: focused Rust tests for `virtual_router_engine::provider_bootstrap` and `virtual_router_engine::routing::bootstrap`, then Node/tsc/install/restart/live 10000 replay with DF uppercase wire model + lowercase client alias config.
2026-06-12 executor 429 cross-pool reroute audit
- User-reported live failure: 5520 still surfaces upstream HTTP_429 to client before falling through layered route pools; expected behavior is keep rerouting until default pool is actually exhausted.
- Root cause narrowed to ErrorErr05 execution decision input, not provider runtime: executor uses current-attempt routePool visibility, and later narrowed routePool views can overwrite the earlier full fallback chain.
- Repair direction: preserve and extend the full explicit routePool chain across attempts inside request-executor-pipeline-attempt; do not infer chain from routingDecision.pool when explicit routePool is absent.
- Required verification pair: positive test for preserving full chain when later attempt only reports narrowed pool; negative test proving no synthetic fallback chain is created from pool-only routing decisions.

2026-06-12 executor layered routePool carry + build gate repair
- Build blocker 1 fixed: sharedmodule JsonObject now allows undefined optional members, which unblocks hub type surfaces like chat-envelope under strict TS.
- Build/test blocker 2 fixed: root session-log-color no longer imports llmswitch-core ESM runtime; local pure helper mirrors color-key/color-palette semantics so root tsc and Jest stay stable.
- Executor 429 reroute fix tightened: resolveRequestExecutorPipelineAttempt now preserves/extends only explicit routingDecision.routePool across attempts and no longer synthesizes chain from routingDecision.pool.
- Verified pair: positive preserve-chain and negative no-synthesis tests both green; root tsc rerun pending live install/restart.

2026-06-12 SSE terminal closeout progress
- TS updateSseTerminalTrackerFromChunk now treats assistant response.output_item.done(message/completed) as terminal-source so terminalFlushTimer can auto-close hung non-continuation response streams.
- Rust upsert_probe_output_item now replaces matching probe output items and marks assistant message/completed probes as completed, so terminal repair frames use completed status instead of stale in_progress.
- Added blackbox regression for assistant response.output_item.done without upstream completed/done to lock the hang shape.

2026-06-12 direct Responses SSE semantic-timeout closeout
- Live 5555 hang root cause confirmed from sample: upstream direct SSE sent semantic reasoning frames, then only keepalive/comment traffic without terminal; old byte-idle timeout was reset by keepalive so client could hang.
- Unique repair point: `src/providers/core/runtime/responses-provider.ts` direct SSE passthrough now has semantic no-content/content-idle timers; keepalive/advisory frames do not reset semantic activity, and timeout calls upstream iterator return before surfacing explicit timeout error.
- Regression gate: `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` covers keepalive-only no-content timeout, semantic-frame then keepalive content-idle timeout, and semantic terminal success path.
- Build/install/live evidence: `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` passed; installed `0.90.3058`; health green on 5520/5555; live `/v1/responses` SSE probes on 5520 and 5555 both emitted `response.completed=1`, `response.done=1`, `event:error=0`.
- Tool/SSE blackbox evidence: `responses-client-tool-contract.blackbox` and `responses-sse-client-contract.blackbox` passed; `responses-handler.sse-terminal-event.blackbox` still fails in source-test env because native shared conversion module is unavailable, while installed live runtime path is green.

2026-06-12 inline tool-result reroute + live SSE validation
- Root cause narrowed from live failure `openai-responses-router-gpt-5.5-20260612T145225698-338351-264`: request body was inline Responses history containing `function_call_output`, not provider-native `previous_response_id`; executor incorrectly used `isToolResultFollowupTurn` as provider-owned continuation and could block cross-provider reroute.
- Unique repair point: `request-executor.ts` now only sets `providerOwnedContinuation` when `isProviderNativeResumeContinuation` sees native resume fields (`previousResponseId/previous_response_id` or `submit_tool_outputs` with response id). Plain inline `function_call_output` history remains reroutable.
- Regression gate: `request-executor-request-semantics.spec.ts`, `retry-execution-plan.spec.ts`, `request-executor-cross-pool-fallback.red.spec.ts`, and direct SSE passthrough suite passed together: 4 suites / 25 tests.
- Build/install/live evidence: global install/restart completed with `0.90.3058`; health green on 5520/5555. Live SSE no-metadata probes completed on both ports with HTTP 200, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit.
- Inline tool-output live probe on 5520 with minimal `function_call` + `function_call_output` history completed HTTP 200 in 95.9s, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit; log shows stopless servertool triggered and completed as `finish_reason=tool_calls`.
- Invalid evidence note: an earlier live smoke using custom `metadata.routecodex_test_marker` correctly failed at req_adapter as unsupported client metadata; do not treat that 502 sample as provider/reroute failure.

2026-06-12 DF alias/canonical model audit (live probe pending)
- Verified evidence: AGENTS now states provider.models.<modelId> is the only upstream wire model; aliases are client-facing only. Existing tests already expect /v1/models to show alias ids while provider_bootstrap keeps canonical modelId.
- Likely failure mode: outbound provider request still maps client alias modelId through without canonicalization, or live config for DF lacks canonical wire model mapping.
- Next verification: live /v1/chat/completions on 10000 with DF provider; inspect actual outgoing body.model and server logs for providerKey/modelId.

2026-06-12 DF direct probe closed
- Verified on live DreamField: POST https://www.dreamfield.top/v1/chat/completions accepts canonical model ids DeepSeek-V4-Pro and DeepSeek-V4-Flash (200). Lowercase aliases deepseek-v4-pro/deepseek-v4-flash return 503 model_not_found. /chat/completions is HTML, /v1/responses is not the right entry for this provider.
- Repair rule: client-visible aliases stay lowercase; provider outbound wire model must be canonical uppercase modelId. /v1/models must only list configured current-port models.

2026-06-12 alias routing audit before approval
- Confirmed keep/no-change point: direct outbound overwrite already has a single owner at `src/server/runtime/http-server/index.ts` direct hook (`payload.model = target.modelId.trim()`). This is the correct canonical wire-model override point and should not be duplicated elsewhere.
- Confirmed Rust bootstrap truth: `provider_bootstrap.rs` / `routing/bootstrap.rs` already preserve canonical `provider.models.<modelId>` and allow route-config alias expansion through `aliasToModel`; existing tests already lock canonical model preservation in bootstrap.
- Confirmed current direct bug surface: `routing/direct_model.rs::parse_direct_provider_model` only splits `provider.model`, and `select_direct_provider_model` / `engine/route.rs` direct branch compare request model to `profile.model_id` by exact string. Lowercase client alias therefore does not hit canonical `DeepSeek-V4-Pro` even though bootstrap knows alias mapping.
- Confirmed relay/forwarder audit: `forwarder.rs::resolve_by_model` is exact `(protocol, modelId)` lookup and does not own alias expansion. Alias expansion should stay before forwarder lookup, in VR request-side normalization, not inside forwarder runtime.
- Confirmed instruction-path asymmetry: `engine/route.rs::normalize_instruction_target_against_registry` can normalize some provider/model targets against registry, but normal request `body.model` direct entry does not reuse that normalization path.
- Confirmed `/v1/models` current behavior: port-scoped listing already uses `collectPortScopedModelItems()` and prefers first configured alias via `readModelDisplayAlias(modelNode) ?? ref.modelId`; it does not need a second model-name mapping path, but full audit should keep it aligned with alias contract.
- Proposed repair direction for approval: keep provider wire override unchanged; add one Rust-side request-model normalization owner for alias -> canonical model before direct selection / forwarder model lookup / family matching. No provider-runtime patching, no TS semantic fallback, no extra outbound remap layer.

## 2026-06-12 same-protocol-direct + DF input_text investigation
- Live issue A: 5520 openai-responses same-protocol requests with client tools are mis-gated to relay via reason=client_tools_require_hub_relay, causing upstream SSE to be materialized before first client byte and client_close before stream start.
- Live issue B: 5555 DF DeepSeek-V4-Pro route targets /v1/chat/completions compat but outbound payload still carries content part type=input_text instead of text; upstream 400 InvalidParameter.

## 2026-06-13 chat resume 2013 investigation
- Failing shape: Minimax chat rejected `tool call result does not follow tool call (2013)`.
- Root cause: `responsesResume.deltaInput` is only the resume delta, but `buildChatRequestFromResponses()` was treating it like the full history whenever `previous_response_id` existed.
- Fix direction: carry `fullInput` through resume/materialize metadata from Rust and prefer that in the Chat bridge; keep `deltaInput` only as delta/diagnostic data.
- Runtime probe: `node --import tsx` on `buildChatRequestFromResponses()` now yields full `user -> assistant.tool_calls -> tool` history when `responses.resume.fullInput` is present, even if the incoming context input is only the tool-output delta.

- 2026-06-12 live log: 5520 direct SSE aborted by server.response_projection because event=response.custom_tool_call_input.delta was treated as non-Responses. Tool stream dies after first tool event.
- 2026-06-12 repair in progress: `handler-response-utils.ts` direct Responses SSE allowlist widened minimally for `response.custom_tool_call_input.delta|done`; blackbox pair added to prove standard custom-tool delta passes while provider-specific `codex.rate_limits` still fails closed.
- 2026-06-12 continuation ownership rule clarified by Jason: remote-owned `previous_response_id/responseId` must continue via direct; locally reconstructed relay-owned ids must continue via relay.
- Root cause confirmed in current code: direct SSE tool-call responses were excluded from `persistNativeSseConversationState()` and from client-close continuation retention, so the first direct turn emitted tool SSE but never persisted `response_id -> owner/providerKey`. A second issue also existed: router resume pin only checked `responsesResume.providerKey`, which cannot distinguish remote direct ids from local relay ids.
- Repair direction in progress: persist direct SSE tool-call continuations too, and record a minimal `continuationOwner=direct|relay` marker in the responses conversation store so only direct-owned ids can re-pin `__shadowCompareForcedProviderKey`.
- 2026-06-12 live continuation probe still fails after ownership patch: first-turn direct tool SSE reaches client and native probe recognizes continuation, but persisted responses store remains empty. Added requestId-scoped trace logs in handler/store around `capture -> record -> finalize -> clear` to determine whether direct SSE persistence is skipped, throws `missing_request_context`, or is later cleared by client-close/cleanup.
- 2026-06-12 live continuation probe refined root cause: after removing handler-side `store:false` gate, direct SSE `capture -> record` executes and in-memory `responseIndex` grows, but `submit_tool_outputs` still fails because `ConversationEntry.allowContinuation` stayed false. Request-side `shouldAllowContinuation(payload)` is insufficient for first-turn tool calls; response-side truth must set `allowContinuation=true` whenever recorded assistant blocks still contain pending tool calls.

2026-06-12 alias canonicalization closeout in progress
- Implemented Rust registry-owned aliasToModel parsing and canonical model resolution for provider profiles.
- direct route selection now resolves provider.model alias to configured canonical modelId before availability/media checks.
- Existing virtual-router alias spec updated to assert target.modelId is canonical, not alias.
- Pending verification: focused Jest/blackbox, build/install/restart, live 10000 DF probe.

2026-06-12 direct submit_tool_outputs 400 root cause
- Live proof from `~/.rcc/logs/server-5520.log`: after continuation-store fixes, `/v1/responses.submit_tool_outputs` no longer dies at resume; it routes to direct `tools/forced -> asxs...`, then upstream rejects with `HTTP 400: {"detail":"Unsupported parameter: providerKey"}`.
- Unique owner confirmed in Rust `shared_responses_conversation_utils.rs`: `resume_responses_conversation_payload` / `restore_responses_continuation_payload` / `materialize_responses_continuation_payload` wrongly write internal `providerKey` back into resumed `payload`.
- Second injection point confirmed after first repair: `prepare_responses_conversation_entry` and TS store release path were also persisting `providerKey` inside `basePayload`; resume then rehydrated that internal field even after the explicit tail insertions were removed.
- Repair rule: keep `providerKey` only in store entry + returned `meta` for route pinning; never write it into `basePayload`, resumed/materialized payload, or release payload. Handler-side continuation trace logs should stay behind `ROUTECODEX_RESPONSES_DEBUG=1` only.

2026-06-12 direct Responses SSE keepalive gate root cause
- Live repro on 5520 current `0.90.3058`: direct `/v1/responses` can receive upstream `event: keepalive` during long-running tool/image substreams. Current direct guard in `src/server/handlers/handler-response-utils.ts` treats that as non-Responses protocol and aborts with `RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION`, producing `finish_reason=unknown`.
- Verified evidence: `~/.rcc/logs/server-5520.log` request `openai-responses-router-router-gpt-5.5-20260612T183042231-338877-790` failed with `[server.response_projection] direct passthrough SSE emitted non-Responses event "keepalive"`.
- Repair direction: do not broaden business-event allowlist; strip/drop upstream transport-only `event: keepalive` frames inside direct passthrough guard so client still sees only standard Responses events while non-standard semantic events remain fail-fast.
- Follow-up live proof after keepalive fix: same 5520 direct probe no longer dies on `keepalive`, but next failure moved to `response.image_generation_call.partial_image`. Local OpenAI SDK types under `node_modules/openai/resources/responses/responses.d.ts` confirm it is a standard Responses event; direct gate allowlist must include this image partial frame too.
- Full protocol closeout rule for this owner: stop patching one event at a time. Diff `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS` against local OpenAI SDK `responses.d.ts` and admit the full standard `response.*` event set (`audio.*`, `code_interpreter_call.*`, `code_interpreter_call_code.*`, `file_search_call.*`, `mcp_call_arguments.*`, `output_text.annotation.added`, `queued`, `incomplete`); keep transport-only `keepalive` as drop-only and keep non-standard provider events fail-fast.

2026-06-12 reasonix chat usage cache 0% investigation
- Symptom confirmed from user evidence: Reasonix chat-entry cache badge reads the latest usage event, not session average; it expects camelCase `cacheHitTokens/cacheMissTokens` on the client-visible `usage` payload.
- RouteCodex current chat response projection owner is `src/server/handlers/handler-response-utils.ts::resolveNormalizedChatUsage/normalizeChatUsagePayload`.
- Root-cause candidate confirmed in code: chat response normalization currently backfills only `input_tokens/output_tokens/prompt_tokens/completion_tokens/total_tokens`; it does not project internal normalized cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) into client-visible camelCase cache fields.
- Additional evidence: `maybeUpdateUsageLogInfoFromSseFrame()` stores normalized internal snake_case usage into `usageLogInfo.usage`, and non-stream JSON response path later reuses that shape directly unless chat normalization rewrites it.
- Minimal fix direction: extend chat usage normalization to expose Reasonix-compatible cache aliases from normalized usage (`cacheHitTokens`, derived `cacheMissTokens`), plus keep existing snake_case aliases unchanged.

2026-06-12 direct Responses SSE live revalidation after terminal-probe repair
- Global install/restart truth: current runtime on 5520/5555 is `0.90.3058`; `routecodex --version`, `rcc --version`, and both `/health` endpoints all report `0.90.3058`.
- Positive live probe on 5520: explicit function-tool `/v1/responses` request forced `exec_command`; stream emitted `response.function_call_arguments.done -> response.output_item.done -> response.completed -> response.done` with HTTP 200. This confirms the Rust `shared_responses_response_utils.rs` probe repair now synthesizes terminal frames correctly instead of surfacing `upstream_stream_incomplete`.
- Negative/live boundary probe on 5520: an image-generation stream left upstream status `in_progress` and only emitted `response.image_generation_call.partial_image`; after the client-side 30s probe timeout, server logged `response.sse.client_close` with `lastRawFrame=response.image_generation_call.partial_image` and no `upstream_stream_incomplete`. This locks the distinction between client timeout/disconnect and server-side terminal synthesis failure.
- Continuation live probe on 5520: replaying `previous_response_id + function_call_output` for the above tool call returned HTTP 200 with `response.completed` and `response.done`, and did not reproduce `orphan_tool_result`.
- Reusable live verification method for Responses SSE regressions: always run the pair `function tool first turn` + `function_call_output continuation turn`; do not rely on plain text probes, because they can drift into image generation and fail to exercise the tool terminal/continuation chain.

2026-06-12 responses continuation history-image lifecycle
- Root cause confirmed: request-side outbound stripping already existed, but success-path stored continuation history was still carrying historical `input_image` / media-bearing `function_call_output` into `releasedInputPrefix`. This violated Jason's rule: send/retry must keep full image+metadata until success, but stored history after success must be image-scrubbed.
- Unique repair point: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::releaseRequestPayload()` now calls a new Rust-exported native helper `stripResponsesStoredContextInputMediaJson` before persisting `releasedInputPrefix`; capture/request-inflight state remains untouched before release.
- Rust owner reused, not reimplemented: export wired from `router-hotpath-napi/src/lib.rs` to existing `chat_process_media_semantics::strip_responses_stored_context_input_media`, then bridged through `native-shared-conversion-semantics-responses.ts` and `responses-conversation-store-native.ts`.
- Positive/negative verification:
  - Rust gate PASS: `cargo test -p router-hotpath-napi shared_responses_conversation_prepare_and_resume_json --lib -- --nocapture`
  - llmswitch-core tsc PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
  - Focused Jest PASS with runtime native rebuilt: three targeted tests in `tests/sharedmodule/responses-continuation-store.spec.ts` proved `pre-release keeps raw image`, `post-release scrubs stored history`, and `released materialize still reconstructs full sanitized history`.
  - Runtime probe PASS from built module `dist/conversion/shared/responses-conversation-store.js`: before release payload still contained `LIVE_HISTORY` and no placeholder; after release payload no longer contained raw image and emitted `[Image omitted]` in stored historical turn.

2026-06-12 responses direct SSE finish_reason unknown audit
- Live sample `openai-responses-router-gpt-5.4-20260612T194202559-339122-1035` on 5520 reproduced `session-request/usage finish_reason=unknown` with no matching `completed` line and no `response.sse.stream.error/client_close` line.
- Unique leak candidate confirmed in `src/server/handlers/handler-response-utils.ts`: terminal auto-close path `writeTerminalProbeFramesAndClose()` can end the HTTP response via `res.end()` without `logStreamRequestCompleteOnce()` / `recordSseStreamEnd()`, leaving cleanup to emit usage with stale or missing finishReason.
- Rust semantic gap also confirmed in `chat_node_result_semantics.rs`: Responses `output.type=custom_tool_call` is not currently classified as `tool_calls`, so auto-close paths that rely on probe-only finish derivation can fall to `unknown`.
- Repair applied:
  - `handler-response-utils.ts` auto-close now resolves finishReason from probe, records `recordSseStreamEnd`, and emits normal `completed` request log before `res.end()`.
  - `chat_node_result_semantics.rs` now treats `custom_tool_call` as `tool_calls`.
- Verification:
  - Jest PASS: `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` (covers positive auto-close completion logging and negative no-early-close path).
  - Rust PASS: `cargo test -p router-hotpath-napi derives_finish_reason_tool_calls_in_rust --lib -- --nocapture`.
  - TS PASS: root `npx tsc --noEmit --pretty false`; llmswitch-core `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`.
  - Live runtime PASS after global install/restart to `0.90.3059`: 5520 `/v1/responses` tool-stream request `openai-responses-router-gpt-5.5-20260612T201950258-339179-1092` emitted `response.completed` + `response.done`, and server log recorded `completed (finish_reason=tool_calls)` plus `session-request/usage finish_reason=tool_calls`.

2026-06-12 finish_reason live recheck after 0.90.3059
- Fresh runtime truth: `curl http://127.0.0.1:{5520,5555,10000}/health` all returned `ready=true`, `pipelineReady=true`, version `0.90.3059`.
- Fresh client-side SSE probe on 5520: function-tool `/v1/responses` request with prompt `finish_reason_probe_5520` returned HTTP 200 and emitted the standard chain `response.created -> response.in_progress -> response.output_item.added -> response.function_call_arguments.delta/done -> response.output_item.done -> response.completed -> response.done`.
- Fresh server-side truth on current runtime: latest 5520 and 10000 log lines around 20:25-20:27 show repeated `completed (finish_reason=tool_calls)` plus matching `session-request/usage finish_reason=tool_calls`; no new `finish_reason=unknown` sample appeared during this recheck window.

2026-06-12 5520 direct tool-call silent-stop audit
- User sample `openai-responses-router-gpt-5.4-20260612T203357639-339278-1191` proved remaining gap is not generic SSE hang: server logged `completed finish_reason=tool_calls`, but no continuation request followed, and no `client_close` / `upstream_stream_incomplete` appeared around the request.
- Snapshot evidence: `~/.rcc/codex-samples/openai-responses/port-5520/req_1781267637639_72e027b1/` contained only provider request/response metadata; no raw direct SSE event sample existed, so prior evidence was insufficient to tell whether upstream emitted `response.required_action`.
- Root-cause direction tightened:
  1. direct `sendPipelineResponse()` only auto-closes tool continuations when the terminal probe path runs;
  2. Rust terminal-frame builder only synthesized `response.completed/done` from `output.function_call` probe, but did not synthesize `required_action` payload when probe lacked explicit `required_action`;
  3. TS close scheduling must stay gated by actual terminal/close window, otherwise `response.output_item.done(function_call)` can cause premature close before real terminal events.
- Repair applied:
  1. Rust `shared_responses_response_utils.rs` now synthesizes `required_action.submit_tool_outputs.tool_calls` from `output[].type=function_call` when explicit `required_action` is absent, and marks synthesized response status as `requires_action`.
  2. TS `handler-response-utils.ts` keeps terminal probe close scheduling only on terminal/auto-close path, not immediately on any tool-call probe, avoiding early close regression.
  3. Test expectation aligned with current client-visible Responses contract: client sees `response.output_item.added/function_call_arguments/output_item.done -> response.completed -> response.done`, not raw `response.required_action`.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi terminal_frames_synthesize_required_action_from_output_function_calls --lib -- --nocapture`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx jest tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`
- Next required evidence: rebuild/install/restart current runtime, then re-run 5520 live tool-call probe and check whether direct tool turn now deterministically emits client-visible tool frames plus continuation stop turn.

2026-06-12 current-runtime multi-turn responses proof
- Controlled `/v1/responses` two-turn function-tool conversation on 5520 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: response `resp_0b30648bdc1ed361016a2bfc389b6c8191825900ad5673e0ba` returned `output=[function_call ping_tool]`.
- Turn 1 server log truth: request `openai-responses-router-gpt-5.4-20260612T203146306-339260-1173` completed with `finish_reason=tool_calls`, and matching `session-request` / `usage` also recorded `finish_reason=tool_calls`.
- Turn 2 client JSON truth: continuation with `previous_response_id + function_call_output` returned `output=[message "Done."]`.
- Turn 2 server log truth: request `openai-responses-router-gpt-5.4-20260612T203154811-339262-1175` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 current-runtime stopless live loop proof
- Controlled relay `/v1/responses` stopless probe on 10000 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: plain request without client tools returned `status=requires_action`, `output=[reasoning,function_call]`, projected tool `exec_command`, command `routecodex servertool run stop_message_auto --input-json '{"flowId":"stop_message_flow","maxRepeats":3,"repeatCount":1}'`.
- Server log truth for turn 1: request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203340435-339276-1189` logged `[servertool] ... result=trigger_stop_schema_missing ... used=0 left=3`, then completed with `finish_reason=tool_calls`.
- Real tool execution truth: local `routecodex servertool run stop_message_auto ...` was executed for repeat counts 1, 2, and 3; each stdout JSON was submitted back as normal `function_call_output`.
- Continuation loop truth: turns 2 and 3 again returned `requires_action + exec_command`; server logs `...1194` and `...1195` continued as `finish_reason=tool_calls`.

2026-06-13 zterm apply_patch patch-failure shape audit + request-side repair
- Jason clarified the current slice boundary: focus on `apply_patch`-related patch-failure compatibility first, under the rule "only normalize shape, do not change semantics".
- Real failing shape classes confirmed from zterm/diag samples:
  1. repeated replay blocks where the same `call_id` replays identical `function_call` plus identical `function_call_output`;
  2. zterm transport wrapper noise around tool outputs (`Chunk ID`, `Wall time`, `Original token count`, `Process exited with code`, `Output:`), which makes semantically identical outputs look different;
  3. repeated `apply_patch` terminal status carryover, especially `APPLY_PATCH_ERROR` / `apply_patch verification failed` lines echoed into later turns.
- Unique owner confirmed: request-side Responses input normalization in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`. No second bridge or TS duplicate owner was introduced.
- Repair applied in Rust request normalization only:
  1. duplicate `function_call` entries now dedupe by semantic signature (`tool name + canonicalized arguments`) instead of raw occurrence only;
  2. tool outputs are compare-normalized after zterm transcript wrapper unwrapping, so wrapper-only duplicates collapse;
  3. `apply_patch` outputs reuse `normalize_apply_patch_output_text` for compare-only canonicalization, so repeated failure/result status carryover dedupes without mutating stored visible output.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture` -> 13 passed
  - `cargo test -p router-hotpath-napi responses_standardization --lib -- --nocapture` -> 8 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` -> native/core build passed
  - Native replay on real error sample `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` with wrapped `{ payload, normalized }` input now passes `coerceStandardizedRequestFromPayloadWithNative`, returning `messages=33`, `tools=16` instead of failing request standardization.
- Next required evidence: global install/restart current runtime, then rerun a live/runtime probe to confirm the built server process picks up the request-shape fix.

2026-06-13 real-sample red-test + workflow closeout
- Jason required the workflow to be fixed as a general rule: every new feature or bugfix must go `red test first -> fix -> green -> live replay old sample`, otherwise the change is not closed.
- Added curated real-sample fixture gate under `tests/fixtures/errorsamples/responses-request-standardization/`:
  1. `2026-06-13-duplicate-replay-wrapper-noise/` keeps the real diag request body from `error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`;
  2. `2026-06-07-apply-patch-error-carryover-curated/` keeps a curated real-sample payload extracted from `error-openai-responses-router-gpt-5.5-20260607T022906302-288146-11057.json`, locking `apply_patch verification failed` carryover plus zterm wrapper coexistence.
- Added formal red regression `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` that replays both fixtures through `coerceStandardizedRequestFromPayloadWithNative`.
- Fixture gate PASS: `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
- Online replay PASS on current `0.90.3064` runtime:
  - `2026-06-13-duplicate-replay-wrapper-noise` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
  - `2026-06-07-apply-patch-error-carryover-curated` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
- Process rule was written into project `AGENTS.md`, `docs/agent-routing/20-build-test-release-routing.md`, and `.agents/skills/rcc-dev-skills/SKILL.md`.

2026-06-12 request/response/usage concise log cleanup
- User target: standard `virtual-router-hit -> completed -> session-request -> usage` logs should be shorter, keep request id / request-response pairing / core usage / single finish_reason signal, and avoid repeated finish_reason clutter.
- Unique owner direction: only log presentation files are in scope: `src/server/handlers/handler-utils.ts`, `src/server/handlers/handler-response-utils.ts`, `src/server/runtime/http-server/executor/usage-logger.ts`, `src/server/utils/request-log-color.ts`, plus existing log-color/usage tests. No Hub/VR/provider payload or routing semantics change.
- Color rule: normal request/response lines must share one non-red/non-white/non-gray session color with numeric values highlighted white; error request/response lines are red. Existing session palette already excludes red/white/gray; fallback gray must not be used for normal HTTP request logs.
- Final stop truth: turn 4 returned `status=completed` with final assistant message summary; server log request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203429599-339283-1196` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 5520 XL direct responses html-shell root cause
- Live failing samples `openai-responses-router-gpt-5.4-20260612T215430477-339436-1349`, `...1350`, `...1351` are not pure SSE terminal-repair failures. Snapshot truth shows `XL.key1.gpt-5.4` direct `/v1/responses` upstream returned `: keepalive`, `event: ping`, then an HTML shell page (`<!doctype html> ... <title>New API</title>`), not valid Responses SSE.
- Evidence:
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781272470477_7f6ec698/provider-response.json`
  - `~/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-router-gpt-5.4-20260612T215430477-339436-1349/client-response_server.json`
  - `.../client-response.error_server.json` shows `probe: {}` and `upstream_stream_incomplete`
- Conclusion: current same-protocol direct gate is too weak for `openai-responses`; protocol-name match alone is insufficient. Need a direct capability/support gate before entering router-direct for Responses, so HTML-shell providers like `XL.key1.gpt-5.4 -> https://yunpansou.cn/responses` are blocked from direct and forced to relay or excluded earlier.

2026-06-12 XL runtime config truth corrected
- Jason provided the intended direct profile truth for XL: `base_url=https://yunpansou.cn/v1`, `wire_api=responses`, OpenAI auth, no CRS compat layer.
- Local runtime source of truth was inconsistent: `~/.rcc/provider/XL/config.v2.toml` still had `baseURL=https://yunpansou.cn` and `compatibilityProfile=responses:crs`.
- Action taken: removed `compatibilityProfile` from the live runtime provider config and rewrote `baseURL` to `https://yunpansou.cn/v1`.
- Next verification required: restart/reload runtime and recheck whether direct `/v1/responses` still emits HTML/ping shell or now returns valid Responses frames from `/v1/responses`.

2026-06-12 router-direct failure sample capture + concise logs
- Investigating direct failure hooks in http-server/index.ts; canonical snapshot owner is src/providers/core/utils/snapshot-writer.ts.
- Current log slice still has test gaps: request-complete spy target, usage finish_reason single-occurrence, request-log-color ESM import owner.

2026-06-12 XL label mismatch
- provider-request/provider-response/__runtime all show providerKey=XL.key1.gpt-5.4 and URL=https://yunpansou.cn/v1/responses.
- server log usage/session-request still prints XL.key1.gpt-5.4.gpt-5.5, so current residual issue is provider label/model decoration, not outbound target/baseURL.
- Unique owner likely buildProviderLabel/log usage path; direct transport truth already matches /v1 and gpt-5.4.

2026-06-12 XL provider label owner fixed
- Root cause: resolveProviderRequestContext preferred clientModelId when payload lacked model, so usage/session logs combined providerKey XL.key1.gpt-5.4 with client/default model gpt-5.5 into false label XL.key1.gpt-5.4.gpt-5.5.
- Fix: prefer mergedMetadata.target.modelId over clientModelId for providerModel derivation in provider-request-context.
- Gate: added red regression asserting XL.key1.gpt-5.4 + target.modelId=gpt-5.4 + clientModelId=gpt-5.5 resolves to providerLabel XL.key1.gpt-5.4.

2026-06-12 5520 orphan_tool_result live sample
- User sample: 22:28:37 tools route -> XL.key1.gpt-5.4-mini failed with orphan_tool_result unknown or already-consumed call_id.
- Next action: inspect matching codex-samples request/client/provider snapshots and locate single owner for tool_result call_id consumption/normalization.

## 2026-06-12 5520 orphan_tool_result + direct label residual

2026-06-13 responses same-response continuation / orphan_tool_result audit
- 用户新证据确认：新 session 也会 400，不是旧历史污染；样本为 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id`。
- 先做真实两步回放复现：第一轮 `/v1/responses` 返回 `function_call`；第二轮带 `previous_response_id + function_call_output`。当前运行时在第二轮先报 `Responses conversation expired or not found`，说明问题先落在 continuation store 持久化/恢复，而不是客户端会话。
- 真因已定位到唯一 owner：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`。`captureRequestContext()` 因 `store:false` 把 `allowContinuation=false`，后续 `recordResponse()` 即便看到 pending tool calls 也没有把 `allowContinuation` 打开，导致同一 response 的 tool continuation 不能恢复。
- 已改 contract：`store:false` 仍允许 same-response tool continuation；仍不允许 scope continuation/materialize。对应回归已改在 `tests/sharedmodule/responses-continuation-store.spec.ts`。
- focused gate 已绿：`tests/sharedmodule/responses-continuation-store.spec.ts` 22/22 PASS。下一步必须 build/global-install/restart 后重跑真实两步回放，确认 live runtime 不再 400。
- Live error sample: openai-responses-router-gpt-5.4-20260612T222837601-339482-1395 failed with orphan_tool_result for call_JYbsLnCRByKN0SjpmyWDiFHY.
- Evidence shows same call_id already existed in earlier provider-request snapshots 339477-1390 and 339478-1391, so current root-cause direction is continuation/history pollution, not provider generating a fresh bad call id.
- Residual 5520 direct usage/session provider label still shows XL.key1.gpt-5.4.gpt-5.5 / XL.key1.gpt-5.4-mini.gpt-5.5 after one owner was fixed; there is still a second owner/path.

- 2026-06-12 fix slice: Rust standardized_request now drops stale responses tool_result items when a new function_call turn arrives, while keeping only outputs matching current pending call ids. Added paired tests for stale-drop and non-stale retention boundary.
- 2026-06-12 fix slice: direct usageLogInfo model source now prefers provider wire/response model instead of client request model, preventing labels like XL.key1.gpt-5.4.gpt-5.5 in direct logs.
- Verification: cargo test -p router-hotpath-napi standardized_request --lib -- --nocapture PASS; jest tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts PASS; root tsc PASS.

2026-06-12 continue: preparing live replay from old 5520 orphan_tool_result sample 339478/1391 against runtime 0.90.3059 to verify stale tool_result is dropped before bridge validation.

2026-06-12 replay result: old orphan_tool_result 339477/339478 bodies replayed against 5520 runtime 0.90.3059 no longer fail at bridge/orphan; both progressed to upstream HTTP_403 auth failure on asxs.crsa.gpt-5.4-mini. This is live evidence stale tool_result pollution is removed before provider send.

2026-06-12 live log check after 0.90.3059 restart: no new orphan_tool_result found in post-restart 5520 window; replayed requests 339522/339523 failed only at upstream HTTP_403. Next evidence path is successful direct log label on current runtime.

2026-06-12 correction: old-sample replay was insufficient. New live session openai-responses-router-gpt-5.4-20260612T225507928-339537-1450 still fails orphan_tool_result on fresh call_MqPgTUSSFb19Em58JUUEd6xV, so root cause remains in live-session request shaping/continuation path. Must inspect fresh sample, not infer from historical replay.

2026-06-12 gate update: added paired regression tests for materialized responses continuation pending tool-call replay duplication in tests/sharedmodule/responses-continuation-store.spec.ts; using repo jest:run path because plain npx jest cannot load llmswitch-core ESM native bridge.

2026-06-12 note: source tests for responses continuation materialize require rebuilding native hotpath after Rust changes; otherwise tsx/jest still call stale router_hotpath_napi.node and can falsely stay red/null.

2026-06-12 previous_response_id lifecycle + miss policy audit
- External truth (official/OpenAI + local codex audit):
  - Responses `previous_response_id` depends on a stored prior response object. Official guidance indicates stored response/application state is retained for up to 30 days when `store=true`; `store=false` / ZDR paths do not guarantee later resume lookup.
  - Official miss guidance for websocket/incremental flows: if cached previous response context is unavailable, send a fresh create with `previous_response_id=null` and the full input/context; do not try to continue from partial delta.
  - Local codex source truth:
    - `rollout-trace/src/reducer/conversation.rs` explicitly errors on unknown previous id: `unknown previous_response_id ...`.
    - `core/src/client.rs` only sends `previous_response_id` when the new request is an exact prefix continuation; otherwise it sends a full create without `previous_response_id`.
    - `core/tests/suite/client_websockets.rs` locks that behavior: prefix match => use `previous_response_id`; non-prefix or post-error => full create without `previous_response_id`.
- RouteCodex current local truth:
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` already has a local TTL cache, currently `TTL_MS = 30min`; this is a local continuation cache, not upstream retention truth.
  - `resumeConversation()` already fail-fast returns `expired_or_unknown_response_id` when the local store misses.
  - The dangerous gap is scope materialization/reconstruction after release: if local scope miss or malformed replay is treated as resumable delta, later bridge validation can surface `orphan_tool_result`.
- Required closeout direction:
  - Scope-based continuation miss must never fabricate partial delta. If full input is available and prefix match fails, create a fresh full request without `previous_response_id`; if request is submit-tool-outputs/partial-delta only, fail-fast with explicit expired/unknown continuation error.
  - `orphan_tool_result` must become impossible from store miss/TTL expiry; store miss should stop at continuation owner/store boundary, not later at bridge tool_result validation.
2026-06-12 singleton empty-pool blocking retry progress
- root cause confirmed: hub pool exhaustion on singleton/default-only pools previously allowed terminal no-provider after bounded backoff; this violates Jason rule that empty pool must not be terminal.
- executor change: request-executor now detects singleton/last-candidate pool exhaustion from VR details (candidateProviderCount=1 / initialRoutePool len=1 / explicitSingletonPool) and enters provider.route_pool_cooldown_wait, clears exclusions, then reruns route selection instead of terminal no-provider.
- additional fix: chat success path no longer loads responses conversation rebind or native empty-assistant semantics when normal chat body already contains visible assistant payload; otherwise singleton blackbox was falsely failing after successful provider response.
- verification green so far: focused helper spec + chat handler singleton blackbox + root tsc.

2026-06-12 /v1/responses handler bridge surface audit
- Current duplicated bridge surface was confirmed at both handler ends:
  - request side `src/server/handlers/responses-handler.ts` directly imported entry planning/resume/materialize/capture/record/clear helpers from `bridge.js`
  - response side `src/server/handlers/handler-response-utils.ts` directly imported SSE probe/projection/conversation lifecycle helpers plus core-dist loaders from `bridge.js`
- Convergence direction fixed:
  - request side unique owner facade: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - response side unique owner facade: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- New architecture gate truth: `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` must fail if handler files re-import responses bridge primitives from `bridge.js` instead of the side-specific facade.
- Function/verification map truth split from coarse `server.responses_handler_family` into two dedicated features:
  - `server.responses_request_handler_bridge_surface`
  - `server.responses_response_handler_bridge_surface`

- 2026-06-12 router-direct finish_reason=unknown 排查：usage/session rollup 只吃 direct result usageLogInfo.finishReason；direct 路径此前仅用 deriveFinishReasonNative，对无显式 finish_reason 但已有可见 assistant 成功内容的 chat-like/direct 响应会落 unknown。计划把成功可见响应推断统一收口到 finish-reason util，并补 direct 红测锁定。

- 2026-06-13 stopless 未触发排查：10000 端口 stopMessageEnabled 默认 true，request-executor/provider-response-converter 也会把 servertool 能力传入；当前怀疑点收敛到 Rust bridge 后的 response payload 形态或 stopGatewayContext 覆盖，导致 isStopEligibleForServerTool=false，需补 /v1/responses stop blackbox 锁定。
2026-06-13 stopless direct root cause
 - 10000 port default sameProtocolBehavior=direct and default stopMessageExcludeDirect=true. This bypasses response conversion/orchestration for same-protocol /v1/responses.
 - Fix direction: when port stopMessage.includeDirect=true, same-protocol direct must relay instead of bypassing stopless; added Rust direct-decision red/green and HTTP blackbox; updated ~/.rcc/config.toml port 10000 stopMessage={ enabled=true, includeDirect=true }.

## 2026-06-13 stopless live verify blocked by startup export drift
- install/global 0.90.3059 completed, but 10000 runtime cannot be reloaded yet.
- current live blocker: startup error `./index.js does not provide an export named captureResponsesRequestContextForRequest`.
- next action: inspect bridge facade/export owner and fix startup regression before live stopless probe.

- 2026-06-13 current blocker narrowed: previous install likely packed stale dist; rebuilt local dist now shows corrected runtime-integrations import in responses-request-bridge.js. Re-running isolated install-global before live port 10000 restart.

- 2026-06-13 continue after live proof: next gap is test proof for new stopless/direct blackbox; attempt repo jest path first.

- 2026-06-13 verification update: provider-response-rust-plan.spec.ts PASS (17/17); live 10000 stopless probe PASS; router-direct-passthrough.blackbox.spec.ts still hangs in current repo jest environment, so not claimed green.

- 2026-06-13 blackbox fix: router-direct-passthrough.blackbox used forbidden client metadata.routeHint; moved route hint to x-route-hint header to match current req_adapter contract before rerun.
2026-06-13 stopless blackbox status
- Direct live 10000 proof already green.
- HTTP blackbox current blocker is Jest execution mode, not stopless assertion: plain ./node_modules/.bin/jest fails immediately on ESM/import.meta in src/server/runtime/http-server/index.ts.
- Need to verify same case under node --experimental-vm-modules jest runner; npm run jest:run appears silent/hanging so testing runner behavior separately.
- HTTP blackbox stopless case under correct VM-modules runner now produces a real red result, not a hang.
- Current red shape: request still ends as 502 with [llmswitch-bridge] native-failure-policy not available after direct path failure; this mixes stopless relay verification with missing native bridge capability in source-test env.
- Evidence: node --experimental-vm-modules jest run at 2026-06-13 08:27 shows virtual-router-hit -> direct provider request id -> SSE_TO_JSON_ERROR -> native-failure-policy not available.

2026-06-13 orphan_tool_result duplicate-history closeout in progress
- New live failing request `openai-responses-provider-20260613T091618631-339813-1726` is a fresh-session failure, not old expired continuation state.
- Diag truth: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` contains identical `function_call` + `function_call_output` blocks replayed twice in one inbound `input[]`.
- Bridge fail-fast is correct: second identical tool_result for same call_id is rejected as `already-consumed`; fix must happen before bridge conversion.
- Repair owner selected: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`.
- Boundary locked in code/tests: dedupe only exact duplicate tool-history entries before orphan filtering; distinct repeated outputs for the same call_id remain invalid and must still error.
2026-06-13 10000 backup minimax m3
- User request: add MiniMax M3 as backup in 10000 port config.
- Source of truth: ~/.rcc/config.toml, routingPolicyGroup gateway_coding_10000.
- Existing state: fwd.minimax.MiniMax-M3 already defined globally; 10000 only uses it in multimodal, not in coding/thinking/tools/search/web_search/longcontext/vision/default.
- Planned minimal change: append fwd.minimax.MiniMax-M3 as secondary target for 10000 route entries, preserve current primary order.
2026-06-13 zterm patch-failure shape audit
- Evidence set for current audit:
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260612T225434051-339532-1445/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781280510486_c4745c3f/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781315630127_4eebb92b/provider-request.json`
- Confirmed shape classes:
  1. duplicated replay block: same `call_id` reappears with repeated `function_call` + repeated `function_call_output`; representative `...339532-1445/provider-request.json`
  2. transport wrapper noise: `function_call_output.output` may be wrapped by `Chunk ID` / `Wall time` / `Original token count` / `Process exited with code` / `Output:`; representative `...339528-1441/provider-request.json`
  3. repeated apply_patch status carryover: many later requests still carry historical `APPLY_PATCH_ERROR: apply_patch did not apply...` or `Success. Updated the following files:` outputs with same call ids across turns; representative `req_1781280510486_c4745c3f/provider-request.json` and `req_1781315630127_4eebb92b/provider-request.json`
- Existing Rust request normalization already does:
  - duplicate call-id rewrite by occurrence
  - exact payload-signature dedup for repeated tool outputs
  - orphan tool output filtering
- Current gap:
  - duplicate replay with same semantic call/result is rewritten, not collapsed
  - payload-signature dedup happens before stripping zterm wrapper noise, so wrapper-only differences evade dedup
  - historical apply_patch terminal statuses can accumulate as repeated tool history across turns
- Intended repair direction for approval:
  - unique owner stays request-side Rust normalization before bridge/tool-result validation
  - only shape normalization, no patch/body semantic rewrite
  - collapse replayed identical tool history by semantic identity after output-wrapper canonicalization
  - keep true conflicts fail-fast

2026-06-13 stopless schema guidance tighten
- User reports: stopless can still spend 3 consecutive turns without calling tool. Need stronger guidance across these 3 hops, schema-guided, and next inspection must also check schema.
- Must inspect Rust/TS owner for stop_message_auto CLI projection seed + schema gate + next-turn inspection path before editing.

2026-06-13 build install restart after stopless guidance tighten
- User requested: compile, global install, restart server after Rust prompt tightening.
- Need runtime evidence after install: versions + health on 5520/5555/10000.

2026-06-13 ignore generated dirs for repo-sanity
- User confirmed bin/lib generated; add bin/ lib/ .reasonix/ to .gitignore and rerun repo-sanity.

2026-06-13 stopless prompts md-source migration
- Move stopless default prompt text from Rust hardcode to source asset under code tree, build copy to dist, runtime read from dist.
- Must keep single owner and add tests for round1/2/3 + schema mention + next-check mention.
2026-06-13 stopless schema closed-loop
- Added Rust red tests for guidance-before-gate, missing-schema-no-count, and missing-schema-reissues-guidance.
- stop_message_cli_projection_seed now injects stopless_schema_guidance into continuationPrompt and appends next-round schema-check hint.
- Rust evidence: targeted cargo tests passed for cli seed + stop-message persist/gate contract.
2026-06-13 function-map audit start: scanning architecture docs, registry, gates, gaps, and risk surfaces.
2026-06-13 plan requested: create actionable function-map audit remediation plan + audit current state against plan.
2026-06-13 new sample audit: process drift, not runtime bug
- Evidence from screenshot: agent wrote `plan requested: create actionable function-map audit remediation plan + audit current state against plan`, then read `docs/agent-routing/10-runtime-ssot-routing.md` and `docs/goals/function-map-longtail-closeout.md`, then stated `计划落盘后，做审计：现状 vs 计划`.
- Conclusion: execution drifted from the active `apply_patch` real-sample workflow into a separate function-map audit branch.
- Correct branch for this slice stays fixed: red test first -> shape-only repair -> green -> live replay old/new samples. No function-map audit work should interleave until this slice is closed.

- 2026-06-13 stopless 闭环继续收口：Rust `stop-message-core` 已改为 stop schema 缺项枚举、finished/blocked 补齐即停、continue_needed 缺 next_step 强制补齐；三轮只作为 no_change loop guard，不再按普通 used 计数封顶。
- 2026-06-13 stopless continuation guidance 已由 `servertool-core::cli_contract` 强制前缀注入 stop schema guidance，并要求下一轮先检查 schema，再决定是否继续工具调用。
- 2026-06-13 Rust gate 证据：`stop-message-core` 51/51、`servertool-core` 252/252。下一步：全局安装、重启 5555/5520/10000、在线验证 stopless 行为。
- 2026-06-13 apply_patch live probe:
  - `/v1/responses` without explicit `tools` only produced plain text (`I’m unable to directly use apply_patch from here`); this probe is not sufficient to prove server tool path failure because the request itself did not declare `apply_patch`.
  - `/v1/responses` with explicit `tools=[{type:function,name:apply_patch,...}]` and `tool_choice=required` on `127.0.0.1:5555` returned a valid `function_call`:
    - `name=apply_patch`
    - `arguments={"patch":"*** Begin Patch\n*** Add File: tmp/apply_patch_smoke.txt\n+hello from smoke\n*** End Patch"}`
  - Conclusion: apply_patch tool path is alive at the HTTP server/runtime level; current screenshot failure is more likely request-shape/tool-declaration loss on the real Codex/client path, not intrinsic inability of the server to emit apply_patch tool calls.
- 2026-06-13 server function-map boundary closeout:
  - Existing function-map entries for `server.responses_handler_family`, `server.responses_request_handler_bridge_surface`, and `server.responses_response_handler_bridge_surface` were stale: they still described server-side protocol projection/bridge semantics too loosely.
  - Updated function-map + verification-map to state the intended boundary explicitly:
    - server handlers are HTTP transport adapters only
    - request bridge is opaque request facade only
    - response bridge is opaque SSE/body handoff facade only
    - protocol parsing/conversion/projection must stay in Hub Pipeline/native owner
  - Added gate `scripts/architecture/verify-server-function-map-boundary.mjs`, wired into `package.json` and `verify:architecture-ci`.
  - Verified:
    - `npm run verify:server-function-map-boundary` PASS
    - `npm run verify:function-map-compile-gate` PASS
  - Current root-trace lead for chat-shaped tool leakage:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
    - `normalize_chat_envelope_tool_calls(...)`
    - `normalize_tool_definition(...)`
    - this is the current strongest candidate for where `tools[].function.*` is being canonicalized into chat-shaped tool definitions before later direct misuse.

- 2026-06-13 stopless 闭环最终推进：修复误用 `npx jest` 的测试入口，改用 `npm run jest:run`（node --experimental-vm-modules）后，`tests/servertool/stop-message-auto.spec.ts` 51/51 通过（8 skipped），`tests/servertool/stop-message-compare-context.spec.ts` 6/6 通过。
- 2026-06-13 handler 薄壳新增 no-change glue：`stop-message-auto.ts` 计算 observationHash/toolSignatureHash，并基于上一轮 compare context 的 observationHash/observationStableCount 生成 `schemaGate.no_change_count`，把“三轮只作无变化 loop guard”真正闭到上游状态链。

2026-06-13 direct server-side request shaping removal in progress
- Removed server direct preflight payload contract/relay checks and direct model overrides from http-server/index.ts.
- direct-passthrough-payload.ts is now object-only guard; direct request body must pass through unchanged.
- Red tests updated toward new direct contract: no stream synthesis, no model overwrite, no tool/system/history rewrite.
- Deleted dead server shim: src/server/runtime/http-server/responses-direct-contract-error.ts (no remaining references after direct preflight removal).
- Moved Responses direct SSE protocol checks (allowlist/keepalive/required_action normalization entry) behind responses-response-bridge facade; server handler no longer owns those helpers.
- Added bridge-surface gate to forbid local server tokens for Responses SSE allowlist/keepalive/required_action parsing in handler-response-utils.ts.
- Moved Responses JSON required_action client-payload normalization behind responses-response-bridge facade; handler-response-utils no longer decides when to project body-level required_action.
- Trace note: direct server path does not call coerce_standardized_request_from_payload/normalize_tool_definition; current chat-shaped tool source remains Rust standardized owners, but direct contamination must come from another ingress/store/projection path.
- Moved Responses request-side stream/system-prompt mutation behind responses-request-bridge facade; responses-handler.ts no longer owns `payload.stream = true` or `applySystemPromptOverride(...)`.
- Added request-side bridge-surface gate to forbid local stream/system-prompt mutation tokens in responses-handler.ts.

## 2026-06-13 direct/server boundary cleanup
- Resumed from handoff: direct request-shaping already removed from server runtime; next focus is handler protocol surface shrink + continuation/store tool-shape contamination trace.
- Evidence from code: plan_responses_handler_entry() only decides mode (submit_tool_outputs/scope_materialize/none), not standardized_request coercion; current chat-shaped tools leak is likely later in store/materialize/projection, not entry planning.
- Next actions: audit handler-response-utils remaining Responses semantics, audit responses-handler remaining bridge-only mutations, add red test for continuation/store preserving direct tool schema.
- 2026-06-13: direct-owned scope continuation fixed at store owner: materializeLatestContinuationByScope now dispatches direct entries to remote restore; native restore skips tool reinjection for direct owner; wrapper now passes continuationOwner through to native and preserves released prefix as side-channel only for direct.
2026-06-13 function-map audit remediation plan added at docs/goals/function-map-audit-remediation-plan.md.
Confirmed current audit baseline: 28 feature entries in function-map, 28 in verification-map, responses request/response bridge surfaces already registered, but parser-clean map truth and explicit functional owner fields are still missing.
2026-06-13 function-map owner schema baseline landed. docs/architecture/function-map.yml now carries owner_kind + owner_scope across 62 features; docs/architecture/function-map.yml and docs/architecture/verification-map.yml are YAML-parseable again. Added scripts/architecture/verify-architecture-function-map-parseable.mjs and wired it into verify:function-map-compile-gate + verify:architecture-ci. Current owner_kind distribution: rust_ssot=29, ts_runtime_owner=15, server_projection=10, ts_bridge=4, provider_runtime=2, ts_entry_shell=2. Remaining audit gap: hidden-owner full-repo scan and warning cleanup for server.responses_request_handler_bridge_surface forbidden mention.

## 2026-06-13 responses handler bridge closeout slice
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` had a false isolation gap: it mocked the bridge barrel, but `handler-response-utils.ts` imports `responses-response-bridge.js` directly. That caused the test to load real native/store paths and report `CustomGC` open handles.
- Fixed test isolation by mocking `responses-response-bridge.(js|ts)` directly and providing the exact named exports used by the handler; `--detectOpenHandles` now exits cleanly.
- Further shrank server boundary: `handler-response-utils.ts` no longer derives continuation persistence `providerKey/continuationOwner/sessionId/conversationId/timingRequestIds` locally before calling `persistResponsesConversationLifecycleForHttp(...)`; that assembly now happens inside `responses-response-bridge.ts`.
- Further shrank server boundary again: local SSE terminal-state parser/state-machine update for `response.completed` / `response.done` was removed from `handler-response-utils.ts`; terminal-state inspection now lives behind `inspectResponsesTerminalStateFromSseChunkForHttp(...)` in `responses-response-bridge.ts`, and the single-bridge gate now forbids reviving `updateSseTerminalTrackerFromChunk(...)` in server TS.
- Request-side helper shrink continued: `responses-handler.ts` no longer owns local `readResponsesSessionId`, `readResponsesConversationId`, `shouldPersistResponsesConversation*`, or `readResponsesResponseId`; those helpers now live behind `responses-request-bridge.ts`, and the single-bridge gate forbids reviving them in server TS.
- Response-side logging helper shrink continued: `handler-response-utils.ts` no longer owns local SSE frame summary parsing or provider-protocol hint detection for usage/logging; those parsers now live behind `summarizeResponsesSseFrameForLogForHttp(...)` and `resolveResponsesProviderProtocolHintFromSseFrameForHttp(...)` in `responses-response-bridge.ts`.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler single-bridge closeout goal prompt
- Created implementation doc at `docs/goals/responses-handler-single-bridge-closeout-plan.md` so the next `/goal` can stay short while still pointing to one executable source of truth.

2026-06-13 responses handler bridge closeout slice 2
- Moved remaining server-side Responses force-SSE body classification (`response` vs `chat.completion`) behind `prepareResponsesJsonBodyForSseBridgeForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` no longer keeps local `isResponsesJsonBody` / `isChatCompletionJsonBody`.
- Moved probe-level continuation inspection behind `inspectResponsesContinuationProbeForHttp(...)`; server handler no longer owns local `tool_calls` / `required_action` probe inspection helpers.
- Single-bridge gate updated to forbid reviving those local helpers in `handler-response-utils.ts`.
- Focused test isolation closed: force-SSE suite now mocks `server/utils/finish-reason.js`, and `--detectOpenHandles` exits cleanly.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 3
- Request-side handler no longer keeps local `responseIdFromPath -> payload.response_id` prewrite, local `/v1/responses*` conversation-management branch checks, or local `responsesRequestContext` fallback assembly; moved into request bridge via `shouldManageResponsesConversationForHttp(...)`, `buildResponsesRequestContextForHttp(...)`, and `attachResponsesRequestContextToResultForHttp(...)`.
- Response-side client-close continuation policy no longer branches purely in server TS; moved behind response bridge via `planResponsesContinuationCloseActionForHttp(...)` and `shouldRepairResponsesContinuationTerminalForHttp(...)`.
- Single-bridge gate updated to forbid reviving request-side local `pipelineEntryEndpoint === '/v1/responses*'` checks and `responseIdFromPath` prewrite.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 4
- Response-side stream-end terminal repair / continuation repair / incomplete-error decision no longer branches purely in server TS; moved behind response bridge via `planResponsesStreamEndRepairForHttp(...)`.
- Handler still owns stream write / res.end / snapshot / logging / timers, but the Responses-specific decision of “need terminal repair?”, “need continuation repair?”, “need incomplete error projection?” is now bridge-owned.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 function-map audit check
- Current map baseline: 62 function-map features, 62 verification-map features.
- Gates green: `verify:function-map-compile-gate`, `verify:architecture-owner-queryability`, `verify:architecture-feature-map-growth-discipline`, `verify:architecture-provider-specific-leaks`, `verify:architecture-thin-wrapper-only`, `verify:architecture-error-chain-bypass`, `verify:architecture-metadata-leak-boundary`, `verify:architecture-nonadjacent-conversion`, `verify:architecture-forbidden-path-growth`.
- Residual loophole: `tool.apply_patch_freeform_contract` has no `src/sharedmodule` source anchor; only test/script anchors exist.
- Residual warning: `verify:function-map-boundary-mentions` warns on `server.responses_request_handler_bridge_surface` because `clearResponsesConversationByRequestIdForHttp` appears in a forbidden path.
- User rule to keep: server handlers must not own protocol parsing; protocol normalization/parsing stays in bridge/native owner layers.
2026-06-13 responses handler bridge closeout slice 5
- moved response-side client-close cleanup eligibility, terminal-event requirement gating, and probe finish_reason resolution behind responses-response-bridge helpers
- single-bridge gate PASS; root tsc PASS; focused jest PASS: required-action-split-frame, force-sse-json-responses, responses-continuation-store, direct-server-contract.red
2026-06-13 responses handler bridge closeout slice 6
- moved failure-to-clear continuation policy (`sse_stream_error` / `sse_incomplete` / `json*`) behind responses-response-bridge helpers; server now only executes clear action
- verify PASS: single-bridge gate, root tsc, focused jest x4 after reason-string removal from handler

2026-06-13 latest stopless sample audit
- Audit scope: latest `/Volumes/extension/.rcc` provider samples + 5555 session truth, specifically checking whether bad stop schema or missing schema guidance caused extra stopless calls.
- Verified negative evidence: latest MiniMax 5555 sample dirs (`req_1781338094550_ffce7713`, `req_1781337644140_d9709ce2`, `req_1781337206630_f91830d0`, `req_1781336510838_87340d58`) are not authoritative stopless samples. Their `__runtime.json` only contains request/provider metadata and does not contain `stopMessageState`, `serverToolLoopState`, `stopMessageCompareContext`, `observationStableCount`, `continuationPrompt`, or stop-schema fields.
- Verified old stopless session evidence: `/Volumes/extension/.rcc/sessions/127.0.0.1_5555/session-stopless-*.json` from 2026-06-09 do contain stopless persisted state, and their `stopMessageText` already includes explicit guidance like '立即调用工具执行这个下一步'. This disproves 'missing guidance' for those samples.
- Verified old-budget evidence: those old stopless sessions still show `stopMessageUsed` climbing to 3 while guidance still asks to continue, matching the historical bug '3 rounds treated as main budget' rather than proving a latest schema/guidance regression.
- Verified latest 5555 session truth: only recent touched files are `session-rcc-OneStop.json` and `tmux-rcc-OneStop.json`; they record `stopMessageLastUsedAt`/`stopMessageUpdatedAt` (and tmux token stats) but no stop schema/guidance/compare-context payload. So current latest session truth is insufficient to prove latest extra calls were caused by bad schema or missing guidance.
- Current audit conclusion: no direct evidence from latest samples that incorrect schema or missing schema guidance caused extra stopless calls; most latest samples inspected are not true stopless closure samples. Need a fresh live stopless probe to close the evidence gap if stronger proof is required.
2026-06-13 responses handler bridge closeout slice 7
- fixed request-side submit_tool_outputs red tests to mock the actual request-bridge submodule surface instead of the old barrel-only path; locked current contract that `routeHint` travels via `pipelineInput.metadata.responsesResume`, while capture store only receives request context plus optional providerKey pin
- request-side timeout/error clear path now goes through `clearResponsesConversationOnHandlerFailureForHttp(...)`; `responses-handler.ts` no longer calls request-store clear API directly in timeout/error branches
- verify PASS: `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 8
- added single-bridge gate for local Responses SSE error payload literals in `handler-response-utils.ts` and moved those payload builders into `responses-response-bridge.ts`: missing-stream `sse_bridge_error`, structured upstream SSE error projection, generic SSE error envelope builder, and `upstream_stream_incomplete`
- repaired response-side terminal finish_reason fallback in bridge owner: when probe has a completed assistant message but no explicit finish_reason, `resolveResponsesTerminalProbeFinishReasonForHttp(...)` now resolves `stop`
- test/mocks updated so handler-response-utils response-bridge submodule mocks expose the new SSE error builders
- verify PASS: `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`, `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 9
- moved catch-side malformed Responses tool-history contract errorsample capture behind `captureResponsesInboundToolHistoryErrorsampleForHttp(...)`; `responses-handler.ts` no longer classifies `Tool history contract violated`, reads `details.toolHistoryContractViolation`, or writes `responses.inbound_tool_history_contract` payloads locally
- added request-bridge red/green unit `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` to lock positive and negative cases at the bridge owner
- updated submit_tool_outputs handler mocks to expose the new request-bridge facade export so ESM import shape stays complete during handler blackbox tests
- verify PASS: `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses continuation isolation correction
- Root-cause correction: current 2013 / orphan tool-result issue is not just `deltaInput` misuse; it also exposes a scope-design gap. Responses continuation restore is currently isolated by `port/group + session/conversation`, with `continuationOwner` recorded on the entry, but `entry protocol/endpoint` is not part of the scope key.
- Consequence: a chat/messages entry can incorrectly hit a stored Responses continuation scope, then internal bridge code (`buildChatRequestFromResponses`) receives Responses-owned resume semantics on the wrong entry and reconstructs history there.
- New rule to implement: Responses continuation restore/materialize must require triple isolation `entry protocol(or endpoint) + continuationOwner(direct|relay) + session/conversation(+port/group)`. `buildChatRequestFromResponses` remains bridge-only protocol conversion and must not own scope/owner inference.
2026-06-13 responses continuation isolation implementation slice
- Store layer updated: continuation scope key is now `entry:<kind>|owner:<owner>|session|conversation`, `recordResponse()` preserves captured session/conversation scope instead of clearing it when response-side args omit them, and `resumeConversation()` now rejects entryKind/owner mismatch instead of restoring across protocol ownership.
- New red/green coverage added in `tests/sharedmodule/responses-continuation-store.spec.ts`: chat entryKind cannot hit stored responses continuation; direct+relay records under one scope return `null` until caller specifies owner.
- Handler-path audit follow-up: the submit_tool_outputs handler specs were not exposing a production bug; they were stale against the new single-bridge split. Fix was to stop replacing the whole request bridge and instead mock `runtime-integrations` / `native-exports` thinly while providing an explicit `responses-response-bridge` export surface for handler imports.
- Verification PASS: `PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--experimental-vm-modules pnpm jest tests/sharedmodule/responses-continuation-store.spec.ts tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts --runInBand`; `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`; `sh -lc 'git diff --check 2>&1'`.
2026-06-13 responses handler bridge closeout slice 10
- moved response-side SSE dispatch eligibility and `__sse_responses` payload-shape detection behind `hasResponsesSsePayloadForHttp(...)` and `shouldDispatchResponsesSseToClientForHttp(...)`; `handler-response-utils.ts` no longer owns local `hasSsePayload` implementation or local SSE dispatch decision logic
- kept compatibility export `hasSsePayload` in `handler-response-utils.ts` as a thin alias to the bridge owner so existing server imports continue to resolve without reviving local protocol logic
- updated response-bridge mocks in `handler-response-utils.force-sse-json-responses.spec.ts` and `handler-response-utils.required-action-split-frame.spec.ts` to expose the new facade exports
- verify PASS: `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 11
- physically split server-side SSE implementation out of `src/server/handlers/handler-response-utils.ts` into `src/server/handlers/handler-response-sse.ts`; shared non-protocol carrier/header/snapshot helpers now live in `src/server/handlers/handler-response-common.ts`
- `handler-response-utils.ts` is now dispatcher + JSON path only; it delegates all force-SSE bridge and live SSE stream handling to `sendSsePipelineResponse(...)` and keeps `hasSsePayload` / client-carrier guard as thin compatibility exports
- single-bridge gate tightened to require `handler-response-sse.ts` / `handler-response-common.ts` imports and forbid reintroducing SSE helper/state-machine tokens into `handler-response-utils.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 12
- removed the last direct Responses timeout SSE error-envelope write from `src/server/handlers/responses-handler.ts`; timeout-after-headers-sent now reuses generic `writeStartedSsePipelineError(...)` instead of locally shaping `event:error` payload
- single-bridge gate now forbids direct `res.write(\`event: error` in `responses-handler.ts`, so the server adapter cannot grow Responses-specific SSE error projection again
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/responses-handler.started-sse-error.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 13
- moved request-side post-pipeline lifecycle orchestration out of `responses-handler.ts`: request-context capture gating is now `captureResponsesPipelineRequestContextForHttp(...)`, and result metadata attach + tool-call continuation seeding are now `finalizeResponsesPipelineResultForHttp(...)`
- `responses-handler.ts` no longer directly calls `shouldManageResponsesConversationForHttp(...)`, `captureResponsesRequestContextForHttp(...)`, `attachResponsesRequestContextToResultForHttp(...)`, or `seedResponsesToolCallResponseForHttp(...)`; those lifecycle decisions now sit behind the request-bridge facade
- single-bridge gate tightened to forbid those old direct handler-side calls from reappearing
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 14
- moved JSON-side chat usage normalization and request log context projection out of `src/server/handlers/handler-response-utils.ts` and into `src/modules/llmswitch/bridge/responses-response-bridge.ts` via `normalizeChatUsagePayloadForHttp(...)` and `buildResponsesRequestLogContextForHttp(...)`
- `handler-response-utils.ts` no longer owns local chat-usage numeric sanitation or request color/session context assembly; it only dispatches through the response bridge and writes client JSON/SSE transport
- single-bridge gate tightened to forbid `resolveNormalizedChatUsage`, `normalizeChatUsagePayload`, and `buildRequestLogContext` from reappearing in the server dispatcher
- test mocks for response-bridge blackbox suites were updated to expose the new facade exports so the import surface stays complete
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 15
- moved request-side stream/scope runtime planning out of `src/server/handlers/responses-handler.ts` and into `src/modules/llmswitch/bridge/responses-request-bridge.ts` via `buildResponsesConversationPortScopeForHttp(...)`, `planResponsesHandlerStreamForHttp(...)`, and `prepareResponsesHandlerRuntimeForHttp(...)`
- `responses-handler.ts` no longer owns local port-scope parsing, stream intent derivation, request-start stream metadata assembly, or local continuation-expired / resume-client error projection branches; it now consumes one request-bridge runtime plan and stays on HTTP adapter / timeout / logging / pipeline dispatch responsibilities
- request-stream contract stayed locked by blackbox regressions: omitted `stream` still defaults to stream=true for `/v1/responses`, explicit `stream=false` still stays non-stream, and submit_tool_outputs start/error paths still preserve request-start logging + SSE error shape
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 16
- moved request-side protocol-scoped pipeline metadata assembly out of `src/server/handlers/responses-handler.ts` and behind `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- handler no longer locally shapes `providerProtocol: 'openai-responses'`, `responsesResume`, `responsesRequestContext`, or stream carrier metadata; it only merges generic request metadata with one request-bridge metadata block
- single-bridge gate now forbids those protocol-scoped metadata tokens from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 17
- moved request-side request-body metadata read/strip and `clientAbortSignal` extraction out of `src/server/handlers/responses-handler.ts`; both now sit behind `prepareResponsesRequestBodyForHttp(...)` and `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `responses-handler.ts` no longer directly calls `readRequestBodyMetadata(...)`, `stripRequestBodyMetadataForPipeline(...)`, or scans the client connection state symbol table for abort-signal projection; server stays on adapter/timeout/logging/pipeline dispatch
- single-bridge gate now forbids those request-body metadata helpers and inline abort-signal extraction from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 18
- moved response-side `responsesRequestContext` resolution behind `resolveResponsesRequestContextForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` and `handler-response-sse.ts` no longer locally choose `result.metadata.responsesRequestContext ?? handler fallback`
- single-bridge gate now forbids local `?? options?.responsesRequestContext` / `?? args.responsesRequestContext` in the server dispatcher/SSE files
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` for metadata-preferred resolution and fallback-only resolution
- verify PASS: `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts`, `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 19
- moved direct passthrough SSE metadata/internal-carrier guard out of `src/server/handlers/handler-response-sse.ts` and into `assertDirectPassthroughResponsesSseMetadataIsolationForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `handler-response-sse.ts` no longer locally parses SSE `data:` payloads to inspect `metadata` / `providerKey` / `__rt` / internal carrier keys; server now only feeds `frame + requestId` into the bridge guard
- single-bridge gate now forbids local `isInternalMetadataCarrier(...)` and `assertDirectPassthroughSseFrameHasNoInternalMetadataControls(...)` from reappearing in `handler-response-sse.ts`
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` for rejecting internal metadata control fields and allowing ordinary provider metadata

2026-06-13 log color multi-color audit
- User reported same logical session/request shows multiple ANSI colors across `virtual-router-hit`, request completion, `session-request`, and `[usage]` lines.
- Initial root-cause evidence: `usage/session-request` path uses `resolveRequestLogColorToken(requestId, requestLogContext)` with canonical color-key precedence (`clientTmuxSessionId -> tmuxSessionId -> sessionId -> conversationId`), but `colorizeVirtualRouterHitLogLine()` still recolors from parsed text session (`[session]` or `sid=`) only. If printed `sid=` is a per-request alias while request context is tmux-scoped canonical key, the same request family splits into different colors.
- Existing tests cover usage tmux priority and standalone virtual-router-hit coloring, but there is no regression that locks one request family's `virtual-router-hit + request/response + usage` lines to the same canonical color when `sid` differs from tmux key.
- Next fix direction: make request-side registry/context the first color owner for virtual-router-hit recolor, then keep textual sid/bracket only as fallback when no request context exists; add focused regression.
2026-06-13 continuation/build closeout
- llmswitch-core tsc now clean under Node 22.
- build-core.mjs rebuilt native + llmswitch-core dist successfully after restoring responses-openai bridge locals and stop-schema no_change_count typing.
- Next: rerun install-global.sh, then verify routecodex/rcc versions and /health.
