# RCC Internal Hooks Sidecar Contract

Status: implementation slice landed in `routecodex-v3-hooks` with install wiring.

## Purpose

This contract is the RCC-side typed boundary for the optional hooks sidecar daemon. It replaces the external `codex-hooks` daemon as the production source of truth.

## Ownership

- `routecodex-v3-hooks`: typed contract, pure gates, native App Server transport, control server, persistent delivery ledger, schedules, mounted handler registry, and `rccv3-hooksd`.
- RCC managed lifecycle: optional startup and `hooks_unavailable`.
- Install scripts: `rccv3-hooksd` is copied beside `rccv3` in `dist/bin` and into the install bin directory, and the npm package bin map exposes `rccv3-hooksd`.
- App Server: only Codex default TUI/Desktop App Server.
- tmux may host a TUI process, but it is not a message channel. Sending, status
  reads, and continuation reads use the App Server control socket only.

## Types

```text
HooksUnavailableReason  -> disabled | missing | timeout | invalid_readiness | crashed
Namespace               -> codex_tui | codex_app
SessionTarget           -> namespace + appserver_id + scope_id + session_id + thread_id
SendMode                -> idle_only | working_allowed
MessageIntent           -> intent_id + source + target + body + send_mode
DeliveryState           -> accepted | delivered | executed | replied | read
DeliveryEvidenceRecord  -> intent_id + message_id + state + cursor + read_item_id + start_error?
HookDecision            -> no_op | send_message(MessageIntent)
HookEvent               -> event_name + hook_kind + source
HookState               -> status + detail
ScheduledMessage        -> id + at_iso8601 + registrant + body + send_mode
AppServerTransport      -> session_status + send_message trait boundary
```

## Pure gates already covered by tests

- Sidecar missing/timeout/crash format as `hooks_unavailable:<reason>`.
- `rccv3-hooksd --once` emits `rcc-hooks-sidecar/v1` readiness JSON.
- Unknown hook kind without mounted handler fails closed.
- Accepted queue receipt cannot be promoted to reply/read.
- Read evidence requires replied evidence.
- Timer sends back to registrant.
- Handler errors are not silently dropped.
- RouteCodex lifecycle optional startup keeps runtime control resources on
  hook sidecar failure and records `hooks_unavailable:<reason>` in status
  detail instead of failing the managed server.
- A stale or identity-mismatched hooks process record degrades to
  `hooks_unavailable:<reason>` at startup, reap, and forced-stop boundaries. It
  never aborts RouteCodex startup, and the strict identity probe still refuses
  to signal a foreign process group.
- Forward gate rejects source == target and preserves distinct sessions.
- `HooksSidecarCore` sends forward through `AppServerTransport`, defers
  `idle_only` while target is working/input-active, and fails closed on
  unknown/disconnected targets.
- Hook event dispatch without a mounted handler fails closed.
- `ControlRequest` / `ControlResponse` define the sidecar control boundary.
- `HooksSidecarCore` stores schedules and returns due intents to registrants.
- `HooksSidecarCore::run_due_schedules` removes fired schedules and sends the
  timer intent back to the registrant through the same typed send path.
- `rccv3-hooksd --socket <path>` starts a Unix JSON-lines control server and
  only prints readiness after the control socket is bound.
- The control server drives a 1s timer tick against the shared core and
  handles each control connection on its own thread, so an idle client cannot
  starve timers.
- Control server health and shutdown round-trip are covered by a real Unix
  socket test.
- Control-socket bind never unlinks an existing path: `ControlServer` binds
  directly and fails `AddrInUse` when any path is present, so a second daemon
  can never remove a live daemon's socket. Stale-socket cleanup is owned by the
  lifecycle start path, which removes a leftover control socket only after it
  has verified the persisted process-group identity and confirmed the previous
  group is dead. The stop path removes the socket only after the owned group is
  confirmed stopped. Covered by
  `control_server_refuses_to_hijack_live_socket`.
- Handlers mounted through `ControlRequest::MountHandler` are persisted and
  re-mounted on restart through the same `mount_handler_config` path, so a
  persisted handler dispatches after restart instead of failing closed.
  Covered by `control_mounted_handler_survives_state_restart`.
- `ControlRequest::DeliveryEvidence` resolves native receipt/reply state for a
  previously accepted intent; `ControlRequest::RunDueSchedules` exposes the
  same timer path for deterministic integration tests.
- `HookHandler` is a typed mount boundary; `HookRegistry::mount_handler`
  dispatches event/state into a mounted handler, unmapped hook kinds fail
  closed, and handler errors are returned without being swallowed.
- `HooksSidecarCore::dispatch_hook_event` routes a `SendMessage` hook decision
  through the standard send gate instead of bypassing message delivery.
- Delivery evidence records only states the transport actually observed.
  Receipt correlation yields `delivered`; a correlated assistant reply yields
  `replied`; a history pagination cursor is not a read observation, so a normal
  history page cannot promote the intent to `read`. `read` requires an explicit
  native read receipt tied to the reply; the current native transport does not
  synthesize either that receipt or `executed`. A `toolMessage` remains
  execution evidence only and cannot promote an intent.
- Native App Server request shapes are captured in Rust:
  `initialize`, `thread/read`, `thread/loaded/list`, `thread/queue/add`,
  `thread/queue/start`, `thread/timeline/list`, `thread/items/list`.
- Native transport after `thread/queue/add` calls `thread/queue/start` so idle
  dispatch begins the queued user message. If the App Server already auto
  dispatched the item, `thread/queue/start` returns a JSON-RPC error whose
  message is `queued submission not found: <id>`; the transport treats only
  the exact JSON error tail (`queued submission not found: <id>"}`) as the
  already-dispatched race and still records queue acceptance, never
  delivery/reply. Covered by
  `native_transport_accepts_queue_start_auto_dispatch_race`.
- After `thread/queue/add` accepts a submission, any `thread/queue/start`
  error keeps the accepted receipt and does not record the intent as failed.
  The exact start error is retained on the accepted delivery evidence and the
  intent's persisted error field, so delivery evidence can remain unresolved
  instead of fabricating a pre-acceptance failure. Covered by
  `native_transport_keeps_acceptance_when_queue_start_errors_after_queue_add`.
- History baseline and delivery correlation prefer `thread/timeline/list`;
  older `thread/items/list` and `thread/turns/list` fallbacks remain for
  compatible App Servers that do not implement the canonical timeline.
- `NativeBaselineState::Unavailable` preserves missing history observations so
  queue submission stays usable but delivery evidence cannot be fabricated
  when no compatible history method exists. The unavailable state remains bound
  to the accepted intent even if a later evidence poll can read history; the
  intent must be retried through a new accepted attempt rather than promoted
  from an untrusted baseline.
- `HooksSidecarCore::delivery_evidence` always correlates against the persisted
  baseline snapshot recorded by the send, not an advisory caller-supplied
  baseline. This prevents a caller from replacing an unavailable or empty
  persisted baseline with fabricated history. Covered by
  `native_transport_keeps_unavailable_baseline_bound_against_caller_baseline`.
- `normalize_session_state` maps native thread state to typed `SessionState`.
- Native delivery evidence captures a pre-send baseline, sends with
  `clientUserMessageId`, then maps a new correlated `userMessage` receipt to
  `delivered` and a same-turn `agentMessage`/`assistantMessage` reply to
  `replied`. A `toolMessage` is execution evidence, not an assistant reply, so
  it cannot promote the intent to `replied`. Queue acceptance alone still
  yields only `accepted`.
- A minimal Unix WebSocket JSON-RPC client is implemented for the native App
  Server transport. Frame encode/decode round-trip is covered by Unix socket
  pair tests.
- Native transport now performs the reference `initialize` then `initialized`
  notification before App Server RPC calls; without this the Desktop App
  Server rejects calls with `Not initialized`.
- If `thread/read includeTurns` is unsupported, native transport falls back to
  the basic `thread/read` identity/status plus `thread/items/list` and
  `thread/turns/list` instead of blocking the send before `thread/queue/add`.
- `rccv3-hooksd --once --probe-appserver <socket>` outputs JSON evidence for
  native `thread/loaded/list`.
- `rccv3-hooksd --socket <path> --appserver-socket <path>` can now run the
  control server with `NativeAppServerTransport`; without it the control
  server stays fail-closed via `AnyAppServerTransport::Disabled`.
- RCC lifecycle optional startup now prefers an installed `rccv3-hooksd` from
  `bin_directory`, starts it with a control socket and optional
  `appserver_socket` from the install record, and accepts its
  `rcc-hooks-sidecar/v1` readiness record.
- RCC lifecycle failure injection covers internal `rccv3-hooksd` binary
  missing, crash-before-readiness, and readiness-timeout paths. Each reports
  `hooks_unavailable:<reason>` and preserves runtime control resources. If the
  failed attempt created the internal control socket, the lifecycle removes
  that socket only after the owned process group is confirmed stopped, so the
  next start does not fail with `AddrInUse`.

## Next workstreams

1. Live TUI/Desktop same-entry replay with native receipt/reply/read evidence.
   The default shared App Server exposes both TUI and Desktop clients; TUI/TUI
   forward and mounted-handler replay now reach `replied`. The daemon protocol
   schema exposes no explicit read or acknowledgement method, so `read` remains
   an explicit capability gap and is not synthesized. `executed` is likewise
   not claimed unless the native item sequence supplies an explicit execution
   observation.
2. If a separate adaptive `rccv3-codexapp` bin is later required by product
   contract, it must wrap the same native transport used by `rccv3-hooksd`
   instead of creating a second runtime.

## Test evidence

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks`:
  63 lib tests, 3 `binary_handler_config` tests, 1 `binary_readiness` test,
  and 11 `native_delivery_replay` tests pass.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks
  --test native_delivery_replay`: an end-to-end replay against a mock App
Server that speaks the real Unix WebSocket JSON-RPC protocol proves
  `thread/queue/add` acceptance and `thread/queue/start`, proves the exact
  already-dispatched race is accepted without claiming delivery, proves
  `thread/timeline/list` receipt/reply correlation, proves a normal pagination
  cursor does not promote the state beyond `replied`, proves a receipt without
  a reply stops at `delivered`, proves the timer fires through the core and
  sends back to the registrant, and proves the running control server's timer
  tick delivers a due schedule through the native transport. The mock is a
  protocol fixture only;
  production still talks only to the Codex default TUI/Desktop App Server.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-lifecycle --lib`:
  67 tests pass, including internal `rccv3-hooksd` missing/crash/timeout
  degradation and stale/identity-mismatched hooks record handling. Startup
  admission never blocks on the optional sidecar. Stop, restart, reap, and
  forced stop also complete the main RouteCodex lifecycle when hooks cleanup is
  degraded; a hooks process record is preserved only when cleanup cannot be
  completed with persisted ownership evidence, including a live group or an
  unverified control socket. The strict identity probe still refuses to signal
  a foreign process group. Status writes use a bounded `flock`, and a hooks
  supervisor that exceeds the stop timeout is aborted instead of being left as
  an unbounded background task. The forced-cleanup path consumes the persisted
  record before deleting it: the internal `hooks-sidecar.sock` is removed only
  through its recorded identity, and legacy-supervisor codexapp socket cleanup
  is persisted with its startup identity so a dead process group cannot strand
  an owned socket without a record to verify it.

### Process-group anchor lifetime

### Control socket ownership

### Transport selection

### WebSocket handshake framing

`upgrade_websocket` reads the HTTP 101 response directly from the byte stream
one byte at a time, not through a `BufReader`. A buffered header reader can
over-read past the terminating blank line and buffer the first WebSocket frame
when the App Server coalesces the handshake response and first frame into one
write; dropping that reader would discard the frame and stall the first
JSON-RPC call. Reading unbuffered leaves every post-handshake byte on the socket
for the frame decoder. The client sends every control frame through the masked
client-frame encoder, including the Pong returned for an App Server Ping.
Verified by
`websocket_upgrade_preserves_first_frame_coalesced_with_handshake`: the buffered
reader hangs (frame lost), the unbuffered reader returns the frame.

`rccv3-hooksd` selects its transport from the actual App Server socket
configuration (`AppServerSocketConfig::has_any_socket`), not from whether a
handlers config was supplied. A handler-only configuration still mounts its
handler registry and persisted state, but uses the disabled transport, so a
`send_message` decision fails closed with an explicit socket-missing error
instead of constructing a native transport with no socket to reach. This is
covered by `binary_handler_only_config_has_no_native_socket_and_fails_closed_on_send`.

`ControlServer` binds its Unix control socket through `bind_control_socket`,
which sets mode `0600` immediately after bind and removes the path if the
permission change fails. The control boundary exposes `mount_handler`,
`forward_message`, schedule mutation, `intent_evidence`, and `shutdown`, so it
must not be reachable by group or other local users. This is enforced by the
unique `ControlServer` owner rather than relying on the process umask or a
private parent directory. Verified: a default `UnixListener::bind` under umask
`022` yields mode `0755`, while the control socket yields `0600`
(`control_server_binds_socket_owner_only`).

The lifecycle-owned anchor (`/bin/sh -c "trap '' TERM INT; trap 'exit 0' USR1;
read -r line"`) is spawned with `Stdio::piped()` and its `Child` is retained in
`V3HooksSidecarProcess.group_leader`. Because the retained `Child` owns the
`ChildStdin` write end, the `read -r line` anchor blocks and stays alive; the
pipe closes only when the `Child` is dropped at explicit stop. A minimal
reproduction confirmed both directions: holding the `Child` keeps the leader
alive past readiness, and dropping its stdin makes the anchor exit on EOF.
`internal_hooksd_anchor_leader_stays_alive_through_readiness_and_stop` pins the
real start path: after `start_configured_hooks_sidecar` returns, the recorded
leader PID is still alive and the owned group is alive; after `stop`, the whole
owned process group is gone. The startup-failure path is pinned by
`internal_hooksd_start_failure_removes_control_socket_after_owned_group_stops`:
the first start binds the control socket and crashes before readiness, the
socket is removed, and the second start succeeds instead of returning
`AddrInUse`. Temporarily disabling the cleanup makes that test fail at the
missing-socket assertion, proving the regression test is sensitive to the
fixed behavior.
- `CARGO_NET_OFFLINE=true cargo clippy --locked -p routecodex-v3-lifecycle
  -p routecodex-v3-hooks --all-targets`: 0 errors; the only warnings are the
  pre-existing `TEST_ENV_LOCK` held-across-await test pattern shared with
  `v3/crates/routecodex-v3-lifecycle/src/tests.rs`.
- `npm --prefix v3 run verify:v3-resource-map` and
  `npm --prefix v3 run verify:v3-mainline-caller-flow`: pass.
- `npm --prefix v3 run verify:v3-module-boundaries` and
  `npm --prefix v3 run verify:v3-architecture-docs`: fail only on the
  pre-existing, unmodified
  `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`
  finding; hooks-sidecar paths are clean.
- `npm --prefix v3 run verify:v3-file-size`: still fails only on pre-existing
  unrelated `routecodex-v3-runtime` files listed in the run output; the
  internal hooks sidecar files are within the policy limit.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-lifecycle
  internal_hooksd_tests -- --nocapture`: 7 pass, covering installed binary
  startup, missing binary, namespace socket/handler config propagation,
  readiness timeout, crash-before-readiness, and stale/identity-mismatched
  hooks record degradation.
- `node --test v3/tests/scripts/v3-cli-distribution.spec.mjs`: 5 pass for
  install/copy/pack distribution including `rccv3-hooksd`.

The exact commands, exit codes, and counts are recorded in "Mapped gate
receipts" below.

## Real App Server probe evidence

- Desktop App Server socket exists:
  `/Users/fanzhang/.codex/app-server-control/app-server-control.sock`
- Desktop probe result:
  `{"appserver_socket":"...","loaded_threads":["01a09634-4031-73f0-90df-11a03e0325eb"],"ok":true,"probe":"appserver","protocol":"rcc-hooks-sidecar/v1"}`
- Live TUI threads are registered through the same default App Server socket:
  `01a09ebb-28e5-77c2-91f7-bfa88aad26de` (TUI A),
  `01a09ebf-428b-7793-9668-45961f6d8444` (TUI B).
- Control `SessionStatus` reads real thread state for all three live threads:
  TUI A idle, TUI B idle, Desktop thread idle.
- TUI App Server socket currently missing:
  `/Users/fanzhang/.codex/tui-appserver-20260908/app-server-control.sock`
- TUI probe result is fail-closed:
  `ok:false`, error `app server socket missing ... No such file or directory`

This probe is native transport evidence only. It does not prove message
delivery, execution, reply, or read closure.

## Live App Server replay evidence

### Replay on the shared default App Server (2026-09-15)

Replayed against the real Codex default App Server daemon socket
`/Users/fanzhang/.codex/app-server-control/app-server-control.sock` using the
rebuilt candidate `rccv3-hooksd` control socket
`/tmp/rcc-hooks-live-20260915c.sock`. The App Server daemon reported version
`0.153.4`; the attached TUI clients reported CLI version `0.154.0`. No App
Server was self-hosted and no production RouteCodex process was restarted.

```text
live threads
  TUI A   01a0a830-65c5-7d40-9a30-c6dc9b80552f
  TUI B   01a0a830-75c9-7491-993f-e160b6203d3d

forward_message A -> B (idle_only)
  intent RCC_LIVE_FORWARD_C2B_20260915C
    queue/add accepted  -> queued submission id 01a0a8a2-5076-7e10-adc1-2738c6fdc1ee
    delivery evidence   -> replied, native message id 01a0a8a2-57f0-7c32-93a4-ef6ab8a62f4c
  target pane reply     -> RCC_LIVE_FORWARD_ACK_B_20260915C

timer register -> due -> send back to registrant (B)
  schedule RCC_LIVE_TIMER_20260915C at 2026-09-16T05:06:40Z
  intent timer:RCC_LIVE_TIMER_20260915C:2026-09-16T05:06:40Z
    queue/add accepted  -> queued submission id 01a0a89c-4c17-7eb2-9584-fa3ed3824058
    delivery evidence   -> replied, native message id 01a0a89c-580a-7252-8954-dccbc76491ee
  target pane reply     -> RCC_LIVE_TIMER_ACK_B_20260915C

mounted handler control path
  mount_handler(live_noop_c) -> mounted
  dispatch_hook_event(live_noop_c) -> no_op
  dispatch_hook_event(no_handler_c) -> fail closed: no handler mounted for hook kind no_handler_c
```

Both live rows record queue acceptance separately from native receipt/reply
correlation. The delivery-evidence probe correlated a native user-message
receipt with a same-turn assistant reply and returned `replied`; neither row
claims `executed` or `read`. The default daemon's canonical history method was
`thread/timeline/list`, while `thread/read includeTurns` supplied the initial
baseline identity/status path.

- TUI A -> TUI B message was delivered through the default App Server socket:
  `thread/queue/add` accepted, target TUI showed the message, target replied
  `RCC_HOOKS_LIVE_TUI_OK_2`. The original replay used the old correlation
  implementation, which stopped at `accepted -> replied` with native message
  id `01a09f1d-909d-7a41-a132-a0b74343edc7` and did not retain a cursor; that
  historical run does not claim `read`. The current correlation path also
  refuses to promote a history pagination cursor to `read`, and that boundary
  is covered by the native replay tests above.
- TUI -> Desktop queue submission was attempted through the same default App
  Server socket and failed before queue acceptance with the exact capability
  gap:
  `list_turns is not supported yet`.

The transport no longer depends on `thread/items/list` or `thread/turns/list`;
it first tries `thread/read` with `includeTurns` so Desktop-style App Servers
that reject read-listing methods can still supply turn payloads where
supported. The real Desktop daemon currently rejects that call, so Desktop
reply/read closure remains unverified.

### Rejected read-evidence candidate (2026-09-16)

A candidate `rccv3-hooksd` was replayed against the real Codex default App
Server daemon socket
`/Users/fanzhang/.codex/app-server-control/app-server-control.sock` using the
control socket `/tmp/rcc-hooks-live-20260916.sock` and the live TUI threads
`01a0a830-65c5-7d40-9a30-c6dc9b80552f` (A) and
`01a0a830-75c9-7491-993f-e160b6203d3d` (B). It recorded `read` for
`RCC_LIVE_READ2_20260916` and `RCC_LIVE_HOOK_FWD2_20260916`, each with a
`backwardsCursor`/`nextCursor` value and a `read_item_id` taken from the reply.

Independent review rejected that promotion: a history pagination cursor is
page-traversal metadata, not an explicit native read receipt, and
`read_item_id` cannot be synthesized from `reply.id`. Those rows are therefore
recorded as rejected evidence, not as `read` closure. The promotion, the
`NativeBaselineSnapshot.cursor` field, and the cursor argument to
`correlate_delivery_evidence` have been removed; the current source stops at
`replied`. Desktop reply/read closure remains unverified because the Desktop
App Server still rejects the history-read attempt.

### Same-entry replay on the rebuilt candidate (2026-09-16)

Replayed the current source through the rebuilt `rccv3-hooksd` control socket
`/tmp/rcc-hooks-live-r21.sock` against the real Codex default App Server
socket. Two fresh TUI clients were attached with
`codex --remote unix:///Users/fanzhang/.codex/app-server-control/app-server-control.sock`
and registered as threads `01a0aa44-e69a-7a71-9b1e-73f4b0ea8820` (A) and
`01a0aa45-5cf9-7c03-822e-7d35bc449b5c` (B). The A-to-B forward
`RCC_LIVE_R21B_20260916` was accepted by `thread/queue/add` as
`01a0aa46-49ce-77d2-a230-81455e98f8cb`, and target TUI B replied `READY`.
Delivery evidence then returned `delivery unresolved`: the current default
daemon rejected `thread/read` (`-32601 list_turns is not supported yet`),
`thread/timeline/list`, `thread/items/list`, and `thread/turns/list`
(`-32601 list_turns is not supported yet`). This run reached `accepted` and
observed the target reply, but no history-read method is available for these
fresh threads at the moment of the evidence poll, so native receipt/reply
correlation and any `read` claim were unavailable for that attempt. A later
raw WebSocket probe on the same daemon socket reached the same thread after it
had materialized and returned all history methods successfully, so this was a
transient fresh-thread materialization race rather than a permanent daemon
capability gap. The unresolved attempt remains recorded as unresolved; it is
not retroactively promoted to `replied` or `read`.

### Live closure on the rebuilt candidate (2026-09-16)

The current source was replayed through the rebuilt `rccv3-hooksd` control
socket `/tmp/rcc-hooks-live-r22.sock` against the real Codex default App Server
socket. Two fresh TUI clients were attached with
`codex --remote unix:///Users/fanzhang/.codex/app-server-control/app-server-control.sock`
and registered as threads `01a0aa58-0ef3-7ac0-bcac-065ce0fa05e3` (A) and
`01a0aa58-d41a-75d1-9b1a-4378e05363e2` (B). Once the target thread had
materialized, the daemon's canonical history method supplied the pre-send
baseline and the post-send receipt/reply correlation.

```text
forward_message A -> B (working_allowed)
  intent RCC_LIVE_R23_20260916
    queue/add accepted  -> queued submission id 01a0aa5b-a343-7c73-8b0d-cdbf6d8284d5
    delivery evidence   -> replied, native message id 01a0aa5b-afed-7f51-aa88-4d5d7792ce5f
  target pane reply     -> READY23

mounted command handler -> dispatch -> send -> reply
  mount_handler(rcc-live-command-r24) -> mounted
  dispatch_hook_event(rcc_live_r24)
    decision            -> sent(accepted), queued submission id 01a0aa65-ea53-7323-b667-60bb8bbd4d9b
    delivery evidence   -> replied, native message id 01a0aa65-f307-7552-b2f1-74f63614e5b2
  target pane reply     -> HANDLER24
```

Both rows record queue acceptance separately from native receipt/reply
correlation. `intent_id` and native `message_id` remain consistent across the
send receipt, persisted intent evidence, and delivery-evidence response.
Neither row claims `executed` or `read`: this daemon does not expose an
explicit native read receipt, and the current source does not synthesize one
from history pagination or from the assistant reply id.

The same rebuilt sidecar then attempted a mounted-handler TUI -> Desktop
forward to the loaded Desktop thread
`01a09634-4031-73f0-90df-11a03e0325eb`. The Desktop thread remained `working`
with an active or pending turn throughout six status/evidence polls over 90
seconds:

```text
mounted command handler -> TUI -> Desktop
  intent RCC_LIVE_TUI_DESKTOP_R25_20260916
    queue/add accepted  -> queued submission id 01a0aa6a-673e-7d20-8f5d-477967f0e78c
    queue/start error   -> -32600 thread already has an active or pending turn
    delivery evidence   -> unresolved: no native receipt found
```

This is recorded as `accepted` plus an explicit target-state failure, not as
delivered, replied, or read. The sidecar preserved the accepted receipt and
the exact `queue/start` error rather than promoting or silently retrying it.

## Live replay on the shared default App Server (2026-09-14)

Replayed against the real Codex default App Server daemon socket
`/Users/fanzhang/.codex/app-server-control/app-server-control.sock` using the
candidate `rccv3-hooksd`. Two TUI clients were attached with
`codex --remote unix://<socket>`; the Desktop daemon served the same socket.
No App Server was self-hosted, and no production RouteCodex process was
restarted.

```text
live threads
  TUI A   01a0a06b-074f-7582-8a1a-47375548c0ed
  TUI B   01a0a06c-d27a-78b2-b651-7d9efee5839c
  Desktop 01a09634-4031-73f0-90df-11a03e0325eb

session_status (live)
  TUI A   -> state idle
  TUI B   -> state idle
  Desktop -> state idle

forward_message A -> B (idle_only)
  intent RCC_LIVE_A2B_0914   queue/add accepted -> replied, native message id 01a0a06d-a556-7480-8dc3-cca54beb8ba4
  intent RCC_LIVE_A2B_0914b  queue/add accepted -> replied, native message id 01a0a072-43f5-7302-b269-a095f715f9b7

same-entry hook -> handler -> send -> reply (mounted stop handler, target B)
  intent RCC_LIVE_HOOK_B_0914 dispatch decision sent(accepted) -> replied, native message id 01a0a073-5345-7471-b384-a378f42c71f5

timer register -> due -> send back to registrant (B)
  schedule RCC_LIVE_TIMER_0914 at 2026-09-14T15:05:38Z
  intent timer:RCC_LIVE_TIMER_0914:2026-09-14T15:05:38Z -> replied, native message id 01a0a074-6209-7712-8fae-1a7022808eab

failure paths
  unknown thread id            -> fail closed: app server RPC thread/read failed: thread not loaded
  missing app server socket    -> fail closed: app server socket missing ... No such file or directory
```

Each reply was confirmed in the target TUI pane. These historical rows record
only `accepted -> replied`; they do not claim live `read` evidence. A
`working + idle_only -> deferred` trace was not captured in this session: the
shared App Server reported the target as `idle` while a `sleep` tool call was
in flight, so the deferred branch could not be triggered against a real target
and is left to the contract-level `internal_hooksd_tests` /
`native_delivery_replay` coverage.

On the 2026-09-14 follow-up, the default daemon socket remained probeable and
returned only the existing Desktop thread
`01a09634-4031-73f0-90df-11a03e0325eb`. A fresh CLI 0.154.0 TUI attached to
that daemon but did not register a new thread; the daemon binary is 0.153.4.
No native read observation was produced by this environment. The negative
cursor-to-read boundary is proven at the native protocol replay layer, while
live TUI `read` remains unverified until a compatible default daemon exposes
an explicit read receipt.

## Install record decision

The current RCC sidecar is installed as `rccv3-hooksd`, built from
`routecodex-v3-hooks`, and wired into RCC lifecycle as an optional child
process. No separate `rccv3-codexapp` binary is required by the current
contract: native App Server transport lives in `rccv3-hooksd` and exposes the
same typed `session_status` / `send_message` / delivery evidence boundary.
Adding a second binary later would be a product decision, not a sidecar
capability gap.

## Failure injection matrix

```text
App Server socket missing       -> fail closed
session unknown/disconnected    -> fail closed
working + idle_only             -> deferred
send timeout / uncertain        -> unknown_delivery
duplicate event                 -> one send
sidecar restart                 -> unresolved in-flight not claimed success
```

## Historical mapped gate receipts (pre-integration)

Executed on branch `codex/rcc-internal-hooks-sidecar-0913` rebased onto
`origin/main` at `7818243a8bdcf8160554353b167ab1fa70ebfefb`, after the review
fixes for the `delivery_evidence` intent conflict, control-socket ownership,
and the optional-sidecar startup fail-open. These are the actual exit results
for the `required_gates` declared in
`docs/architecture/v3-verification-map.yml`.

```text
exit 0  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks
          61 lib + 3 binary_handler_config + 1 binary_readiness
          + 6 native_delivery_replay pass
exit 0  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-lifecycle
          internal_hooksd_tests -- --nocapture
          8 pass
exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
          5 pass
exit 0  npm run verify:v3-resource-map
exit 0  npm run verify:v3-mainline-caller-flow
exit 0  npm run verify:v3-module-boundaries
exit 0  npm run verify:v3-architecture-docs
exit 0  git diff --check
```

The two architecture gates (`verify:v3-module-boundaries`,
`verify:v3-architecture-docs`) previously failed on the older base
`63ccc7902b5bddfe1ecfc7aa5bd028458e46f85f` because that base still carried
`normalize_direct_responses_terminal_usage` in
`v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`,
an unmodified file inherited from the base. `origin/main` already removed that
code, so rebasing this single feature commit onto `7818243a8` clears both gates
without touching the runtime file. Both gates now exit 0 on the rebased
candidate.

Supplementary receipts beyond the declared gate list:

```text
exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib
          52 pass
exit 0  CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli
exit 0  CARGO_NET_OFFLINE=true cargo clippy --locked -p routecodex-v3-lifecycle
          -p routecodex-v3-hooks --all-targets
          0 errors; warnings only (pre-existing TEST_ENV_LOCK test pattern)
```

## Integration gate receipts (previous candidate, 2026-09-15)

Historical receipts executed in the integration worktree
`/Users/fanzhang/Documents/github/routecodex/playground/rcc-internal-hooks-sidecar-main-0914`
on uncommitted source candidate `HEAD:d9b78d03785c9a0ff09e3a05168f2e852e864120`,
HEAD tree `7bfc322a057e59c39cce5d8767a4601dbf99c5d9`, and uncommitted lifecycle
source diff object `b9be7fc050425b9b35459d30eb8576daf101225a`; base
`origin/main` `c37a3946ae90641239fcfbef8ae7b118445a81ee`. These were real
command exit results for the `required_gates` in
`docs/architecture/v3-verification-map.yml`; they are source, test, and mapped
gate evidence only, not production install, restart, or same-entry live replay
evidence. The lifecycle source diff object is computed over
`v3/crates/routecodex-v3-lifecycle/src` and
`v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs`, with the two new
untracked lifecycle files added intent-to-add through a temporary
`GIT_INDEX_FILE`, then piped through `git hash-object --stdin`.

They are retained below as historical evidence only; current candidate
receipts follow under "Current candidate gate receipts".

```text
2026-09-15  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
                     63 lib + 3 binary_handler_config + 1 binary_readiness
                     + 9 native_delivery_replay pass
2026-09-15  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib
                     67 pass
2026-09-15  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-cli
                     --test managed_lifecycle -- --test-threads=1
                     22 pass
2026-09-15  exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
                     6 pass
2026-09-15  exit 0  npm run verify:v3-file-size
                     limit=1500; files=274
2026-09-15  exit 0  npm run verify:v3-architecture-ci
                     39/39 sub-gates green
2026-09-15  exit 0  git diff --check
```

The changed owner `v3.managed_server_lifecycle` declares additional
`required_gates` in `docs/architecture/v3-function-map.yml`. Their receipts for
the current candidate are listed in the current-candidate section below; the
previous-candidate receipts are:

```text
2026-09-15  exit 0  npm run verify:v3-managed-server-lifecycle
2026-09-15  exit 0  npm run test:v3-managed-server-lifecycle-red-fixtures
                     69 fixtures
2026-09-15  exit 0  npm run test:v3-managed-server-lifecycle
                     22 pass
2026-09-15  exit 0  npm run verify:v3-architecture-docs
2026-09-15  exit 0  npm run verify:v3-resource-map
2026-09-15  exit 0  npm run verify:v3-module-boundaries
2026-09-15  exit 0  npm run verify:v3-rust-only
2026-09-15  exit 0  npm run test:v3-compile-fail
2026-09-15  exit 0  npm run verify:v3-cargo-fmt
2026-09-15  exit 1  npm run verify:v3-clippy
                     pre-existing failures in untouched crates
                     routecodex-v3-route-classifier and
                     routecodex-v3-config; scoped
                     `cargo clippy -p routecodex-v3-lifecycle --all-targets`
                     is warnings-only, 0 errors
```

## Current candidate gate receipts (2026-09-16)

Executed in the integration worktree
`/Users/fanzhang/Documents/github/routecodex/playground/rcc-internal-hooks-sidecar-main-0914`
on uncommitted current candidate `HEAD:55cd2dc8ec731bbc082ed0f2c9929999e00ee37c`,
HEAD tree `290956056cc22224bff0066b2b3932e7f55bfb5d`, uncommitted diff object
`0f7f98d4f6aec954b2a283cf41fdc2b58da67930`, and base `origin/main`
`d6923774abf871db02b5731017bcce121732bcf2`. The diff object is
`git diff -- v3/crates/routecodex-v3-hooks | git hash-object --stdin` over the
six modified `routecodex-v3-hooks` source/test files; this contract doc is
excluded so the receipt identity is stable. Lifecycle and CLI changes are
already in the committed candidate. These are real command exit results for
source, test, and mapped gates only, not production install, restart, or
same-entry live replay evidence.

```text
2026-09-16  exit 0  cargo fmt --all --manifest-path v3/Cargo.toml
2026-09-16  exit 0  npm run verify:v3-cargo-fmt
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
                     63 lib + 3 binary_handler_config + 1 binary_readiness
                     + 10 native_delivery_replay pass
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib
                     67 pass
2026-09-16  exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
                     6 pass
2026-09-16  exit 0  npm run verify:v3-managed-server-lifecycle
2026-09-16  exit 0  npm run test:v3-managed-server-lifecycle-red-fixtures
                     69 fixtures
2026-09-16  exit 0  npm run test:v3-managed-server-lifecycle
                     22 pass
2026-09-16  exit 0  npm run verify:v3-architecture-ci
                     39/39 sub-gates green
                     (includes file-size files=276, resource-map,
                     mainline-caller-flow, module-boundaries,
                     architecture-docs, rust-only, and compile-fail)
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo clippy --locked
                     -p routecodex-v3-lifecycle -p routecodex-v3-hooks
                     --all-targets
                     0 errors; warnings only (pre-existing/untouched)
2026-09-16  exit 0  git diff --check
```

Independent review: PASS. Codex review task
`20260916T083834Z-review-58331-43n7tt` returned
`controller_no_blocking_findings` for this uncommitted candidate.

### Read-promotion rollback candidate (2026-09-16)

Independent reviews `20260916T113500Z-rcc-hooks-read-evidence-r19` and
`...-r20` returned FAIL. The reviewed candidate promoted a correlated reply
plus a non-empty `backwardsCursor`/`nextCursor` to `read`, which is evidence
inflation: a pagination cursor is page-traversal metadata, and `read_item_id`
cannot be synthesized from `reply.id`. Both reviews also required that a
populated `thread/read(includeTurns)` snapshot not be discarded for a
cursorless `thread/timeline/list` page. That promotion and the cursor plumbing
it required have been removed instead of repaired.

This candidate also fixes a real baseline-loss bug found while reverting: the
`AnyAppServerTransport` enum override omitted `send_message_with_baseline`, so
the default trait method dropped the native send baseline for every daemon
send. The red test
`any_transport_preserves_native_send_baseline` fails on the pre-fix tree and
passes with the delegation restored.

Receipts below are real command exit results against the current uncommitted
tree, `HEAD:498a5143a5f4fdaa8f0d2625df24e33abb055d4b`, HEAD tree
`1fe76aed94911ac88757dc282fd0e06bd5dce6c3`, uncommitted diff object
`300b4d6fb15d3095d8957fae602a3ceff8c3b1f6` (`git diff --
v3/crates/routecodex-v3-hooks | git hash-object --stdin`), and base
`origin/main`. They cover source, test, and mapped gates only, not production
install, restart, or same-entry live replay.

```text
2026-09-16  exit 0  cargo fmt --all --manifest-path v3/Cargo.toml
2026-09-16  exit 0  npm run verify:v3-cargo-fmt
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
                     63 lib + 3 binary_handler_config + 1 binary_readiness
                     + 11 native_delivery_replay pass
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle
                     internal_hooksd_tests -- --nocapture
                     10 pass
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib
                     67 pass
2026-09-16  exit 0  CARGO_NET_OFFLINE=true cargo clippy --locked
                     -p routecodex-v3-hooks --all-targets -- -D warnings
                     0 errors
2026-09-16  exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
                     6 pass
2026-09-16  exit 0  npm run verify:v3-resource-map
2026-09-16  exit 0  npm run verify:v3-module-boundaries
2026-09-16  exit 0  npm run verify:v3-mainline-caller-flow
2026-09-16  exit 0  npm run verify:v3-architecture-docs
2026-09-16  exit 0  npm run verify:v3-architecture-ci
                     39/39 sub-gates green
2026-09-16  exit 0  git diff --check
```

Review findings and their fixes are recorded in
`docs/design/rcc-internal-hooks-sidecar-review-0914.md`, including the red
evidence for each fix.

The prior isolated installed-binary failure-injection receipt remains
historical evidence bound to source candidate
`ef5fc05034341df5cc990bbf84e5fb6292201e33`; it is not reused as evidence for
the current uncommitted lifecycle-supervisor change.

### Live replay closure and remaining gaps

The current candidate has live TUI/TUI evidence:

- `RCC_LIVE_FORWARD_C2B_20260915C` accepted -> `replied` on TUI B.
- `RCC_LIVE_TIMER_20260915C` accepted -> `replied` on TUI B.
- `RCC_LIVE_READ2_20260916` and `RCC_LIVE_HOOK_FWD2_20260916` accepted ->
  `replied` on TUI B; the candidate that recorded these as `read` was rejected
  by review and the read promotion is removed from source.
- Mounted no-op handler and unknown-handler fail-closed were exercised through
  the live control socket.

Remaining declared `live_required` items:

- No `read` observation exists: the default App Server has not exposed an
  explicit native read receipt or acknowledgement method, and history
  pagination is not read evidence. The generated experimental App Server
  protocol schema confirms that thread history exposes metadata, turns, items,
  and timeline pages only; `AgentMessageDelivery` is an `async` enum rather
  than a receipt.
- Desktop reply/read closure remains unverified: no Desktop-owned thread was
  driven through the sidecar in the current replay. The earlier Desktop
  history-read rejection occurred before its thread had materialized, matching
  the same transient race observed on fresh TUI threads rather than a permanent
  protocol capability gap.
- Real installed-binary sidecar failure injection is closed for the crashed
  before readiness case: the actual `rccv3` lifecycle entrypoint started the
  listeners, the process stayed `running`, and `rccv3 status` reported
  `hooks_unavailable:crashed: managed lifecycle validation failed: hooks sidecar exited before readiness`.
  The missing and timeout cases remain contract/unit level because they are
  covered by the lifecycle tests, but they have not been repeated through the
  installed production binary.

Install, restart, merge, and push remain explicitly unauthorized and are owned
by the supervisor.
