# 2026-03-09 hub-session-regression-review

Tags: routecodex, llmswitch-core, session-stability, matrix, hub-pipeline, regression-review, openai-responses

## Current review
- User confirmed the prior 400 tool-call pairing error is already fixed; this is no longer the active issue.
- Current priority is not further performance tuning. Current priority is: pass matrix and restore stable same-session token estimation/state persistence.

## Preserved from 2026-03-08 work
- `hub-stage-timing.ts` still exists.
- Inbound native fast-path related files are still present.
- `reasoning-normalizer.ts` still contains native-assisted normalization path.
- `hub-pipeline.ts` still carries session identifier extraction and request token estimation hook points.

## Regressed / missing
- `src/conversion/hub/process/chat-process-session-usage.ts` is missing in current worktree.
- `src/conversion/hub/response/provider-response.ts` no longer contains the earlier response-side session actual-usage backfill call.
- Request-side session delta logic no longer appears in current sources; current `hub-pipeline.ts` falls back to direct `computeRequestTokens(...)` only.
- Rust reasoning optimization in `rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/reasoning.rs` appears to have regressed to per-call regex construction and should be rechecked later, but it is not the current priority.

## Current failure signals from real traffic
- Same-session requests still fall back from delta estimate with reasons such as `missing_previous_usage`, `missing_state`, `parameters_signature_changed`, and `tools_signature_changed`.
- This is consistent with the session usage persistence path being partially or fully lost.
- User also reported matrix failure around native route-select capability loading; implementation may exist in Rust while export/loader wiring is broken.

## Immediate next steps
1. Restore session usage persistence as single source of truth:
   - request side reads prior session usage/state
   - response side writes actual upstream usage back into same session scope
   - stabilize signatures to avoid noisy fallback on unchanged sessions
2. Fix matrix native route-select capability export/loader path.
3. After session + matrix are stable, reduce release logging noise and keep only high-level internal/provider timing summaries.

## 2026-03-09 hotspot batch update
- Current active work temporarily shifted to the largest hub latency blocks before returning to matrix/session stabilization.
- Confirmed hotspot decomposition from live `/v1/responses` traffic before latest batch:
  - `req_inbound.stage1_reasoning_normalize`: ~3.8s-4.2s
  - `req_inbound.responses.capture_context`: regressed to ~5.0s, then reduced to ~28ms after reuse + no-reparse fixes
  - `req_inbound.responses.convert_input_to_messages`: ~5.3s and now the dominant inbound block
  - `req_outbound.stage1_mapper_from_chat`: ~4.0s-4.3s and still dominant on outbound path
- Restored / added request-path optimizations in llmswitch-core:
  - reused stage2 `responsesContext` in `hub-pipeline.ts` instead of recapturing in stage3
  - `captureResponsesContext(...)` stopped deep-cloning `payload.input`
  - Rust inbound context capture now preserves original `input[]` instead of re-normalizing via `input -> chat -> history`
  - request-side responses compat filters out redundant `reasoning.extract`
  - reasoning normalizer restored a TS-side marker scan to skip native work when no reasoning markup exists
  - Rust reasoning bridge switched back to static regex caching with a substring fast guard
  - responses-mode `convert_bridge_input_to_chat_messages(...)` now avoids reparsing already-normalized text content
- Latest measured improvement before this handoff:
  - hub total dropped roughly from ~18.4s to ~14.8s on the sampled request
  - `req_inbound.responses.capture_context` dropped from ~5019ms to ~28ms
  - remaining large blocks to revisit later: `convert_input_to_messages`, `stage1_reasoning_normalize`, `stage1_mapper_from_chat`
- Build verification and commit/push are the next required handoff steps for this batch.

- Final replay after build confirmed the hotspot batch landed correctly:
  - `req_inbound.stage1_reasoning_normalize`: ~2192ms
  - `req_inbound.responses.capture_context`: ~27ms
  - `req_inbound.responses.convert_input_to_messages`: ~29ms
  - `req_inbound.responses.inbound_policy`: ~33ms
  - `req_inbound.responses.build_chat_request`: ~73ms
  - `req_outbound.stage1_mapper_from_chat`: ~44ms
  - hub internal total: ~3200ms
  - provider send remained the dominant external cost at ~5840ms for the sampled request


## 2026-03-09 sub-1s follow-up
- After narrowing responses request-side reasoning normalization triggers, `req_inbound.stage1_reasoning_normalize` stopped appearing in release logs under the `25ms` threshold, which implies request-path renormalization is no longer a hub hotspot on the sampled traffic.
- Latest sampled `/v1/responses` replay after commit `6007378`:
  - `req_inbound.responses.capture_context`: 18ms-29ms
  - `req_inbound.responses.convert_input_to_messages`: 15ms-32ms
  - `req_inbound.responses.inbound_policy`: 23ms-36ms
  - `req_inbound.responses.build_chat_request`: 45ms-78ms
  - `req_process.stage1_tool_governance`: 79ms-134ms
  - `req_process.stage2_route_select`: 106ms-142ms
  - `req_outbound.stage1_mapper_from_chat`: ~49ms
  - first sampled hub total: ~1089ms
- Remaining work to reach sub-1s hub latency should shift from reasoning normalization to:
  1. `stage1_tool_governance`
  2. `stage2_route_select`
  3. minor outbound semantic-map overhead


## 2026-03-09 session-token-estimate restore
- Restored a minimal session-bound request token estimate path in `llmswitch-core`.
- Request side now tries `estimateSessionBoundTokens(...)` before falling back to full `computeRequestTokens(...)`.
- Session estimate rule is intentionally simple:
  - baseline = previous round saved `usage.total_tokens` (fallback to input/prompt tokens if total missing)
  - delta = `tiktoken` count of appended message slice only, based on previous saved message count for the same `session:` / `conversation:` scope
  - estimate = `baseline + delta`
- Response side now persists actual usage back into sticky session state synchronously so immediate same-session followups can reuse it.
- Persisted state fields added under routing instruction state storage:
  - `chatProcessLastTotalTokens`
  - `chatProcessLastInputTokens`
  - `chatProcessLastMessageCount`
  - `chatProcessLastUpdatedAt`
- Commit for this restore: `fd3b322 perf: reuse session usage for token estimation`


## 2026-03-09 validation after session-usage restore
- User replay after `fd3b322` showed hub-side latency is now below the original 1s target on sampled traffic.
- Observed same-session request after a prior response with real usage persisted:
  - `req_inbound.responses.capture_context`: 19ms
  - `req_inbound.responses.convert_input_to_messages`: 16ms
  - `req_inbound.responses.inbound_policy`: 25ms
  - `req_inbound.responses.build_chat_request`: 49ms
  - `req_process.stage1_tool_governance`: 85ms
  - `req_process.stage2_route_select`: 94ms
  - hub total: 564ms
- Another short-path replay in the same window completed hub in ~97ms.
- This indicates the combined hotspot work + session-bound token estimate restore no longer leaves hub as the dominant latency source on these traces; provider send is now clearly dominant.

