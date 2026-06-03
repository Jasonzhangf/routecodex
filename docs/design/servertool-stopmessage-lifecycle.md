# ServerTool / Stopless Lifecycle (servertool reenter, bounded)

## 1. Scope

This document defines the only valid lifecycle for:

- stop_message / stopless auto-continue
- `clock` client injection
- `continue_execution` client injection

Design goals:

1. Trigger logic stays in Chat Process response orchestration.
2. `stop_message_flow` execution path is servertool reenter through the same Hub Pipeline entry, not tmux/client injection.
3. `stop_message_flow` followup hops are normal tool-capable requests and may retrigger when their response ends with `finish_reason=stop`.
4. Loop safety is enforced by stopMessage `used/max_repeats` counters plus normal tool availability, not by disabling stopMessage on followup metadata.

## 2. Current Code Entry Points

- Request metadata resolution: `src/server/runtime/http-server/executor-metadata.ts`
- Scope resolution: `src/server/runtime/http-server/clock-scope-resolution.ts`
- Followup dispatch: `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
- ServerTool orchestration (response side): `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- StopMessage handler: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- Routing state store (tmux scope selection): `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/store.ts`

## 3. Lifecycle (Approved Target)

1. Client starts via `routecodex codex` / `routecodex claude` inside tmux.
2. Client request carries tmux metadata (`tmuxSessionId` family fields / headers).
3. Server resolves tmux session and marks `clientInjectReady=true`.
4. stopless default state exists under `tmux:<sessionId>`.
5. Model response reaches response orchestration.
6. stopless matcher runs in chat-process servertool stage.
7. If `finish_reason=stop`:
   - `/goal active` => skip
   - `/goal non-active` => inject `继续执行`
   - non-`/goal` => inject `继续执行`
8. Dispatch `stop_message_flow` through servertool reenter with original request tools/semantics preserved.
9. Reenter success increments/persists `used`; if followup response again ends with `stop`, it may retrigger until `used >= max_repeats`.
10. Reenter failure is explicit/fail-fast through servertool followup error handling; do not hide it as client-visible success.
11. Main request response must include the materialized followup result on the same client stream/response chain.
12. When stop schema allows the final stop, `learned` may be written to project `note.md`; followup / invalid schema / missing schema / budget exhausted must not write memory.

## 4. Hard Rules

1. Split dispatch:
- `stop_message_flow` must use servertool reenter and must not set `clientInjectOnly/clientInjectSource=servertool.stop_message`.
- `clock` / explicit client-injection flows use client injection dispatcher.
- Other servertools follow their skeleton/profile policy.

1.1. Followup eligibility:
- The structural contract is `stopMessageFollowupPolicy=preserve_eligibility` on the `stop_message_flow` skeleton/profile and runtime carrier; flow names or source strings are not semantic permission.
- A followup hop may preserve stopMessage eligibility only when the runtime carrier exposes `stopMessageFollowupPolicy=preserve_eligibility`; missing policy defaults to `disable` and generic followups use `skip_servertool_followup_hop`.
- Preserved stop-message followup metadata must not contain `stopMessageEnabled=false` or `routecodexPortStopMessageEnabled=false`, including inside `__rt`.
- Rust `stop-message-core` must allow followup eligibility only from `stop_message_followup_policy=preserve_eligibility`, not from `followup_flow_id` string matching.
- Do not change router-direct/provider selection to fix stopless continuation; stopless eligibility belongs to servertool dispatch + Rust stop-message decision only.

1.2. Final-stop learned note:
- Stop schema includes `learned` as the model-provided “what was learned in past turns” text.
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
- resolved tmux scope

2. stopMessage match:
- matched/miss
- reason
- scope

3. client injection:
- selected tmux session
- submit key result
- success/failure reason

4. state mutation:
- set/override
- trigger used counter
- clear on failure
- rebind migration (old scope -> new scope)

## 7. Validation Checklist

1. Set stopMessage in tmux session A -> state key is `tmux:A`.
2. Trigger matched response -> tmux A receives injected text + enter.
3. Counter decrements and persists.
4. Restart client with new tmux session B (same client identity) -> state migrates to `tmux:B`.
5. Next trigger injects into B, not A.
6. Injection failure clears active state and does not create reenter loop.
7. Non-stop servertools still execute through normal reenter path.
