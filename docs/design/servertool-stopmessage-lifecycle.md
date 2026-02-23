# ServerTool / StopMessage Lifecycle (tmux-only)

## 1. Scope

This document defines the only valid lifecycle for:

- `stopMessage`
- `clock` client injection
- `continue_execution` client injection

Design goals:

1. Trigger logic stays in Chat Process response orchestration.
2. Execution path is tmux stdin injection only.
3. `stopMessage` does not use nested reenter model requests.
4. State is scoped by `tmux:<sessionId>` only.

## 2. Current Code Entry Points

- Request metadata resolution: `src/server/runtime/http-server/executor-metadata.ts`
- Scope resolution: `src/server/runtime/http-server/clock-scope-resolution.ts`
- Injection implementation: `src/server/runtime/http-server/executor/client-injection-flow.ts`
- ServerTool orchestration (response side): `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- StopMessage handler: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- Routing state store (tmux scope selection): `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/store.ts`

## 3. Lifecycle (Approved Target)

1. Client starts via `routecodex codex` / `routecodex claude` inside tmux.
2. Client request carries tmux metadata (`tmuxSessionId` family fields / headers).
3. Server resolves tmux session and marks `clientInjectReady=true`.
4. User sends `<**stopMessage,...**>` instruction.
5. Chat-process parser saves instruction state under `tmux:<sessionId>`.
6. Model response reaches response orchestration.
7. StopMessage matcher runs in chat-process servertool stage.
8. If matched, build reviewer followup text.
9. Dispatch to client injection (tmux stdin) directly.
10. Injection success: increment `used`, keep/update state.
11. Injection failure: clear stopMessage state for that tmux scope, skip followup.
12. Main request must still complete (no request-level hard failure only because stopMessage inject failed).

## 4. Hard Rules

1. Split dispatch:
- Normal servertools (e.g. search/vision) may use `reenterPipeline`.
- `stopMessage/clock/continue_execution` must use client injection dispatcher only.

2. No fallback:
- No old session-based fallback compare.
- No daemon-only fallback for stopMessage matching.

3. Scope:
- All stopMessage state read/write keys are `tmux:<sessionId>`.

4. Set behavior:
- If tmux scope missing when setting stopMessage: drop set instruction, keep request normal.

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
