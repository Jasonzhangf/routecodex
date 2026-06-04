# ServerTool / Stopless Lifecycle (servertool reenter, bounded)

## 1. Scope

This document defines the only valid lifecycle for:

- stop_message / stopless auto-continue
- stop schema gate / learned note write
- servertool followup reentry

Design goals:

1. Trigger logic stays in Chat Process response orchestration.
2. `stop_message_flow` execution path is servertool reenter through the same Hub Pipeline entry, not tmux/client injection.
3. `stop_message_flow` followup hops are normal tool-capable requests and may retrigger when their response ends with `finish_reason=stop`.
4. Loop safety is enforced by stopMessage `used/max_repeats` counters plus normal tool availability, not by disabling stopMessage on followup metadata.
5. Servertool has no private response protocol: it only executes local tool work on behalf of the client; the result returns through the normal response chain.
6. Response direction is provider/model inbound -> `HubRespInbound02Parsed` -> `HubRespChatProcess03Governed` -> `HubRespOutbound04ClientSemantic` -> client outbound.

## 2. Current Code Entry Points

- Request metadata resolution: `src/server/runtime/http-server/executor-metadata.ts`
- Followup dispatch: `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
- ServerTool orchestration (response side): `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- StopMessage handler: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- Response stage transition: `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`

## 3. Lifecycle (Approved Target)

1. Client request enters the normal request chain and reaches upstream through Hub Pipeline.
2. Provider/model response enters `resp_inbound`, then `resp_chatprocess`.
3. stopless matcher runs only on `HubRespChatProcess03Governed` chat standard state.
4. `finish_reason` must already be canonicalized to OpenAI-style chat finish reasons before stopless evaluation.
5. Servertool may execute local tool work or build a followup request only from this chat-process stage.
6. Followup reenters as a normal request and its response returns through the normal response chain.
7. If `finish_reason=stop`:
   - `/goal active` => skip
   - plan mode => skip
   - other cases => run schema gate and possibly build followup prompt
8. Dispatch `stop_message_flow` through servertool reenter with original request tools/semantics preserved; no tool list cleaning or history rewrite outside the latest followup turn.
9. Reenter success increments continuous valid-stop-schema budget only when the followup response is again `stop` with schema; missing schema does not count.
10. Non-stop responses, tool calls, or real progress reset the continuous stop budget.
11. Reenter failure is explicit/fail-fast through servertool followup error handling; do not hide it as client-visible success.
12. Main request response must include the materialized followup result on the same client stream/response chain.
13. When stop schema allows the final stop, `learned` may be written to project `note.md`; followup / invalid schema / missing schema / budget exhausted must not write memory.

## 4. Hard Rules

1. Servertool execution boundary:
- `stop_message_flow` must use servertool reenter and must not set `clientInjectOnly/clientInjectSource=servertool.stop_message`.
- servertool only replaces the client-side tool execution step; request reentry and response projection remain the same Hub Pipeline path as normal traffic.
- The servertool result may be `HubRespChatProcess03Governed`; it must enter `HubRespOutbound04ClientSemantic` only through `buildHubRespOutbound04FromHubRespChatProcess03`.
- Do not add servertool-specific response projection, hand-built Responses wrappers, or client-frame shortcuts.
- Other servertools follow their skeleton/profile policy.

### 4.1 Stop Schema / Stopless Budget Contract

- Stop schema parsing is semantic: only JSON objects that contain `stopreason` are schema candidates; earlier evidence/log JSON blocks are preserved and ignored for schema matching.
- Client-visible final summaries may include evidence that mentions `stopreason`, but explicit control schema blocks are stripped before response projection.
- Stop schema budget is a single consecutive-stop counter: missing schema, invalid schema, and `stopreason=2` continuation all consume the same budget.
- The third consecutive `finish_reason=stop` without a valid final stop schema stops the loop with a budget-exhausted summary. Valid `finished` or `blocked` schema clears stopless runtime state and may stop.
- Followup/client disconnect must share the live client abort signal through nested reentry; a disconnected client must fail-fast and must not continue servertool followup work.

1.1. Followup eligibility:
- `stop_message_flow` followup hops remain stopless-eligible while `used < max_repeats`; repeated schema failures must continue through bounded `:stop_followup` reentry instead of stopping after the first followup.
- `stopMessageFollowupPolicy` / `preserve_eligibility` is obsolete and must not appear in skeleton, runtime metadata, Rust decision context, or response projection.
- A missing stop schema is handled by bounded followup prompts. If the followup still stops without valid schema, it must re-enter until the single consecutive-stop budget is exhausted.
- Stop schema budget is consecutive across all stop schema failure kinds. A non-stop response, tool call, or real progress resets the counter; the third consecutive stop ends the loop.
- Do not change router-direct/provider selection to fix stopless continuation; stopless eligibility belongs to servertool dispatch + Rust stop-message decision only.

1.2. Stop schema / final-stop learned note:
- Stop schema includes `learned` as the model-provided “what was learned in past turns” text.
- Stop schema prompt must ask six diagnostic fields: target, process, evidence, `issue_cause`, `excluded_factors`, and `diagnostic_order`.
- Debug / outage / validation tasks must not stop after only listing target/process/evidence; they must also state likely cause, ruled-out factors, and next diagnostic order, or call tools to gather that evidence.
- Any system prompt / ai-followup prompt that asks the main model to produce a summary, final summary, stop explanation, completion report, or blocked report must require stop schema JSON in the same injected message.
- Missing stop schema consumes the same continuous stop budget as invalid/provided schema failures; budget state comes from `stopMessageState.stopMessageUsed`, not `serverToolLoopState.repeatCount`.
- Rust `stop-message-core` is the schema parse / gate truth; TS may only do the final file IO.
- `note.md` write is allowed only on `schemaGate.action=allow_stop` and non-empty `learned`.
- No write on followup, invalid schema, missing schema, budget exhausted, or reenter failure.

1.3. Chat-process stop gateway:
- Stopless/servertool gateway must inspect `HubRespChatProcess03Governed` chat payload, not provider raw payload and not client outbound/SSE payload.
- Anthropic `end_turn` / provider-native stop reasons must already be mapped into chat `finish_reason=stop` before stopless is evaluated.
- TS servertool shell may receive the Rust-provided chat-process payload for execution, but must not synthesize or fallback to client payload when it is missing.

2. Continue-execution stripping:
- `continue_execution` 的 tool_call 对客户端必须透明；响应侧在 chat process 的
  `resp_process_stage2_finalize` 统一剥离该 tool_call，并将对应 choice 的
  `finish_reason` 从 `tool_calls` 修正为 `stop`。

3. No fallback:
- No old session-based fallback compare.
- No daemon-only fallback for stopMessage matching.

4. Scope:
- All stopMessage state read/write keys are `tmux:<sessionId>`.

5. Trigger behavior:
- If tmux not ready at trigger time: clear stale state and skip followup (no loop).

## 5. Client Restart Rebinding (New Requirement)

When tmux client restarts and re-registers:

1. Registration updates daemon->tmux mapping immediately.
2. If previous stopMessage state exists under old tmux scope and the same daemon/client identity is re-registered with a new tmux session, migrate stopMessage binding to the new `tmux:<newSessionId>` scope.
3. Migration is atomic:
- copy state to new tmux scope
- delete old tmux scope state
4. If old tmux session is already gone and no valid rebind target exists, clean old state.

This prevents:

- trigger using stale scope
- inject lookup miss loops after client restart

## 6. Observability Requirements

Required logs:

1. stopMessage set parse:
- parse success/fail
- resolved session / request scope

2. stopMessage match:
- matched/miss
- reason
- scope

3. servertool followup:
- runtime action emitted from `HubRespChatProcess03Governed`
- origin snapshot selected
- followup requestId / routeHint / routeName
- reenter success/failure reason

4. response stage transition:
- post-servertool payload stage
- `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic` builder used when needed
- final entry-protocol shape (`/v1/responses` => `object=response`)

5. state mutation:
- set/override
- trigger used counter
- clear on failure
- reset on non-stop/tool-call progress

## 7. Validation Checklist

1. Provider/model response reaches `HubRespChatProcess03Governed` with canonical `finish_reason=stop`.
2. Stopless match emits servertool runtime action from chat-process stage only.
3. Followup body is built from origin snapshot and preserves entry endpoint, tools, model parameters, and latest stopless prompt.
4. Followup response reenters normal response chain and returns as post-servertool governed payload.
5. `/v1/responses` final response is projected by `buildHubRespOutbound04FromHubRespChatProcess03` and has top-level `object=response`.
6. Chat Completions final response remains chat completion shape and is not wrapped by Responses builder.
7. Missing `servertoolRuntimeAction.payload` fails fast; no fallback to client payload.
8. Client body does not contain internal metadata carrier, `__rt`, or snapshot/debug carrier; legal protocol `metadata` is allowed when it is client-visible data.
9. Reenter failure clears active state and does not create followup loop.
10. Non-stop servertools still execute through normal Hub Pipeline reentry path.
