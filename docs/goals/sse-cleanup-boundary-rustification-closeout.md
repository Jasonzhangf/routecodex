# SSE Cleanup Boundary Rustification Closeout

## Objective

把 `/v1/responses` 和 SSE 相关 TS 残留收口到“transport-only / thin shell”，把仍然承载语义修复、生命周期策略、usage 归一化、direct relay 重投影、provider SSE materialization/error descriptor 的真源下沉到 Rust owner，或在确认 dead residue 后物理删除。

## Success Criteria

- `src/server/handlers/handler-response-sse.ts` 只保留 HTTP/SSE transport 行为。
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts` 只保留 facade / shell 行为。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 不再长期承载 usage normalization、conversation cleanup policy、relay SSE reproject policy。
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 只保留 Node stream bytes 读取、native 调用、IO glue。
- `sharedmodule/llmswitch-core/src/sse/**` 不再出现 fallback / salvage / synthetic truth / silent swallow / provider-specific residue。
- 所有越界语义都由 gate 锁死，且每个 slice 都有正反测试。
- 至少一次 live / replay SSE 证据，或明确说明不可 replay 的缺口与替代 probe。

## Current Audit Matrix

| file path | current symbol / function | current responsibility | classification | unique owner | handling | must-run tests / gates |
| --- | --- | --- | --- | --- | --- | --- |
| `src/server/handlers/handler-response-sse.ts` | `sendSseBridgeError`, `sendStructuredSseError`, `extractStructuredSseErrorPayload`, `streamResponsesJsonAsSse`, `streamChatCompletionsJsonAsSse`, `dispatchResponsesJsonAsSse` | SSE transport, stream pipe/unpipe, closeout, frame write, diagnostic snapshot | `transport-only` for write/close; `semantic-borderline` where it still decides chat->responses projection or structured error projection | `server.responses_response_handler_bridge_surface` + Rust response projection owner | keep thin transport shell; move any semantic decision out of handler; delete dead repair if confirmed | `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `src/modules/llmswitch/bridge/responses-sse-bridge.ts` | `prepareResponsesJsonBodyForSseBridgeForHttp`, re-exports | facade / bridge shell | `transport-only` for simple re-export surface | Rust response projection owner for any semantic decision | 2026-06-30 slice physically removed `reprojectDirectChatToolCallStreamForHttp`; keep facade only | `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `src/modules/llmswitch/bridge/responses-response-bridge.ts` | `resolveResponsesConversationClearReasonForHttp`, `rebindResponsesConversationRequestIdForHttp`, client projection dispatch helpers | request-id rebind, client projection native call shell, request log context | `native thin shell`; prior `semantic-borderline` helpers removed | Rust response/continuation owner for lifecycle truth; transport owner only for IO | 2026-06-30 slice physically removed chat usage normalization, client-close/failure cleanup policy, relay SSE reprojection helper, and request-id cleanup fanout helper | `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/responses-provider-owned-continuation-reroute.blackbox.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` | `materializeProviderResponseSsePayload`, `extractProviderResponseSseStream`, `readProviderResponseSseStreamText`, `buildProviderSseStreamReadError`, `convertProviderResponse` | Node stream read, native SSE materialization call, effect-plan application, client projection orchestration | `native thin shell` for stream read; `semantic-borderline` for anything beyond read/call/IO | Rust owner under `hub.response_provider_sse_materialization` + response projection owner | keep TS as thin shell only; move materialization/error descriptor/effect-plan truth to Rust; delete duplicate TS semantics if any remain | `tests/sharedmodule/provider-response-rust-plan.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`, `npm run verify:hub-response-provider-sse-materialization`, `npm run verify:sse-architecture-boundary` |
| `sharedmodule/llmswitch-core/src/sse/**` | `responses-json-to-sse-converter.ts`, `responses-sse-to-json-converter.ts`, `chat-sse-to-json-converter.ts`, `anthropic-json-to-sse-converter.ts`, `gemini-json-to-sse-converter.ts`, serializers / sequencers / registry / writer | SSE codec / serialization / decode / frame generation | `dead residue` when it still contains fallback / salvage / synthetic / provider-specific markers; otherwise `native target` for migration | Rust SSE codec / serializer / parser owners | physical delete dead residue; keep only proven thin shell; add gate markers for every deleted anti-pattern | `tests/sharedmodule/sse-no-silent-failure.spec.ts`, `tests/sharedmodule/chat-sse-no-salvage.spec.ts`, `tests/sharedmodule/sse-parser-no-recovery.spec.ts`, `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts`, `npm run verify:sse-architecture-boundary` |

## Test Design

### Whitebox

- Lock function owner and stage boundary for handler, bridge, and provider-response shell.
- Prove transport-only paths still write headers, frames, pipe/unpipe, close cleanly, and record transport observation.
- Prove semantic paths do not survive in TS when the same behavior can be owned by Rust or deleted.
- Prove `buildProviderSseStreamReadError` only wraps read failures and does not become a second semantic owner.

### Blackbox

- Client-facing: SSE success path still streams terminal frames, client close still closes transport, and no internal metadata leaks.
- Provider-facing: direct/relay response projection still produces the right upstream/client observable shape, but no TS helper rewrites continuation or lifecycle truth.
- Boundary-facing: partial stream salvage, synthetic truth generation, and provider-specific SSE residue stay rejected.

## Verification Gates

Required gates for each slice:

- `npm run verify:sse-architecture-boundary`
- `npm run verify:responses-sse-business-module`
- `npm run verify:hub-response-provider-sse-materialization`
- `npm run verify:hub-response-responses-chat-projection`
- `npm run verify:debug-unified-surface`
- `npm run verify:error-pipeline-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-mainline-node-id-consistency`
- `npx tsc -p tsconfig.json --pretty false`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `npm run build:base`
- `git diff --check`

Focused tests to use as slice gates:

- `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`
- `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`
- `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`
- `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
- `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
- `tests/sharedmodule/provider-response-rust-plan.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
- `tests/red-tests/server_sse_metadata_guard_e2e.test.ts`

## Slice Order

1. Add or update red / reverse tests for the exact residue being removed.
2. Move semantic truth to Rust owner or delete dead residue.
3. Extend gate markers so the removed expression cannot return.
4. Re-run focused tests, then the required gates.
5. Replay a real sample or live probe before calling the slice closed.

## Open Risks

- `responses-response-bridge.ts` has had the first usage/cleanup/reprojection policy slice removed, but remaining projection helper code still needs review against Rust owner boundaries.
- `provider-response.ts` still does stream read + materialization orchestration in TS and may need another shrink pass.
- `handler-response-sse.ts` still contains projection decisions for chat / responses paths and may need further owner cuts.
- `sharedmodule/llmswitch-core/src/sse/**` still contains many legacy markers; each must be validated against the gate before deletion.

## Slice Log

### 2026-07-01 Anthropic SSE timestamp synthesis removal slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker `timestamp: Date.now()` for `anthropic-sequencer.ts` and failed before the fix. Focused Jest also failed because valid Anthropic events carried an own `timestamp` property.
- Fix: `AnthropicSseEventBase` no longer inherits the required `BaseSseEvent.timestamp` field, and `anthropic-sequencer.ts::createEvent()` no longer writes a local timestamp. Anthropic wire output remains explicit `event:` / `data:` framing through the serializer.
- Positive / reverse tests: `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` asserts valid Anthropic events do not carry own `timestamp` while preserving `message_start`, `message_delta`, and `message_stop`; existing reverse tests cover missing id, role, tool id, and stop_reason fail-fast.
- Verification: focused Jest `anthropic-sse-required-fields-no-fallback` PASS 5/5; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source replay `eventCount=6`, `hasTimestamp=false`, `hasMessageStart=true`, `hasMessageDelta=true`, `hasMessageStop=true`, `hasExplicitStopReason=true`.
- Real sample gap: current Anthropic sample directories contain 429 provider-error snapshots only, not a successful provider-response SSE/JSON replay sample.

### 2026-07-01 Gemini SSE timestamp synthesis removal slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker `timestamp: Date.now()` for `gemini-sequencer.ts` and failed before the fix. Focused Jest also failed because valid Gemini events carried an own `timestamp` property.
- Fix: `GeminiSseEvent` no longer inherits the required `BaseSseEvent.timestamp` field, and `gemini-sequencer.ts::createEvent()` no longer writes a local timestamp. Gemini wire output remains `event:` / `data:` only through the serializer.
- Positive / reverse tests: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` asserts valid Gemini events do not carry own `timestamp` or `sequenceNumber` while preserving data/done output; existing reverse tests cover missing role and null part fail-fast.
- Verification: focused Jest `gemini-sse-no-role-fallback` PASS 3/3; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source replay `eventCount=2`, `dataEvents=1`, `doneEvents=1`, `hasSequenceNumber=false`, `hasTimestamp=false`, `hasPartText=true`, `hasDone=true`.
- Real sample gap: no Gemini provider-response samples were found under `~/.rcc/codex-samples` or `/Volumes/extension/.rcc/codex-samples`.

### 2026-07-01 Gemini SSE fixed sequence number removal slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker `sequenceNumber: 0` and failed before the fix. Focused Jest also failed because valid Gemini events carried a fixed synthesized `sequenceNumber`.
- Fix: `gemini-sequencer.ts::createEvent()` no longer writes `sequenceNumber: 0`; Gemini wire output remains `event:` / `data:` only through the serializer.
- Positive / reverse tests: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` now asserts valid Gemini events do not carry an own `sequenceNumber` property while preserving valid data/done output; existing reverse tests still cover missing role and null part fail-fast.
- Verification: focused Jest `gemini-sse-no-role-fallback` PASS 3/3; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source replay `eventCount=2`, `dataEvents=1`, `doneEvents=1`, `hasSequenceNumber=false`, `hasPartText=true`, `hasDone=true`.
- Real sample gap: no Gemini provider-response samples were found under `~/.rcc/codex-samples` or `/Volumes/extension/.rcc/codex-samples`.

### 2026-07-01 Gemini SSE content parts no silent drop slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker `parts.filter((part): part is GeminiContentPart => Boolean(part))` and failed before the fix, proving `gemini-sequencer.ts` silently dropped invalid content parts.
- Fix: `getCandidateParts()` now validates each part and fails fast on null/undefined with `Invalid Gemini candidate part at index <n>`; valid parts are preserved unchanged.
- Positive / reverse tests: `tests/sharedmodule/gemini-sse-no-role-fallback.spec.ts` covers valid Gemini data/done output, missing role fail-fast, and null part fail-fast.
- Verification: focused Jest `gemini-sse-no-role-fallback` PASS 3/3; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source replay `eventCount=2`, `dataEvents=1`, `doneEvents=1`, `hasPartText=true`, `nullPartFailed=true`.
- Real sample gap: no Gemini provider-response samples were found under `~/.rcc/codex-samples` or `/Volumes/extension/.rcc/codex-samples`.

### 2026-07-01 Anthropic SSE stop_reason fallback removal slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker `response.stop_reason ?? 'end_turn'` and failed before the fix, proving `anthropic-sequencer.ts` still synthesized a default `stop_reason`.
- Fix: `createAnthropicSequencer().sequenceResponse()` now fail-fasts when `response.stop_reason` is missing; `message_delta.delta.stop_reason` uses only provider truth.
- Positive / reverse tests: `tests/sharedmodule/anthropic-sse-required-fields-no-fallback.spec.ts` now covers explicit id/role/tool id and the reverse missing `stop_reason` fail-fast.
- Verification: focused Jest `anthropic-sse-required-fields-no-fallback` PASS 4/4; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source replay `eventCount=6`, `hasMessageDelta=true`, `hasExplicitStopReason=true`, `fallbackMarkerPresent=false`, `missingStopFailed=true`.
- Real sample gap: current Anthropic sample directories only contain 429 provider-error snapshots, not a successful provider-response SSE/JSON replay sample.

### 2026-07-01 Anthropic/Gemini SSE serializer event fallback removal slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for Anthropic serializer default event synthesis (`: 'message')` and payload-derived type fallback) and Gemini serializer default event synthesis (`event.event ?? event.type ?? 'gemini.data'`). The gate failed on the existing TS fallback. Focused Jest also failed before the fix because missing event/type did not throw.
- Fix: `serializeAnthropicEventToSSE()` and `serializeGeminiEventToSSE()` now only frame explicit `event` / `type` values. Missing or blank event type fails fast; serializers no longer infer event type from payload or default protocol constants.
- Positive / reverse tests: `tests/sharedmodule/anthropic-gemini-sse-serializer-no-fallback.spec.ts` covers explicit Anthropic/Gemini event serialization and reverse missing-event fail-fast for both protocols.
- Verification: focused Jest `anthropic-gemini-sse-serializer-no-fallback` PASS 4/4; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `npm run build:base` PASS; `git diff --check` PASS.
- Replay evidence: source serializer replay succeeded with `anthropicHasEvent=true`, `geminiHasEvent=true`, `anthropicFailed=true`, `geminiFailed=true`, `fallbackLeak=false`.
- Real sample gap: current `~/.rcc/codex-samples` and `/Volumes/extension/.rcc/codex-samples` contain OpenAI chat samples but no Anthropic/Gemini provider-response sample for same-protocol replay.

### 2026-07-01 Chat SSE finish/usage payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for local Chat finish/usage payload synthesis (`function normalizeChatUsage(`, `const normalizedUsage = normalizeChatUsage(usage);`, and the finish chunk `delta: {}` / `finish_reason: finishReason` shape). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseFinishPayloadJson` and TS wrapper `buildChatSseFinishPayloadWithNative`. `chat.ts::buildFinishEvent()` now only obtains base response context, calls native for the chat completion final chunk payload, and wraps it in the native-owned SSE event envelope.
- Boundary cleanup: physically removed TS `normalizeChatUsage()` / `readNonNegativeInteger()` and local finish chunk object synthesis. Rust validates `finish_reason`, `created`, `choice_index`, and strict Chat usage token fields; missing usage is omitted, invalid usage fails fast.
- Positive / reverse tests: Rust covers finish payload with usage, finish payload without usage, missing usage token fail-fast, and invalid finish_reason fail-fast; focused Jest keeps missing usage omission, invalid usage errors, Responses-style usage alias rejection, and function-call args no-fallback behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_finish_payload` PASS 4/4; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-sse-function-call-args-no-fallback` PASS 21/21; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; root `tsc --noEmit` PASS; `git diff --check` PASS.
- Known unrelated blocker: current worktree servertool registry rename residue blocks `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` / `npm run verify:function-map-compile-gate` / `npm run build:base`; failures are `registry-orchestration-shell.ts(37,12): Cannot find name 'getBuiltinHandlerEntry'` and missing `tests/servertool/registry-registration-shell.spec.ts`.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `chatChunkCount=4`, `finishChunks=1`, `usageChunks=1`, `doneCount=1`, `finishReason=tool_calls`.

### 2026-07-01 Chat SSE tool-call start payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker for local Chat tool-call start payload synthesis (`arguments: ''`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseToolCallStartPayloadJson` and TS wrapper `buildChatSseToolCallStartPayloadWithNative`. `chat.ts::buildToolCallStart()` now only obtains base response context, calls native for the chat completion chunk payload, and wraps it in the native-owned SSE event envelope.
- Boundary cleanup: removed the TS-side `toolCall.type || 'function'` fallback. Rust requires `tool_call_type === "function"` and fails fast on missing or invalid type.
- Positive / reverse tests: Rust covers tool-call start payload construction, missing type fail-fast, and invalid type fail-fast; focused Jest keeps Chat SSE usage/no-synthetic/function-call-args behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_tool_call_start_payload` PASS 3/3; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic + chat-sse-function-call-args-no-fallback` PASS 23/23; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `chatChunkCount=4`, `toolStartChunks=1`, `toolStartWithId=1`, `toolStartWithName=1`, `toolStartWithEmptyArgs=1`, `toolArgsChunks=1`, `finishChunks=1`.

### 2026-07-01 Chat SSE tool-call args delta payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker for local Chat tool-call arguments delta payload synthesis (`function: { arguments: args }`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseToolCallArgsDeltaPayloadJson` and TS wrapper `buildChatSseToolCallArgsDeltaPayloadWithNative`. `chat.ts::buildToolCallArgsDeltas()` now only obtains base response context, calls native for the chat completion chunk payload, and wraps it in the native-owned SSE event envelope.
- Positive / reverse tests: Rust covers tool-call args delta payload construction and missing arguments fail-fast; focused Jest keeps Chat SSE usage/no-synthetic/function-call-args behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_tool_call_args_delta_payload` PASS 2/2; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic + chat-sse-function-call-args-no-fallback` PASS 23/23; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `chatChunkCount=4`, `toolStartChunks=1`, `toolArgsChunks=1`, `toolArgBytes=75`, `finishChunks=1`.

### 2026-07-01 Chat SSE reasoning delta payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker for local Chat reasoning delta payload synthesis (`delta: { reasoning, reasoning_content: reasoning }`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseReasoningDeltaPayloadJson` and TS wrapper `buildChatSseReasoningDeltaPayloadWithNative`. `chat.ts::buildReasoningDeltas()` now only obtains base response context, calls native for the chat completion chunk payload, and wraps it in the native-owned SSE event envelope.
- Positive / reverse tests: Rust covers reasoning delta payload construction and missing reasoning fail-fast; focused Jest keeps Chat SSE reasoning/content roundtrip behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_reasoning_delta_payload` PASS 2/2; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic` PASS 18/18; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `chatChunkCount=4`, `reasoningChunks=0`, `toolChunks=2`, `finishChunks=1`. This real sample has no reasoning delta, so non-empty reasoning delta behavior is covered by Rust and focused Jest.

### 2026-07-01 Chat SSE content delta payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker for local Chat content delta payload synthesis (`delta: { content }`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseContentDeltaPayloadJson` and TS wrapper `buildChatSseContentDeltaPayloadWithNative`. `chat.ts::buildContentDeltas()` now only obtains base response context, calls native for the chat completion chunk payload, and wraps it in the native-owned SSE event envelope.
- Positive / reverse tests: Rust covers content delta payload construction and missing content fail-fast; focused Jest keeps Chat SSE usage/no-synthetic behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_content_delta_payload` PASS 2/2; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic` PASS 18/18; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `npm run verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `chatChunkCount=4`, `toolChunks=2`, `finishChunks=1`, `usageChunks=1`. This real sample has no non-empty content delta, so non-empty content delta behavior is covered by Rust and focused Jest.

### 2026-07-01 Chat SSE role delta payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added the forbidden marker for local Chat role delta payload synthesis (`delta: { role: role as ... }`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseRoleDeltaPayloadJson` and TS wrapper `buildChatSseRoleDeltaPayloadWithNative`. `chat.ts::buildRoleDelta()` now only obtains the base response context, calls native for the chat completion chunk payload, and wraps it in the native-owned SSE event envelope.
- Positive / reverse tests: Rust covers role delta payload construction and invalid role fail-fast; focused Jest keeps Chat SSE usage/no-synthetic behavior intact; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_role_delta_payload` PASS 2/2; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic` PASS 18/18; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `eventCount=5`, `chatChunkCount=4`, `doneCount=1`, `roleChunks=1`, `finishReason=tool_calls`.

### 2026-07-01 Chat SSE error payload Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for Chat SSE local error payload synthesis (`type: 'internal_error'` and `code: 'generation_error'`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseErrorPayloadJson` and TS wrapper `buildChatSseErrorPayloadWithNative`. `chat.ts::buildErrorEvent()` now only creates the SSE event envelope and serializes the native-owned error payload.
- Positive / reverse tests: Rust covers error payload construction and missing message fail-fast; focused Jest keeps invalid Chat usage projected as `generation_error` without `[DONE]`; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_error_payload` PASS 2/2; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic` PASS 18/18; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `eventCount=5`, `chatChunkCount=4`, `doneCount=1`, `finishReason=tool_calls`.

### 2026-07-01 Chat SSE event envelope Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for Chat SSE local envelope synthesis (`TimeUtils` import, `timestamp: TimeUtils.now()`, and fixed `sequenceNumber: 0`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildChatSseEventEnvelopeJson` and TS wrapper `buildChatSseEventEnvelopeWithNative`. `chat.ts` now calls native for event timestamp/sequence/protocol/direction and updates `sequenceCounter`; `chat-sequencer.ts` no longer overwrites event sequence numbers locally.
- Positive / reverse tests: Rust covers sequence advancement, sequence-disabled behavior, and missing request id fail-fast; focused Jest covers chat usage no-fallback, chat usage roundtrip, and no request-to-SSE synthetic response surface; native export-list covers the new NAPI symbol.
- Verification: Rust focused `chat_sse_event_envelope` PASS 3/3; native hotpath build PASS; focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip + chat-request-sse-no-synthetic` PASS 18/18; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real chat replay: `openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` SSE->JSON->SSE succeeded with `done=true`, `error=false`, `malformedWire=0`, `eventCount=5`, `chatChunkCount=4`, `doneCount=1`, `finishReason=tool_calls`.

### 2026-07-01 Responses SSE event envelope Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for local Responses SSE envelope synthesis (`TimeUtils` import, `getNextSequenceNumber()`, and `createBaseEvent()`). The gate failed on the existing TS owner before the fix.
- Fix: added Rust/NAPI owner `buildResponsesSseEventEnvelopeJson`; `responses.ts` now only calls `buildResponsesSseEventEnvelopeWithNative()` and writes back `nextSequenceCounter`. TS no longer owns timestamp generation or sequence advancement. The same slice moved response metadata stripping into Rust `normalize_responses_sse_response_payload`, preventing internal metadata from leaking into client-visible SSE response payloads.
- Positive / reverse tests: Rust covers envelope sequence advancement, sequence-disabled behavior, and metadata removal from response payload; Jest covers the native wrapper and existing sequenced Responses SSE projections; metadata boundary tests lock the no-leak behavior.
- Verification: Rust focused envelope tests PASS; Rust metadata stripping test PASS; native hotpath build PASS; focused Jest `responses-sse-reasoning-summary-no-normalize + responses-sse-content-part-descriptor-native + responses-sse-output-item-descriptor-native + responses-sse-metadata-boundary + responses-sse-usage-no-fallback + responses-json-to-sse-usage` PASS 34/34; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, `metadataLeak=0`, `eventCount=25`.

### 2026-07-01 Responses SSE error recovery policy Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for `responses-sequencer.ts` local recovery policy (`enableRecovery`, `if (config.enableRecovery)`, and item-level `yield buildErrorEvent(error as Error, context, config)`). The gate failed on the existing TS owner.
- Fix: added Rust/NAPI owner `planResponsesSseErrorRecoveryJson`. `responses-sequencer.ts` no longer exposes `enableRecovery`, no longer catches per-output-item errors, and only consumes the native response-level policy before emitting `response.error`; invalid output items now fail up to response-level error projection instead of being locally recovered and followed by `response.completed`.
- Positive / reverse tests: Rust covers response scope -> `emit_response_error` and output_item scope -> `throw`; Jest covers direct native policy output and verifies invalid output items produce `response.error` without `response.completed` / `response.done`.
- Verification: `cargo test -p router-hotpath-napi plans_responses_sse_error_recovery_by_scope --lib -- --nocapture` PASS; native build PASS; focused Jest `responses-sse-usage-no-fallback + responses-json-to-sse-usage + responses-sse-reasoning-summary-no-normalize` PASS 19/19; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, `eventCount=25`.

### 2026-07-01 Responses output message normalizer Rust owner slice

- Red evidence: `verify:sse-architecture-boundary` added markers for `responses-sequencer.ts::normalizeResponseOutput()` and TS-side `responses-output-normalizer.ts` message/reasoning split logic (`baseId`, `extraReasoning`, `suppressReasoningFromContent`, synthetic `_reasoning` id). The gate failed on the existing TS owner.
- Fix: added Rust/NAPI owners `normalizeResponsesMessageItemJson`, `expandResponsesMessageItemJson`, and `normalizeResponsesOutputItemsJson`. TS `responses-output-normalizer.ts` is now a native wrapper, and `responses-sequencer.ts` calls the output-array native owner instead of deciding explicit reasoning suppression locally.
- Positive / reverse tests: Rust covers message normalization, output-array expansion without duplicate synthetic reasoning when explicit reasoning already exists, and missing message id fail-fast; Jest covers the TS wrapper fail-fast path and existing Responses SSE sequencing.
- Verification: Rust focused `responses_message_item` PASS 2/2 and `responses_output_items` PASS 1/1; native build PASS; focused Jest `responses-output-normalizer-no-fallback + responses-sse-reasoning-summary-no-normalize` PASS 12/12; native export-list subtest PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, `eventCount=25`.

### 2026-07-01 Responses SSE native payload wrapper collapse slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers for `data: { ...delta }`, `data: { ...payload }`, `data: { ...partAdded }`, `data: { ...textDone }`, and `data: { ...partDone }`; the gate failed on the remaining TS re-wrap paths.
- Fix: `responses.ts` now assigns native payloads directly to `data` for output text, function call arguments, reasoning deltas, and reasoning summary events. TS no longer clones/re-wraps native-owned SSE payload objects before the canonical Rust serializer boundary.
- Positive / reverse tests: focused Jest proves the same native payload projections still sequence correctly; the architecture gate prevents the local spread-wrapper shape from returning.
- Verification: focused Jest `responses-sse-reasoning-summary-no-normalize` PASS 11/11; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, `eventCount=25`.

### 2026-07-01 Responses SSE reasoning lifecycle payload native owner slice

- Red evidence: `verify:sse-architecture-boundary` added forbidden markers `item_id: reasoning.id` and `summary: normalizeReasoningSummaryFieldWithNative`; this caught the remaining TS synthesis path for `reasoning.start` / `reasoning.done` payloads.
- Fix: added Rust/NAPI owner `buildResponsesSseReasoningLifecyclePayloadJson`; TS `buildReasoningStartEvent()` and `buildReasoningDoneEvent()` now call `buildResponsesSseReasoningLifecyclePayloadWithNative()` and only wrap the SSE event envelope. The local TS `normalizeReasoningSummaryFieldWithNative()` helper was physically removed, so summary normalization is consumed directly from native owner.
- Positive / reverse tests: Rust covers start/done lifecycle payload construction and blank `item_id` fail-fast; Jest covers native wrapper output and missing `item_id` error propagation.
- Verification: `cargo test -p router-hotpath-napi reasoning_lifecycle --lib -- --nocapture` PASS 2/2; `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS; focused Jest `responses-sse-reasoning-summary-no-normalize` PASS 11/11; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, `eventCount=25`.

### 2026-06-30 Responses direct JSON client model restore Rust owner slice

- Red evidence: deleting the TS/JS direct-body model helper path (`readResponsesRequestModelForHttp` / `ensureResponsesJsonToSseRequiredFieldsForHttp`) made `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` fail because direct JSON client projection no longer emitted `model: gpt-5.4`.
- Root cause: Rust `project_responses_client_payload_for_client` restored client-visible model/reasoning only for event-wrapper payloads shaped as `{ response: ... }`; direct response bodies shaped as `{ object: "response" }` still depended on the stale JS bridge helper.
- Fix: Rust owner now restores client-visible fields on direct response bodies as well as event wrappers; `projectResponsesClientPayloadForClientJson` accepts a context JSON argument, and the TS bridge only passes requestContext payload/context to native before stripping client-visible metadata. The stale TS/JS helper path was physically deleted.
- Positive / reverse tests: Rust covers direct response body model restore from `originalRequest.model`; focused Jest proves direct JSON projection still removes replay-unsafe reasoning/status/internal metadata while preserving client-visible model. `verify:responses-sse-business-module` now forbids the deleted helper names from returning.
- Verification: Rust focused direct-body model test PASS; native build PASS; focused Jest `responses-response-bridge.direct-json-protocol-guard` PASS 2/2; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, and `malformedWire=0`.

### 2026-06-30 Responses SSE text chunk native owner slice

- Red evidence: current gate markers checked previous HEAD and caught `const TEXT_CHUNK_BOUNDARY`, `function getChunkSize(`, `function chunkText(`, and `StringUtils.chunkString(`, proving Responses SSE text chunking still lived in TS.
- Fix: added Rust owner `buildResponsesSseTextChunksJson`; TS now calls `buildResponsesSseTextChunksWithNative()` for output text deltas, function call argument deltas, and reasoning summary text deltas while only wrapping the SSE event envelope.
- Positive / reverse tests: Rust covers chunking disabled as one chunk, boundary/size chunking, and missing text fail-fast; Jest covers native wrapper output and sequenced output text deltas using native chunks.
- Verification: native build PASS; Rust focused `text_chunks` PASS 3/3; focused Jest PASS 31/31; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; `verify:function-map-compile-gate` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `functionDelta=16`, `outputTextDelta=0`, and `summaryDelta=0`.

### 2026-06-30 Responses SSE output/content wrapper payload native owner slice

- Red evidence: after adding `output_index: context.outputIndexCounter,`, `item_id: outputItemId,`, and `content_index: contentIndex,` as forbidden markers, `npm run verify:sse-architecture-boundary` failed on `responses.ts`, proving `response.output_item.*` and `response.content_part.*` wrapper payloads still lived in TS.
- Fix: added Rust owners `buildResponsesSseOutputItemEventPayloadJson` and `buildResponsesSseContentPartEventPayloadJson`; TS now calls native wrappers for `response.output_item.added/done` and `response.content_part.added/done` while only wrapping the SSE event envelope.
- Positive / reverse tests: Rust covers output item wrapper payloads, content part wrapper payloads with `part`, and content_part done without `part`; Jest covers sequenced output item/content part wrapper projection.
- Verification: native build PASS; Rust focused `output_item_event_payload` PASS 1/1 and `content_part_event_payload` PASS 2/2; focused Jest 29/29 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `outputItemEvents=4`, `contentPartEvents=0`, and `badWrapper=0`.

### 2026-06-30 Responses SSE response event payload native owner slice

- Red evidence: after adding `basePayload.output = []` as a forbidden marker, `npm run verify:sse-architecture-boundary` failed on `buildResponseStartEvents()`, proving response start payload mutation still lived in TS.
- Fix: added Rust owner `buildResponsesSseResponseEventPayloadJson`; TS now calls `buildResponsesSseResponseEventPayloadWithNative()` for `response.created` / `response.in_progress` / `response.completed` / `response.done` / `response.required_action` data payloads and only wraps the SSE event envelope.
- Positive / reverse tests: Rust covers start payload output clearing, required_action payload construction, and missing required_action fail-fast; Jest covers native wrapper output and sequenced `response.created` / `response.in_progress` projection.
- Verification: Rust focused `response_event_payload` PASS 1/1 and `required_action_event_payload` PASS 2/2; native build PASS; focused Jest 34/34 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `createdOutputLength=0`, `inProgressOutputLength=0`, `completedOutputLength=2`, and `doneOutputLength=2`.

### 2026-06-30 Responses SSE reasoning delta payload native owner slice

- Red evidence: after adding `delta: content.text`, `signature: content.signature`, and `image_url: content.image_url` as forbidden markers, `npm run verify:sse-architecture-boundary` failed on `buildReasoningDeltas()`, proving `response.reasoning_text.delta` / `response.reasoning_signature.delta` / `response.reasoning_image.delta` payloads were still synthesized in TS.
- Fix: added Rust owner `buildResponsesSseReasoningDeltaPayloadJson`; TS now calls `buildResponsesSseReasoningDeltaPayloadWithNative()` and only wraps the SSE event envelope. `reasoning_signature.signature` is preserved as raw JSON value instead of stringified.
- Positive / reverse tests: Rust covers text/signature/image reasoning delta payloads and missing `item_id` fail-fast; Jest covers native wrapper output and sequenced reasoning delta projection.
- Verification: Rust focused `reasoning_delta_payload` PASS 2/2; native build PASS; focused Jest 32/32 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE succeeded with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `reasoningTextDelta=0`, `reasoningSignatureDelta=0`, and `reasoningImageDelta=0`; this real sample has no reasoning delta events, so reasoning delta payload behavior is covered by focused Jest and Rust tests.

### 2026-06-30 Responses SSE reasoning summary payload native owner slice

- Red evidence: `npm run verify:sse-architecture-boundary` 先红，命中 `part: { type: 'summary_text'`，证明 `responses.ts` 仍在本地合成 `response.reasoning_summary_part.added/done` 的 payload 语义。
- Fix: 新增 Rust owner `buildResponsesSseReasoningSummaryPayloadJson`，TS `buildReasoningSummaryEvents()` 只调用 native wrapper 并封装 SSE event envelope，summary payload materialize 不再由 TS 负责。
- Positive / reverse tests: Rust 覆盖 reasoning summary `part_added` / `part_done` / `text_delta` / `text_done` 和 missing `item_id` fail-fast；Jest 覆盖 native wrapper 直连与 `response.reasoning_summary_*` projection，不再依赖 TS 本地 summary payload 合成。
- Verification: `cargo test -p router-hotpath-napi reasoning_summary --lib -- --nocapture` PASS 14/14；`node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS；focused Jest `responses-sse-output-item-descriptor-native + responses-sse-content-part-descriptor-native + responses-sse-reasoning-summary-no-normalize + responses-json-to-sse-usage + responses-sse-usage-no-fallback + responses-event-serializer-no-salvage` PASS 30/30；`npm run verify:sse-architecture-boundary` PASS；`npm run verify:responses-sse-business-module` PASS；sharedmodule/root `tsc --noEmit` PASS；`git diff --check` PASS。
- 真实 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` materialize -> JSON->SSE 成功，`completed=true`、`done=true`、`error=false`、`missingType=0`、`missingSequence=0`，`reasoningItems=0`，`summaryPartAdded=0`，`summaryTextDelta=0`，`summaryTextDone=0`，`summaryPartDone=0`。

### 2026-06-30 Responses SSE function call arguments payload native owner slice

- Red evidence: after adding `call_id: functionCall.call_id` and `arguments: functionCall.arguments` as forbidden markers, `npm run verify:sse-architecture-boundary` failed on the Responses event generator, proving `response.function_call_arguments.delta/done` payloads still synthesized function-call argument payload semantics in TS.
- Fix: added Rust owners `buildResponsesSseFunctionCallArgumentsDeltaPayloadJson` and `buildResponsesSseFunctionCallArgumentsDonePayloadJson`; TS now calls native payload builders and only wraps the SSE event envelope.
- Positive / reverse tests: Rust covers function-call argument delta/done payload construction and missing `call_id` fail-fast; Jest covers native wrapper output and sequenced `response.function_call_arguments.delta/done` projection without TS payload synthesis.
- Verification: Rust focused `function_call_arguments` 5/5 PASS; native build PASS; focused Jest 29/29 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; root `tsc --noEmit` PASS. Sharedmodule `tsc --noEmit` is currently blocked by unrelated dirty `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` type error.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` replayed cleanly with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `functionDelta=16`, and `functionDone=1`.

### 2026-06-30 Responses SSE output text payload native owner slice

- Red evidence: after adding `logprobs: []` as a forbidden marker, `npm run verify:sse-architecture-boundary` failed on the Responses event generator, proving `response.output_text.delta/done` payloads still synthesized output text payload semantics in TS.
- Fix: added Rust owners `buildResponsesSseOutputTextDeltaPayloadJson` and `buildResponsesSseOutputTextDonePayloadJson`; TS now calls native payload builders and only wraps the SSE event envelope.
- Positive / reverse tests: Rust covers output text delta/done payload construction and missing `item_id` fail-fast; Jest covers native wrapper output and sequenced `response.output_text.delta/done` projection without TS `logprobs: []` synthesis.
- Verification: Rust focused `output_text_` 11/11 PASS; native build PASS; focused Jest 27/27 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` replayed cleanly with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`; that sample has no `output_text` events, so output text payload behavior is covered by focused Jest.

### 2026-06-30 Responses SSE content part descriptor native owner slice

- Red evidence: after adding forbidden markers, `npm run verify:sse-architecture-boundary` failed on `const partDescriptor: Record<string, unknown>`, `(content as any).annotations`, and `(content as any).logprobs`, proving `responses.ts` still owned content part descriptor materialization in TS.
- Fix: added Rust `buildResponsesSseContentPartDescriptorJson`; `response.content_part.added/done` now materialize part descriptors in Rust, and TS only calls `buildResponsesSseContentPartDescriptorWithNative()` before wrapping the SSE envelope.
- Positive / reverse tests: Rust covers `output_text` added, `function_result` done, and missing type fail-fast; Jest covers the native wrapper, JSON->SSE projection, and missing type does not synthesize an unknown descriptor.
- Verification: Rust focused `responses_sse_content_part` 3/3 PASS; native build PASS; focused Jest 24/24 PASS; `verify:sse-architecture-boundary` PASS; `verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Real 4444 replay: `req_1782794868950_3m64se1xv/provider-response_1.json` replayed cleanly with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`; that sample has no `content_part` events, so content part behavior is covered by focused Jest.

### 2026-06-30 bridge helper deletion slice

- Red evidence: after adding forbidden markers, `npm run verify:responses-sse-business-module` failed on direct chat tool-call stream reprojection, chat usage normalization, client-close/failure conversation cleanup policy, and relay Responses SSE reprojection policy.
- Fix: deleted `reprojectDirectChatToolCallStreamForHttp`, `normalizeChatUsagePayloadForHttp`, `shouldClearResponsesConversationOnClientCloseForHttp`, `shouldClearResponsesConversationOnFailureForHttp`, `clearResponsesConversationRequestIdsForHttp`, `shouldReprojectRelayResponsesSseForHttp`, and `resolveRelayResponsesClientSseStreamForHttp` from TS source and tracked JS/DTS bridge surfaces; deleted old `provider-response-relay-sse.spec.ts` that locked the wrong TS owner.
- Verification so far: `npm run verify:responses-sse-business-module` PASS, provider-response converter contract PASS, root `tsc` PASS, sharedmodule `tsc` PASS.

### 2026-06-30 provider-response SSE read-error wrapper slice

- Red evidence: `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` still carried a local `buildProviderSseStreamReadError` wrapper around the native descriptor.
- Fix: removed the local helper and moved the wrapper construction into `materializeProviderResponseSsePayload`; added residue gate coverage in `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`.
- Additional fix: Rust Responses client projection now replaces missing or non-positive `created_at` in existing Responses payloads before SSE encoding; Rust openai-chat response stream planning now only emits `servertoolRuntimeAction` when stopMessage/stopless runtime is explicitly active. TS `provider-response.ts` only post-projects servertool payloads after an orchestration action actually executed, so inert action plans cannot overwrite Rust `streamPipe.payload`.
- Positive tests: provider-response focused Jest now covers non-stream body, OpenAI chat stream, Responses stream stopless projection, no-session no-projection, disabled stopMessage no-projection, and runtime callback paths.
- Reverse tests: Rust `response_stream_path_returns_stream_pipe_effect_plan` proves ordinary chat streaming emits `streamPipe` + `runtimeStateWrite` but no `servertoolRuntimeAction`; Rust `build_responses_payload_from_chat_core_supplies_created_at_for_existing_response_payload` proves `created_at: 0` is replaced before Responses SSE encode.
- Verification: `cargo test -p router-hotpath-napi build_responses_payload_from_chat_core_supplies_created_at_for_existing_response_payload --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi normalize_openai_chat_reasoning_outbound --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi response_stream_path_returns_stream_pipe_effect_plan --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi response_stream_stop_with_runtime_callbacks_returns_stream_and_servertool_effects --lib -- --nocapture` PASS; `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS; `tests/sharedmodule/provider-response-rust-plan.spec.ts` PASS 20/20; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `npm run verify:hub-response-provider-sse-materialization` PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `git diff --check` PASS.
- Residue audit note: full `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` still has one unrelated red, `llmswitch matrix runner must not reference missing test scripts`, because `scripts/tests/virtual-router-quota-health-restore.mjs` is absent. All provider-response / servertool SSE projection residue cases in that suite passed.

### 2026-06-30 responses-event-serializer static synthesis helpers removed

- Red evidence: `responses-event-serializer.ts` still exposed static `createResponse*` / `createRequiredActionEvent` helpers and used `timestamp ?? Date.now()` to synthesize SSE events in TS.
- Fix: physically deleted the static factory block; kept the serializer as wire-format / parse-only owner; added source gate markers to `verify-sse-architecture-boundary.mjs` and a runtime-surface assertion in `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts`.
- Verification: `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts` PASS; sharedmodule `tsc --noEmit` PASS; root `tsc --noEmit` PASS; `git diff --check` PASS.

### 2026-06-30 chat SSE usage normalization moved to Rust owner

- Red evidence: `chat-sse-to-json-converter.ts` still carried local `normalizeChatUsage` / `readNonNegativeInteger` helpers, so chat SSE decode retained a second TS usage-normalization owner.
- Fix: added Rust `normalize_chat_usage` plus NAPI export `normalizeChatUsageJson`, TS wrapper `normalizeChatUsageWithNative`, and removed the local helper block from `chat-sse-to-json-converter.ts`; gate now forbids the old helper/call markers.
- Positive tests: `chat-sse-no-salvage.spec.ts` now proves a chat chunk with Responses-style usage fields (`input_tokens` / `output_tokens` / `prompt_cache_hit_tokens`) is normalized through native owner into chat usage output.
- Reverse tests: Rust `normalize_chat_usage_rejects_missing_token_fields` proves missing required token fields still fail-fast; real nested `details: null` is accepted as “no cached token details”, not silently rewritten.
- Verification: Rust focused `normalize_chat_usage` PASS; `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS; `tests/sharedmodule/chat-sse-no-salvage.spec.ts` PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay note: replaying `~/.rcc/codex-samples/openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` no longer fails on `usage.input_tokens_details.cached_tokens` null shape; the remaining replay blocker is a separate tail empty-chunk validator error (`Invalid chat completion chunk id`), which should be handled in the next slice rather than mixed into usage-owner closure.

### 2026-06-30 chat SSE tail empty-chunk validator slice

- Red evidence: the same real sample `~/.rcc/codex-samples/openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` still failed replay after the usage-owner slice because tail `choices: []` chunks with empty `id/object/created` hit `validateChatChunk()` and raised `Invalid chat completion chunk id`.
- Fix: `chat-sse-to-json-converter.ts` now validates chunk identity against lifecycle state. The first meaningful chunk still requires `id/object/created/model`, but once `currentResponse.id/created/model` are established, inert tail / usage-only chunks with `choices: []` are allowed to pass through instead of being treated as a malformed first chunk.
- Positive tests: `chat-sse-no-salvage.spec.ts` now proves a valid chunk followed by empty tail noise and a usage-only tail chunk still materializes a successful response with preserved usage totals.
- Reverse tests: `chat-sse-no-salvage.spec.ts` also proves a first chunk with empty `id` still fails fast, so this is not a salvage/fallback expansion.
- Verification: `chat-sse-no-salvage.spec.ts` PASS; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS; replay of the same real sample now yields `id=487e5ebc-ef2c-49d6-a81a-ce555c424a69`, `model=glm-5.2`, `finish_reason=tool_calls`, `tool_calls=1`, `usage={prompt_tokens:262815, completion_tokens:38, total_tokens:262846}`.

### 2026-06-30 Responses SSE dead facade surface slice

- Red evidence: runtime/source scan showed `resolveResponsesRequestContextForHttp`, `shouldDispatchResponsesSseToClientForHttp`, `prepareResponsesJsonSseDispatchPlanForHttp`, and `resolveResponsesConversationClearReasonForHttp` had no active runtime consumer outside bridge exports, tests, and checked-in JS/DTS mirrors. They only preserved fallback/forceSSE/no-op dispatch wrappers.
- Fix: deleted these helpers from `responses-response-bridge` / `responses-sse-bridge` TS plus checked-in `.js/.d.ts` mirrors and bridge index exports. `handler-response-utils.ts` now reads `forceSSE || result.sseStream !== undefined` and `options.responsesRequestContext` directly. `buildClientSseKeepaliveFrameForHttp` remains only on the SSE transport facade path backed by `responses-sse-transport.ts`.
- Positive tests: focused handler/SSE Jest proves direct raw SSE, forceSSE missing-stream fail-fast, JSON dispatch, required_action transport-only behavior, and request-context facade deletion still behave as expected.
- Reverse tests/gates: `responses-response-bridge.request-context-resolution.spec.ts`, `server_responses_sse_surface_single_owner.test.ts`, and `verify:responses-sse-business-module` now forbid the retired facade names from lifecycle/SSE bridge source and index exports.
- Verification: focused Jest `handler-response-utils.force-sse-json-responses`, `handler-response-utils.required-action-split-frame`, `responses-response-bridge.request-context-resolution`, `server_responses_sse_business_module_contract`, and `server_responses_sse_surface_single_owner` PASS 23/23; `npm run verify:responses-sse-business-module` PASS; `npm run verify:responses-handler-single-bridge-surface` PASS; `npm run verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: `~/.rcc/codex-samples/openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` replay through current chat SSE converter yields `id=487e5ebc-ef2c-49d6-a81a-ce555c424a69`, `model=glm-5.2`, `finish_reason=tool_calls`, `tool_calls=1`, `usage={completion_tokens:38,prompt_tokens:262815,total_tokens:262846}`.

### 2026-06-30 Responses JSON->SSE usage alias fallback removed

- Red evidence: `responses.ts::normalizeUsage` still accepted chat-style `prompt_tokens` / `completion_tokens`, flat `cache_read_input_tokens`, and computed missing `total_tokens`, making the TS SSE generator a second usage-normalization owner.
- Fix: `normalizeUsage` now only accepts canonical Responses fields: `input_tokens`, `output_tokens`, `total_tokens`, and optional `input_tokens_details.cached_tokens`. Missing canonical fields or legacy aliases fail into `response.error`; no alias fallback or total-token synthesis remains.
- Positive tests: `responses-json-to-sse-usage.spec.ts` still proves canonical upstream Responses usage with `input_tokens_details.cached_tokens` projects into `response.completed`.
- Reverse tests/gates: `responses-sse-usage-no-fallback.spec.ts` rejects legacy `prompt_tokens` / `completion_tokens` alias input; `verify:sse-architecture-boundary` now forbids those alias markers plus `cache_read_input_tokens` in `event-generators/responses.ts`.
- Verification: focused Jest `responses-json-to-sse-usage + responses-sse-usage-no-fallback` PASS 6/6; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794773576_s7okhowx0/provider-response_1.json` first materializes through native `ResponsesSseToJsonConverter`, then re-encodes through `ResponsesJsonToSseConverterRefactored` with `has_completed=true`, `has_done=true`, `has_error=false`, usage preserved as canonical `{"input_tokens":64215,"input_tokens_details":{"cached_tokens":61056},"output_tokens":672,"output_tokens_details":{"reasoning_tokens":610},"total_tokens":64887}`.

### 2026-06-30 Responses reasoning summary verbatim projection slice

- Red evidence: `responses.ts` still normalized reasoning summary text by stripping markdown/list prefixes, compacting whitespace, removing code fences/backticks, and auto-injecting `**Thinking**`, which made the SSE generator a semantic repair owner.
- Fix: `normalizeReasoningSummaryEntries` now only reads existing string entries or object `.text` fields and preserves text verbatim; the markdown-compaction helpers were deleted.
- Positive tests: `responses-sse-reasoning-summary-no-normalize.spec.ts` proves raw `- inspect \`file.ts\`\n\n> keep quoted detail` survives both `response.output_item.done` and `response.reasoning_summary_text.done`.
- Reverse tests/gates: `verify:sse-architecture-boundary` now forbids `collapseWhitespace`, `stripReasoningLinePrefix`, `compactReasoningSummaryBody`, `normalizeReasoningSummaryText`, and `**Thinking**` in the Responses generator.
- Verification: focused Jest `responses-sse-reasoning-summary-no-normalize + responses-sse-metadata-boundary` PASS 2/2; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 Responses sample replay succeeded with `reasoning_items=1`, `has_completed=true`, `has_done=true`, `has_error=false`, and canonical usage preserved.

### 2026-06-30 Responses JSON->SSE dead context state removed

- Red evidence: `responses-json-to-sse-converter.ts` created `ResponsesJsonToSseContext` with `responsesRequest: {} as any` and `outputItemStates: new Map()`, while source search showed no runtime consumer for either field.
- Fix: removed both fields from `ResponsesJsonToSseContext` and from `createResponseContext`; the converter context now only carries actually consumed response encode state.
- Positive tests: `responses-json-to-sse-context-no-dead-state.spec.ts` proves a completed response still projects `response.completed`.
- Reverse tests/gates: the same test and `verify:sse-architecture-boundary` forbid `responsesRequest: {} as any` and `outputItemStates: new Map()` from returning.
- Verification: focused Jest `responses-json-to-sse-context-no-dead-state + responses-json-to-sse-usage` PASS 4/4; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 Responses sample replay succeeded with `reasoning_items=1`, `has_completed=true`, `has_done=true`, `has_error=false`, and canonical usage preserved.

### 2026-06-30 Responses event serializer canonical-payload slice

- Red evidence: `responses-event-serializer.ts` still wildcard-serialized any `response.*` event and auto-built semantic payloads by adding missing `type`, wrapping scalar data as `{ value }`, and adding `sequence_number` from the event envelope.
- Fix: serializer now only accepts an explicit allowlist of Responses event types and only serializes object payloads whose `data.type` already matches the event type. Canonical payload materialization moved one step upstream to the Responses sequencer boundary so the serializer is pure wire formatting plus validation.
- Positive tests: focused JSON->SSE tests still produce `response.completed` / `response.done` for normal Responses payloads, and real 4444 sample replay re-encodes without missing `type`.
- Reverse tests/gates: `responses-event-serializer-no-salvage.spec.ts` proves missing payload type, scalar data, and unknown `response.*` event types fail-fast; `verify:sse-architecture-boundary` forbids wildcard `.type.startsWith('response.')`, `buildEventPayload`, payload type injection, scalar wrapping, and serializer-owned `sequence_number`.
- Verification: focused Jest `responses-event-serializer-no-salvage + responses-json-to-sse-usage + responses-json-to-sse-context-no-dead-state + responses-sse-reasoning-summary-no-normalize` PASS 13/13; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=false`, output count `2`, and canonical usage preserved.

### 2026-06-30 Responses SSE canonical payload moved to Rust

- Red evidence: after the serializer slice, `responses-sequencer.ts` still locally canonicalized payload semantics by inserting `data.type` and `sequence_number` before the writer.
- Fix: added Rust owner `responses_sse_event_payload::canonicalize_responses_sse_event_payload_json` plus NAPI export `canonicalizeResponsesSseEventPayloadJson`; TS sequencer now only calls `canonicalizeResponsesSseEventPayloadWithNative`.
- Positive tests: focused JSON->SSE tests still produce terminal `response.completed` / `response.done`; native unit test proves missing payload `type` and `sequenceNumber` are canonicalized by Rust.
- Reverse tests/gates: Rust rejects scalar payload and payload type mismatch; `verify:sse-architecture-boundary` forbids local TS canonicalization markers in `responses-sequencer.ts`.
- Verification: Rust focused `responses_sse_event_payload` PASS 3/3; native hotpath build PASS; focused Jest 13/13 PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `req_1782794868950_3m64se1xv` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=false`, `missingSequence=false`, output count `2`, and canonical usage preserved.

### 2026-06-30 Chat JSON->SSE usage alias fallback removed

- Red evidence: `chat.ts::normalizeChatUsage` accepted Responses-style `input_tokens` / `output_tokens`, camelCase `promptTokens` / `completionTokens` / `inputTokens` / `outputTokens` / `totalTokens`, and computed missing `total_tokens`, making the TS chat SSE generator a second usage-normalization owner.
- Fix: `normalizeChatUsage` now only accepts canonical chat fields: `prompt_tokens`, `completion_tokens`, and `total_tokens`. Missing canonical fields or legacy aliases fail into a `generation_error`; no alias fallback or total-token synthesis remains.
- Positive tests: `chat-sse-usage-roundtrip.spec.ts` still proves canonical chat usage is emitted in the final chat completion chunk and survives roundtrip.
- Reverse tests/gates: `chat-sse-usage-no-fallback.spec.ts` rejects Responses-style alias input and missing `total_tokens`; `verify:sse-architecture-boundary` now forbids alias markers and total-token synthesis in `event-generators/chat.ts`.
- Verification: focused Jest `chat-sse-usage-no-fallback + chat-sse-usage-roundtrip` PASS 16/16; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real chat sample `~/.rcc/codex-samples/openai-chat/ports/10000/req_1782778465399_hrxbpl3tz/provider-response_1.json` first materializes through `ChatSseToJsonConverter`, then re-encodes through `ChatJsonToSseConverterRefactored` with `has_done=true`, `has_error=false`, usage preserved as canonical `{"completion_tokens":38,"prompt_tokens":262815,"total_tokens":262846}`.

### 2026-06-30 Responses SSE response payload native owner slice

- Red evidence: `responses.ts` still owned `createResponsePayload` and local `normalizeUsage`, so Responses JSON->SSE terminal events kept a second TS payload/usage materialization path after serializer/sequencer canonicalization had moved out.
- Fix: added Rust owner `responses_sse_event_payload::normalize_responses_sse_response_payload_json` plus NAPI export `normalizeResponsesSseResponsePayloadJson`; `responses.ts` now calls `normalizeResponsesSseResponsePayloadWithNative()` and no longer contains local `createResponsePayload` / `normalizeUsage`.
- Positive tests: canonical Responses usage still projects into `response.completed`; missing usage remains omitted instead of synthetic zero-token usage.
- Reverse tests/gates: Rust rejects missing `created_at` and legacy `prompt_tokens` / `completion_tokens` usage aliases; `verify:sse-architecture-boundary` now forbids `function createResponsePayload(` and `function normalizeUsage(` in the Responses generator.
- Verification: Rust focused `responses_sse_event_payload` PASS 6/6; native hotpath build PASS; focused Jest `responses-json-to-sse-usage + responses-sse-usage-no-fallback + responses-event-serializer-no-salvage + responses-sse-reasoning-summary-no-normalize` PASS 15/15; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, output count `2`, and canonical usage preserved.

### 2026-06-30 Responses SSE error payload native owner slice

- Red evidence: `responses.ts::buildErrorEvent` still synthesized Responses `response.error` data locally with `message`, `type: internal_error`, and `code: generation_error`.
- Fix: added Rust owner `responses_sse_event_payload::build_responses_sse_error_payload_json` plus NAPI export `buildResponsesSseErrorPayloadJson`; TS now only creates the event envelope and calls `buildResponsesSseErrorPayloadWithNative(error.message)`.
- Positive tests: existing invalid usage / missing `created_at` tests still emit `event: response.error` with the same `generation_error` code through native payload owner.
- Reverse tests/gates: Rust rejects empty error messages; `verify:sse-architecture-boundary` forbids `"type: 'internal_error'"` and `"code: 'generation_error'"` in the Responses generator.
- Verification: Rust focused `responses_sse_event_payload` PASS 8/8; native hotpath build PASS; focused Jest `responses-json-to-sse-usage + responses-sse-usage-no-fallback + responses-event-serializer-no-salvage + responses-sse-reasoning-summary-no-normalize` PASS 15/15; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, output count `2`, and canonical usage preserved.

### 2026-06-30 Responses SSE reasoning summary native owner slice

- Red evidence: `responses.ts` still owned `normalizeReasoningSummaryEntries` / `normalizeReasoningSummaryField`, so reasoning summary `summary_text` materialization remained a TS semantic owner after markdown-compaction had already been removed.
- Fix: added Rust owner `responses_sse_event_payload::normalize_responses_sse_reasoning_summary_json` plus NAPI export `normalizeResponsesSseReasoningSummaryJson`; TS now only calls `normalizeResponsesSseReasoningSummaryWithNative()` and wraps returned entries in SSE event envelopes.
- Positive tests: native wrapper and JSON->SSE projection preserve raw summary text including markdown/backticks/spacing.
- Reverse tests/gates: `verify:sse-architecture-boundary` now forbids `function normalizeReasoningSummaryEntries(` and `function normalizeReasoningSummaryField(` in the Responses generator, preventing local TS summary owner revival.
- Verification: Rust focused `normalize_responses_sse_reasoning_summary` PASS; native hotpath build PASS; focused Jest `responses-sse-reasoning-summary-no-normalize + responses-json-to-sse-usage + responses-sse-usage-no-fallback + responses-event-serializer-no-salvage` PASS 16/16; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, and `reasoningItems=1`.

### 2026-06-30 Responses SSE output item descriptor native owner slice

- Red evidence: after adding gate markers, `npm run verify:sse-architecture-boundary` failed on `const itemDescriptor: Record<string, unknown>` and `...(outputItem as any)`, proving `responses.ts` still owned output item descriptor materialization.
- Fix: added Rust owner `responses_sse_event_payload::build_responses_sse_output_item_descriptor_json` plus NAPI export `buildResponsesSseOutputItemDescriptorJson`; TS now only calls `buildResponsesSseOutputItemDescriptorWithNative()` for `response.output_item.added/done` and wraps returned descriptors in event envelopes.
- Positive tests: Rust and Jest prove function_call `added` descriptors become in-progress with empty arguments, `done` descriptors keep complete item payloads, and reasoning summary remains verbatim through native summary normalization.
- Reverse tests/gates: Rust and Jest reject missing output item type instead of synthesizing an unknown descriptor; `verify:sse-architecture-boundary` now forbids the retired TS `itemDescriptor` markers from returning.
- Verification: Rust focused `responses_sse_output_item` PASS 3/3; native hotpath build PASS; focused Jest `responses-sse-output-item-descriptor-native + responses-sse-reasoning-summary-no-normalize + responses-json-to-sse-usage + responses-sse-usage-no-fallback + responses-event-serializer-no-salvage` PASS 20/20; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `outputAdded=2`, and `outputDone=2`.

### 2026-07-01 Retired responses stream semantics spec removed

- Red evidence: `tests/modules/llmswitch/bridge/responses-stream-semantics.spec.ts` imported `src/modules/llmswitch/bridge/responses-stream-semantics.js`, but the implementation was already physically deleted. Running the focused spec failed with module-not-found, proving the test was stale residue that would force resurrection of the retired TS stream semantics owner.
- Fix: physically deleted the stale spec instead of recreating `responses-stream-semantics.ts`; updated the transport closeout plan to mark that file as retired/deleted rather than a migration wrapper.
- Reverse gates: `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`, `tests/red-tests/server_responses_sse_business_module_contract.test.ts`, and `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` already lock `responses-stream-semantics` / `attachResponsesStreamSemanticsForHttp` against returning.

### 2026-07-01 Responses SSE terminal transport state moved to Rust

- Red evidence: focused `hub-pipeline-stage-residue-audit` failed because `responses-sse-bridge.ts` / `responses-sse-transport.ts` still exposed `updateResponsesContractProbeFromSseChunkForHttp` and imported native probe helpers; `handler-response-sse.ts` still kept TS `responsesSseBlockCarry` / `responsesContractProbe` / terminal booleans.
- Fix: added Rust/NAPI `updateResponsesSseTransportTerminalStateJson`; Rust now owns partial SSE block carry, probe update, and terminal observation. The TS handler stores only opaque transport state plus a boolean action result; `responses-sse-transport.ts` no longer imports or exports probe semantics.
- Positive / reverse tests: native export test covers split `response.completed` blocks; handler upstream-incomplete regression still emits `upstream_stream_incomplete` when the stream ends before terminal and does not emit it when terminal is split across chunks; residue audit locks bridge/transport against restoring old probe owner.
- Verification: native hotpath build PASS; focused Jest `native-exports.responses-sse-contract + handler-response-sse-upstream-incomplete + handler-response-utils.force-sse-json-responses + handler-response-utils.required-action-split-frame` PASS 21/21; `verify:responses-handler-single-bridge-surface` PASS; `verify:responses-sse-business-module` PASS; `verify:sse-architecture-boundary` PASS; sharedmodule/root `tsc --noEmit` PASS; `git diff --check` PASS.
- Replay: real 4444 sample `/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/req_1782794868950_3m64se1xv/provider-response_1.json` materializes then re-encodes with `completed=true`, `done=true`, `error=false`, `missingType=0`, `missingSequence=0`, `malformedWire=0`, and `eventCount=25`.
