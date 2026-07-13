# Runtime Aggregate Restart Test Design

## Goal

Define `rcc restart` around one aggregate RouteCodex server instance. A port is
only a locator and health endpoint for that instance; it is not an independent
restart target.

## Lifecycle

```text
configured/listening member ports
  -> resolve one aggregate listener identity
  -> request one HTTP or SIGUSR2 restart
  -> observe restart on the locator port
  -> verify every member port is listening and healthy on one identity
```

## Positive Cases

1. `--port 5555` locates a configured aggregate instance whose member ports are
   `5520`, `5555`, `10000`, and `4444`. If all listeners share one PID set, the
   command sends one restart request and verifies all four health endpoints.
2. Without `--port`, multiple discovered ports sharing one PID set resolve to
   one aggregate instance instead of triggering the old broadcast-disabled
   error.
3. Same-PID in-process reload remains valid only after repeated healthy probes
   and after all aggregate member ports are healthy.

## Negative Cases

1. Configured member ports with different non-empty PID sets must not be merged;
   the command fails before sending HTTP or SIGUSR2.
2. Multiple distinct aggregate PID identities without an explicit locator stay
   ambiguous and fail instead of broadcasting.
3. One aggregate identity must never receive duplicate restart requests because
   it listens on multiple ports.
4. Restart completion fails when any configured member port remains missing,
   unhealthy, or attached to a different listener identity.

## Required Gates

- `tests/cli/restart-command.spec.ts`
- `tests/cli/restart-command.probe-host.spec.ts`
- `tests/sharedmodule/runtime-lifecycle-direct-native.spec.ts`
- `npm run verify:runtime-lifecycle-pid-rebase`
- `npm run verify:function-map-compile-gate`
- `npm run build:native-hotpath`
- `npm run build:base`
- global release install
- one aggregate restart request followed by health/version checks on all
  configured member ports

## Known Boundary

Rust owns restart transport selection. TypeScript may read config, discover OS
listeners, group endpoints by listener identity, perform HTTP/signal IO, and
probe health. It must not loop restart requests per member port.
