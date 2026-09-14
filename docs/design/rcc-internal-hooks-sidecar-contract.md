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
DeliveryEvidenceRecord  -> intent_id + message_id + state + cursor + read_item_id
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
  `replied`; `read` requires both that reply and a non-empty continuation
  cursor/page from the native history response. Missing either condition keeps
  the highest justified lower state. The current transport does not synthesize
  `executed`; a `toolMessage` remains execution evidence only and cannot
  promote an intent.
- Native App Server request shapes are captured in Rust:
  `initialize`, `thread/read`, `thread/loaded/list`, `thread/queue/add`,
  `thread/items/list`.
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
   The default shared App Server exposes both TUI and Desktop clients; Desktop
   live history-read closure remains subject to the daemon's advertised
   capability. `executed` is not claimed unless the native item sequence
   supplies an explicit execution observation.
2. If a separate adaptive `rccv3-codexapp` bin is later required by product
   contract, it must wrap the same native transport used by `rccv3-hooksd`
   instead of creating a second runtime.

## Test evidence

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks`:
  56 lib tests, 3 `binary_handler_config` tests, 1 `binary_readiness` test,
  and 6 `native_delivery_replay` tests pass.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks
  --test native_delivery_replay`: an end-to-end replay against a mock App
  Server that speaks the real Unix WebSocket JSON-RPC protocol proves
  `thread/queue/add` acceptance -> `thread/items/list` receipt/reply
  correlation -> `read` evidence when the page supplies a cursor, proves a
  reply without a cursor stops at `replied`, proves the timer fires through the
  core and sends back to the registrant, and proves the running control
  server's timer tick delivers a due schedule through the native transport.
  The mock is a protocol fixture only; production still talks only to the
  Codex default TUI/Desktop App Server.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-lifecycle --lib`:
  52 tests pass, including internal `rccv3-hooksd` missing/crash/timeout
  degradation and stale/identity-mismatched hooks record handling. Startup
  admission never blocks on the optional sidecar and preserves the uncertain
  process record; cleanup boundaries (stop/restart/forced stop) keep the strict
  fail-closed liveness probe.

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

- TUI A -> TUI B message was delivered through the default App Server socket:
  `thread/queue/add` accepted, target TUI showed the message, target replied
  `RCC_HOOKS_LIVE_TUI_OK_2`. The original replay used the old correlation
  implementation, which stopped at `accepted -> replied` with native message
  id `01a09f1d-909d-7a41-a132-a0b74343edc7` and did not retain a cursor; that
  historical run does not claim `read`. The current correlation path requires
  a non-empty native history cursor and is covered by the positive and negative
  native replay tests above.
- TUI -> Desktop queue submission was attempted through the same default App
  Server socket and failed before queue acceptance with the exact capability
  gap:
  `list_turns is not supported yet`.

The transport no longer depends on `thread/items/list` or `thread/turns/list`;
it first tries `thread/read` with `includeTurns` so Desktop-style App Servers
that reject read-listing methods can still supply turn payloads where
supported. The real Desktop daemon currently rejects that call, so Desktop
reply/read closure remains unverified.

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

Each reply was confirmed in the target TUI pane. These historical rows predate
the cursor-based `read` correlation and therefore record only
`accepted -> replied`; they do not claim live `read` evidence. A
`working + idle_only -> deferred` trace was not captured in this session: the
shared App Server reported the target as `idle` while a `sleep` tool call was
in flight, so the deferred branch could not be triggered against a real target
and is left to the contract-level `internal_hooksd_tests` /
`native_delivery_replay` coverage.

On the 2026-09-14 follow-up, the default daemon socket remained probeable and
returned only the existing Desktop thread
`01a09634-4031-73f0-90df-11a03e0325eb`. A fresh CLI 0.154.0 TUI attached to
that daemon but did not register a new thread; the daemon binary is 0.153.4.
No live `read` cursor was produced by this environment. The cursor-aware
correlation is therefore proven at the native protocol replay layer, while
live TUI `read` remains unverified until a compatible default daemon exposes a
fresh TUI thread.

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

## Mapped gate receipts

Executed on branch `codex/rcc-internal-hooks-sidecar-0913` rebased onto
`origin/main` at `7818243a8bdcf8160554353b167ab1fa70ebfefb`, after the review
fixes for the `delivery_evidence` intent conflict, control-socket ownership,
and the optional-sidecar startup fail-open. These are the actual exit results
for the `required_gates` declared in
`docs/architecture/v3-verification-map.yml`.

```text
exit 0  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks
          56 lib + 3 binary_handler_config + 1 binary_readiness
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

## Integration gate receipts (branch `codex/rcc-internal-hooks-sidecar-main-0914`)

Executed in the integration worktree
`/Users/fanzhang/Documents/github/routecodex/playground/rcc-internal-hooks-sidecar-main-0914`
on candidate code commit `5d6357ab501f4e2ab84a87edf8fcd90e14fedec2`, base
`origin/main` `3fe9790007f7d2abfe044dd7a466c258847c53f4`. These are real
command exit results for the `required_gates` in
`docs/architecture/v3-verification-map.yml`; they are source, test, gate,
build, and isolated installed-binary failure-injection evidence only, not
production install, restart, or same-entry live replay evidence.

```text
2026-09-14T20:10Z  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-hooks
                     59 lib + 3 binary_handler_config + 1 binary_readiness
                     + 6 native_delivery_replay pass
2026-09-14T20:14Z  exit 0  CARGO_NET_OFFLINE=true cargo test --locked -p routecodex-v3-lifecycle --lib
                     52 pass
2026-09-14T20:11Z  exit 0  node --test v3/tests/scripts/v3-cli-distribution.spec.mjs
                     6 pass
2026-09-14T20:15Z  exit 0  npm run verify:v3-resource-map
2026-09-14T20:15Z  exit 0  npm run verify:v3-mainline-caller-flow
                     binding_pending edges 13; locked 55; pending 21
2026-09-14T20:15Z  exit 0  npm run verify:v3-module-boundaries
2026-09-14T20:15Z  exit 0  npm run verify:v3-architecture-docs
                     docs 26; resources 171; edges 442
2026-09-14T20:17Z  exit 0  git diff --check
2026-09-14T20:17Z  exit 0  CARGO_NET_OFFLINE=true cargo clippy --locked -p routecodex-v3-hooks --all-targets
                     0 errors
2026-09-14T20:16Z  exit 0  CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli
2026-09-14T20:17Z  isolated installed-binary failure injection
                     ROUTECODEX_HOOKS_INSTALL_RECORD=$ROOT/install.json rccv3 start --config $ROOT/config.v3.toml --snap
                     state=running; listeners started on 127.0.0.1:45464/45465/45466
                     status detail=hooks sidecar unavailable: hooks_unavailable:crashed:
                     managed lifecycle validation failed: hooks sidecar exited before readiness
```

Review findings and their fixes are recorded in
`docs/design/rcc-internal-hooks-sidecar-review-0914.md`, including the red
evidence for each fix.

### Live replay gap

The declared `live_required` items:

- No real TUI/TUI or TUI/Desktop same-entry replay has produced native
  `delivered/replied/read` evidence on the current candidate. The only real
  App Server history-read attempt on the default Desktop daemon returned
  `list_turns is not supported yet`, and no cursor was available, so no `read`
  observation exists.
- Real installed-binary sidecar failure injection is closed for the crashed
  before readiness case: the actual `rccv3` lifecycle entrypoint started the
  listeners, the process stayed `running`, and `rccv3 status` reported
  `hooks_unavailable:crashed: managed lifecycle validation failed: hooks sidecar exited before readiness`.
  The missing and timeout cases remain contract/unit level because they are
  covered by the lifecycle tests, but they have not been repeated through the
  installed production binary.

Install, restart, merge, and push remain explicitly unauthorized and are owned
by the supervisor.
