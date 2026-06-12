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
