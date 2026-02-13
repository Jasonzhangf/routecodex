# Clock Client Daemon + Private Clock Marker Design (routecodex-119)

## 1. Background

Current clock scheduling relies on server-side followup/hold behavior. This works for long-lived connections, but cannot actively inject new user input into `codex` / `claude` terminals when the client side is uncontrollable.

We need a controlled path where:

1. `rcc codex` / `rcc claude` can optionally attach an input-capable client daemon.
2. Server-side clock expiration can notify that daemon.
3. The daemon injects a new message into client input and presses Enter.
4. Private clock syntax can be accepted and transformed into standard clock tool semantics.

## 2. Scope & Non-goals

### Scope

- Add a tmux-backed client daemon integration for launcher flows.
- Add local daemon registration/heartbeat/injection endpoints on RouteCodex server.
- Add private syntax parsing for `<**clock:{time,message}**>` in llmswitch-core request inbound process.
- Keep existing servertool clock behavior compatible.

### Non-goals (this phase)

- No cross-host daemon control.
- No new auth/session protocol beyond localhost guard.
- No natural-language/relative time parsing (`in 10m`) yet.

## 3. Key Decisions

1. **tmux transport first (transparent)**
   - If tmux is available, launcher auto-reuses current tmux pane or auto-creates a managed tmux session when user is outside tmux.
   - In non-tmux launches, launcher first tries to reuse unattached orphan `rcc_*` managed sessions whose panes are not currently running `codex`/`claude`; otherwise it creates a fresh managed session.
   - Users do not need to manually start tmux for advanced mode.
   - If tmux is not available, advanced service is disabled but normal server/client launching continues.

2. **Private marker format**
   - Support: `<**clock:{time,message}**>`
   - `time` must be ISO8601 absolute datetime in this phase.

3. **Parsing location**
   - Parse markers in llmswitch-core Hub inbound processing path.
   - Do not parse in provider layer or host transport layer.

4. **tool_call_id behavior**
   - If missing in clock tool path, generate one deterministically from request context and sequence.
   - Keep generated id consistently reused in tool outputs/messages.

5. **Daemon auth model**
   - Localhost-only access guard for daemon control endpoints.

6. **Clock inject session binding**
   - Daemon routing key is `tmuxSessionId` (tmux session domain), not conversation `sessionId`.
   - Conversation `sessionId` is bound separately to a tmux session in server registry (mapping domain separation).
   - Launcher appends daemon identity suffix to proxied api key (`::rcc-clockd:<daemonId>`).
   - HTTP auth middleware extracts daemon suffix and attaches `x-routecodex-clock-daemon-id` request hint.
   - Executor metadata binds `conversationSessionId -> daemonId/tmuxSessionId` deterministically before due injection tick.
   - `/daemon/clock-client/inject` remains strict and never falls back to unrelated alive daemons.

## 4. Architecture

### 4.1 Components

- **Launcher (`rcc codex/claude`)**
  - Detects tmux capability.
  - Starts/attaches client daemon if available.
- **Clock Client Daemon**
  - Maintains registration + heartbeat with server.
  - Executes `tmux send-keys` for injection + Enter.
  - Self-terminates when parent/client exits.
- **HTTP Server daemon routes**
  - Local control plane for register/heartbeat/inject/unregister.
- **llmswitch-core Hub parser**
  - Scans latest user content for private clock marker.
  - Converts marker into equivalent clock schedule semantics.

### 4.2 Sequence (happy path)

1. User runs `rcc codex`.
2. Launcher resolves tmux target (reuse current tmux when possible, else auto-create managed tmux session).
3. Daemon registers session metadata to server.
4. User/model creates clock schedule or marker-based schedule.
5. On due window, server triggers daemon injection.
6. Daemon injects message + Enter into tmux pane.
7. Client emits a normal request back; clock flow continues with tool semantics.

### 4.3 Degraded path

- tmux missing/unavailable:
  - Daemon path disabled.
  - Server/client remain functional.
  - Existing servertool followup behavior remains available.

## 5. Private Syntax Contract

### 5.1 Supported syntax

- `<**clock:{time,message}**>`

Example:

```text
please remind me
<**clock:{"time":"2026-02-11T09:30:00+08:00","message":"standup"}**>
```

### 5.2 Parse behavior

- Parse from user content during inbound process.
- On success:
  - Remove marker from user-visible content before upstream model processing.
  - Convert to standard clock schedule input shape.
- On parse failure:
  - Keep request safe and non-crashing.
  - Skip conversion for invalid markers.

## 6. Server Daemon Control Endpoints (localhost only)

- `POST /daemon/clock-client/register`
- `POST /daemon/clock-client/heartbeat`
- `POST /daemon/clock-client/inject`
- `POST /daemon/clock-client/unregister`

Payload fields include session/client type/tmux target/request id/injection text as needed.

### 6.1 External injection CLI

- Command: `routecodex tmux-inject` / `rcc tmux-inject`
- Common usage:
  - `rcc tmux-inject --port 5520 --list`
  - `rcc tmux-inject --port 5520 --text "hello" --tmux-session-id <tmuxSessionId>`
- Target resolution rules:
  - Prefer explicit `--tmux-session-id` (or legacy `--session-id` alias);
  - else resolve via `--daemon-id`;
  - else auto-select only when exactly one daemon session exists;
  - otherwise fail-fast and require explicit target.

## 7. Compatibility & Constraints

- Keep Provider V2 transport-only role unchanged.
- Keep host semantics minimal: no tool semantic repair in provider layer.
- Maintain existing servertool clock tests and behavior.

## 8. Testing Strategy

1. Baseline tests before implementation (done):
   - `tests/servertool/servertool-clock.spec.ts`
   - `tests/cli/smoke.spec.ts`
2. Add tests for:
   - marker parsing success/failure paths
   - tool_call_id fallback generation
   - launcher tmux available/unavailable branch
   - daemon route localhost guard and injection handling
3. Replay checks:
   - one affected provider replay
   - one unaffected control provider replay

## 9. Rollout

1. Introduce feature with default-safe degradation.
2. Monitor logs for registration/injection failures.
3. Keep fallback path active to avoid regression in non-tmux environments.


## 10. Runtime delivery loop (routecodex-125)

To ensure due tasks are actually delivered to the client input surface (not only stored in task files), host server adds a background inject loop:

- Source of truth: `clock/*.json` under server-scoped `ROUTECODEX_SESSION_DIR`.
- Runtime config parsing: delegated to llmswitch-core `resolveClockConfig` bridge API.
- Due reservation: delegated to llmswitch-core `reserveDueTasksForRequest` bridge API.
- Delivery path: host `ClockClientRegistry.inject({ sessionId, ... })`, where `sessionId` can be conversation ID and is resolved to mapped `tmuxSessionId`.
- Commit rule: call `commitClockReservation` only after successful daemon injection.

### 10.1 Lifecycle

- Start/restart loop on runtime setup (`setupRuntime`) to pick latest config and avoid stale timers.
- Stop loop on server shutdown (`stop`) to avoid orphan timer handles.
- Loop is best-effort and throttles repeated error logs.

## 11. clock_hold_flow followup provider pinning

Clock auto-hold followup is stateful and must stay on the same provider alias as the triggering request.

Fix:

- In llmswitch-core `servertool/engine.ts`, `clock_hold_flow` now shares the same forced-provider behavior as `stop_message_flow`.
- Followup metadata includes `__shadowCompareForcedProviderKey=<current providerKey>`.
- This prevents alias drift on `:clock_hold_followup` request-id suffix hops and avoids compatibility mismatch (e.g., Responses provider requiring `instructions`).

## 12. Verification evidence (this change set)

### 12.1 Automated

- `sharedmodule/llmswitch-core`: `npm run build` ✅
- RouteCodex targeted suite (via `npm run jest:run -- --runTestsByPath ...`) ✅
  - `tests/servertool/servertool-clock.spec.ts` (includes new provider pin regression)
  - `tests/server/http-server/clock-client-routes.spec.ts`
  - `tests/server/http-server/hub-policy-injection.spec.ts`
  - `tests/server/http-server/quota-view-injection.spec.ts`
  - `tests/cli/tmux-inject-command.spec.ts`
  - `tests/cli/codex-command.spec.ts`
  - `tests/cli/claude-command.spec.ts`
- `npm run build:dev` ✅
- `npm run install:global` ✅

### 12.2 Live local proof (daemon auto-inject)

Using a temporary server on port `5630` + mock callback daemon:

1. Register daemon with mapping `conversationSessionId=conv_clock_live -> tmuxSessionId=rcc_test_tmux`.
2. Schedule one due task for `conv_clock_live` in task-store.
3. Observe callback payload auto-arrival from server loop:

- `source: "clock.daemon.inject"`
- `tmuxSessionId: "rcc_test_tmux"`
- text includes `[Clock Reminder]` and scheduled task details.

4. `/daemon/clock-client/list` shows `lastInjectAtMs` updated.

## 13. Submit-key reliability hardening (routecodex-128)

Observed in live Codex tmux session (`rcc_codex_1770782906272_ac260d:0.0`):

- daemon text injection succeeded, but message stayed in compose box without being sent;
- manual `tmux send-keys Enter` immediately moved UI into `Working`, confirming target/session mapping was correct and failure was submit timing-related.

Fix applied in launcher daemon path:

- keep text injection and submit key as **two independent tmux commands**;
- after text injection, wait a short delay (`80ms`) before submit key dispatch;
- in daemon path, select submit key sequence with client-aware preference (`codex`/`claude`: `Enter` primary, fallback `C-m`/`KPEnter`);
- in launcher command bootstrap path, remove accidental `clientType` free variable and keep generic submit dispatch for shell command launch.

Validation:

- `npm run jest:run -- --runInBand --runTestsByPath tests/cli/codex-command.spec.ts tests/cli/claude-command.spec.ts tests/cli/tmux-inject-command.spec.ts` ✅
- `npm run jest:run -- --runInBand --runTestsByPath tests/server/http-server/clock-client-routes.spec.ts tests/server/http-server/executor-metadata.spec.ts tests/server/http-server/httpserver-apikey-env-resolution.spec.ts tests/utils/clock-client-token.spec.ts` ✅
- `npx tsc --noEmit` ✅

## 14. Precise trigger mode (routecodex-129)

Clock daemon delivery now runs in exact due-time mode by default:

- host daemon inject loop rewrites effective clock config to `dueWindowMs=0` before reservation;
- this prevents early-fire behavior from legacy wide due windows in request-driven paths;
- task is triggered only when `now >= dueAt` (subject to polling interval, i.e. may be slightly late but never early).

Reminder payload and manual injection CLI now both include explicit waiting guidance:

- `MANDATORY: if waiting is needed, use the clock tool to schedule wake-up (clock.schedule) now; do not only promise to wait.`

## 15. Recurrence + persistence + CRUD management (routecodex-130)

### 15.1 Standard recurrence contract

`clock` now supports recurring schedules with mandatory run caps:

- `daily` + `maxRuns`
- `weekly` + `maxRuns`
- `interval` + `everyMinutes` + `maxRuns`

All recurrence tasks are persisted in clock session files and tracked by `deliveryCount`.
Task lifecycle is driven by reserve/commit in llmswitch-core:

- on each successful delivery commit, `deliveryCount += 1`
- if `deliveryCount >= maxRuns`, task is removed
- otherwise, task is re-scheduled to the next due time

Current weekly behavior uses fixed `+7d` stepping.

### 15.2 Private marker syntax extensions

Private marker remains `<**clock:{...}**>`, now supporting recurrence fields in JSON form.

Examples:

```text
<**clock:{"time":"2026-02-12T09:00:00+08:00","message":"daily standup","recurrence":{"kind":"daily","maxRuns":5}}**>
```

```text
<**clock:{"time":"2026-02-12T09:00:00+08:00","message":"weekly report","recurrence":{"kind":"weekly","maxRuns":4}}**>
```

```text
<**clock:{"time":"2026-02-12T09:00:00+08:00","message":"poll status","recurrence":{"kind":"interval","everyMinutes":30,"maxRuns":8}}**>
```

Validation rule: if recurrence is present but invalid/missing required fields, marker scheduling is skipped (marker text remains unchanged).

### 15.3 Cleanup policy (tmux vs conversation session)

Two session domains are intentionally separated:

- **tmuxSessionId**: daemon/runtime delivery domain
- **conversation sessionId**: clock task persistence domain

Cleanup behavior:

- tmux session gone → auto cleanup daemon record + mapping + clear mapped conversation clock tasks
- conversation session gone but tmux still alive → do not auto-clean; use explicit admin cleanup command

### 15.4 Management APIs / CLI / WebUI

Added management endpoints:

- `GET /daemon/clock/tasks` (list)
- `POST /daemon/clock/tasks` (create)
- `PATCH /daemon/clock/tasks` (update)
- `DELETE /daemon/clock/tasks` (delete one / clear session)
- `POST /daemon/clock/cleanup` (`mode=dead_tmux|unbind`)

CLI management command:

- `rcc clock-admin --list`
- `rcc clock-admin --create --session-id <sid> --due-at <iso> --task <text> --recurrence interval --every-minutes 5 --max-runs 10`
- `rcc clock-admin --update --session-id <sid> --task-id <tid> --due-at <iso> --task "..."`
- `rcc clock-admin --delete --session-id <sid> --task-id <tid>`
- `rcc clock-admin --clear --session-id <sid>`
- `rcc clock-admin --cleanup-dead-tmux`
- `rcc clock-admin --unbind-session <conversationSessionId> [--clear-tasks]`

WebUI management entry:

- `GET /daemon/admin`
- use integrated `Clock` tab in `docs/daemon-admin-ui.html`

### 15.5 Tool update support

Clock tool now supports `action=update` (with `taskId` + `items[0]`) so models can modify existing reminders instead of creating duplicates.

### 15.6 Trigger precision and reminder guidance

Clock daemon inject loop uses exact due matching (`dueWindowMs=0`) to avoid early delivery.
Reminder payload includes guidance text:

- `MANDATORY: if waiting is needed, use the clock tool to schedule wake-up (clock.schedule) now; do not only promise to wait.`


### 15.7 Overdue auto cleanup

One-shot tasks are auto-removed after overdue grace window (default 60s, capped by retentionMs) to avoid stale backlog.
