# V3 Managed Server Lifecycle Test Design

feature_id: `v3.managed_server_lifecycle`

## Lifecycle contract

```text
V3Lifecycle01ValidatedConfig
  -> V3Lifecycle02InstanceDeclared
  -> V3Lifecycle03OperationLocked
  -> V3Lifecycle04ChildSpawned
  -> V3Lifecycle05IdentityPublished
  -> V3Lifecycle06LiveControlled
  -> V3Lifecycle07GracefullyStopped
```

Only `routecodex-v3-lifecycle` advances this process-control chain. Config publishes the deterministic
Manifest; Server supplies one aggregate listener handle; CLI parses arguments and prints the typed
result. Request/response Runtime remains the only business lifecycle.

## State contract

`instance.json` is the stable declaration: schema version, deterministic instance ID, canonical
config path and digest, executable identity, and complete listener set. `pid.cache` is transient and
binds PID to a random start nonce. `control.json` exposes only the Unix control socket path and nonce
handle. `restart.plan.json` is an owner-only transient control-side file for in-place exec options
(new executable path, snapshots, snapshot stages) and is bound to the current start nonce; it is not
client/provider payload and is deleted when no override is needed or when the re-entered child
publishes its fresh control nonce. `status.json` records
starting/running/stopping/stopped/failed without provider/client data.
Every schema uses `deny_unknown_fields`; every write is temp-file plus rename; state directories are
owner-only. No resolved secret, provider/client payload, Metadata, Debug snapshot, request ID, session,
or continuation truth may enter lifecycle state.

The instance ID is the stable service identity derived from canonical config path plus config digest.
`executable_path` is exact launch provenance. Same-binary restart preserves it; explicit
restart from a new release snapshot publishes a nonce-bound `restart.plan.json` and then execs the
running PID in place into that new executable. A `stopped` or `failed` instance may also republish the
same service declaration from a new canonical release snapshot executable. That rollover is legal only when instance ID, config path/digest, listener set,
and schema are unchanged and terminal status/control ownership are verified. Missing terminal proof,
active state, or any other declaration difference must fail without reaping state.

## Positive white-box matrix

- same canonical config produces the same instance ID and config digest;
- different config bytes/path/listener declaration produces a different identity;
- operation lock is exclusive and releases on normal/error exit;
- child publishes PID/start nonce only after all listeners bind;
- status challenge validates instance ID plus nonce through the control socket;
- stop transitions running -> stopping -> stopped and closes all aggregate listeners;
- restart is one in-place exec for the instance, never per listener; same-binary restart preserves
  the running executable path, while new-release restart uses a nonce-bound restart plan file and
  republishes `instance.json` before exec; the re-entered child removes the consumed plan;
- start over an already-running exact instance performs the old `rcc start` takeover: graceful
  control stop, then a fresh child with the same instance ID and a new PID/start nonce;
- stale stopped PID/control caches are reaped after exact state/schema validation;
- a stopped instance starts from the next release snapshot executable while retaining one stable
  service instance ID and publishing the new canonical executable path;
- multi-listener instance publishes and closes the complete listener set.

## Negative white-box matrix

- duplicate start while the exact instance is live;
- concurrent lifecycle operation lock contention;
- PID cache nonce mismatch / PID reuse simulation;
- wrong executable identity or config digest;
- release executable rollover while state is running or terminal proof is missing;
- a configured listener port that remains occupied after graceful control stop proceeds through
  explicit listener PID SIGTERM then SIGKILL; if no explicit listener PID can be discovered, start
  fails instead of using a broad kill;
- malformed JSON or unknown state field;
- missing/unreadable auth handle at provider-send boundary remains explicit and is never persisted;
- control socket missing, wrong nonce, wrong instance ID, shutdown timeout;
- stop/restart for missing or already-stopped instance;
- no broad kill, `pkill`, `killall`, `xargs kill`, shell PID expansion, or non-listener process
  compensation.

## External CLI black-box

Use a temporary config, state root, ports, executable, and controlled Responses upstream:

```text
config check
  -> top-level start
  -> health/status
  -> duplicate start takes over the exact instance with stable instance ID + changed PID/start nonce
  -> top-level restart
  -> stable instance ID + same PID + refreshed start nonce
  -> stop -> copy/invoke next release snapshot executable -> start with stable instance ID
  -> health
  -> top-level stop
  -> all listeners closed
  -> status reports stopped
```

The test invokes the actual CLI binary; it does not call lifecycle internals or Server spawn APIs.
State, process argv, logs, and evidence are scanned for the controlled secret.
The user-facing parse shape is the old-style top-level command set:
`rccv3 start|status|restart|stop -c|--config <path>`. Without `-c`, the same commands resolve
`~/.rcc/config.v3.toml`. The `rccv3 server ...` namespace remains hidden compatibility only and
must not be documented as the normal start path.
The same black-box suite also holds a SIGTERM-resistant process on a configured listener port and
requires `rccv3 start` to free it with explicit listener PID SIGTERM then SIGKILL before binding.
If that configured listener is owned by another managed multi-port instance, the owner must release only the overlapping configured listener ports by using a foreign managed port-scoped release; an unmanaged PID with sibling listener ports is rejected rather than broad-killed.
Foreground `rccv3 start` also forces console visibility even when config has `debug.log_console=false`:
startup must emit `V3ServerStartup01ListenerSetPreflight`, and a dry-run request must emit
`V3Server03HttpRequestRaw`. The foreground/server-log human lines must match the V2 request monitor
shape: `▶` request start, `[virtual-router-hit] req=... sid=... -> provider[key].wire_model reason=...`,
`✅` completion with `finish_reason=...`, and `[usage] req=<short> project=<path>:<port>
route=<router-direct|router-relay>:<reason> model=<request-model>-><wire-model> time=i/e/t
finish_reason=...`; the persisted server log must keep the same ANSI colorized line rather than an
uncolored copy. `rccv3 start --snap` must force `/_routecodex/debug/status` to report
`snapshots_enabled=true` even when the config has snapshots disabled.

## Live matrix

After every source/controlled gate passes, migrate only the already-known V3 5555 instance to the managed owner. Before acting, verify its executable/config/listener identity. Use the lifecycle control surface first. If the configured listener is still occupied, release only the overlapping configured listener ports from any foreign managed owner; if an unmanaged PID also owns sibling listener ports, fail explicitly instead of broad-killing. Do not touch the V2 aggregate.

Before and after one managed restart:

- V3 5555 `/health` has `manifest_version=3` and server ID `responses_v3_5555`;
- `/v1/models` binds `cc_sol/gpt-5.6-sol`;
- real JSON Responses returns exact requested marker;
- real SSE includes the requested marker, `response.completed`, and `[DONE]`;
- V2 5520/10000/4444 stay HTTP 200/ready on their installed version.

## Required gates

- focused lifecycle unit/integration tests;
- external CLI managed lifecycle black-box;
- managed lifecycle source verifier and red mutations;
- V3 architecture/resource/function/mainline/module/Rust-only gates;
- cargo fmt, Clippy `-D warnings`, full V3 workspace, CLI build, `git diff --check`;
- live JSON/SSE replay and concurrent V2/V3 health after managed restart.

## Completion wording

Completion requires the live 5555 process to be owned by this managed lifecycle rather than an agent
exec session. Source tests or temporary-port black-box alone cannot claim the objective complete.
