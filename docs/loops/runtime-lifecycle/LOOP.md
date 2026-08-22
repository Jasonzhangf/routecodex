# runtime-lifecycle-release-watch

## Purpose

Guard the RouteCodex release/runtime lifecycle before repeated work becomes
automated. This loop watches the chain:

```text
build -> pack -> global install -> managed start/stop/restart -> health -> live replay
```

Initial mode is `L1 report-only`: inspect state, write findings, and update loop
state. It must not edit runtime code, package config, user config, installed
global packages, provider config, secrets, or running production processes.

## Cadence

- Manual at first.
- Recommended trigger: before or after release/build/runtime lifecycle work.
- No scheduler until repeated L1 runs prove stable signal quality.

## Owner

- Human owner: Jason.
- Agent owner: current RouteCodex coding agent for the active run.
- Checker: a separate verifier pass or separate worker before any L2+ change is
  treated as approved.

## Mode Ladder

- `L1 report-only`: read files/logs/state and append findings only.
- `L2 assisted`: one owner-scoped diff only after function map, mainline map,
  verification map, `gate-matrix.md`, required tests, and checker are clear.
- `L3 unattended`: disabled until run history, budget, kill switch, and verifier
  evidence exist.

## Human Gates

Human approval is required before:

- Enabling L2 or L3.
- Running global install, release install, managed restart, or live replay from
  the loop.
- Editing runtime code or architecture maps as a loop action.
- Touching auth, secrets, provider config, production config, or persistent user
  state outside the loop directory.

## Kill Switch

Set this exact line in `STATE.md` to stop the loop:

```text
kill_switch: active
```

If the kill switch is active, the loop must append a no-op run log entry and
exit without further inspection.

## Canonical Inputs

- `package.json`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/agent-routing/05-foundation-contract.md`
- `docs/agent-routing/20-build-test-release-routing.md`
- `docs/loops/runtime-lifecycle/gate-matrix.md`
- `MEMORY.md`
- `note.md`

## Canonical Evidence Paths

- `~/.rcc/logs/server-<port>.log`
- `~/.rcc/logs/process-lifecycle.jsonl`
- `~/.rcc/state/runtime-lifecycle/`
- `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`

Raw evidence should be summarized in this loop state or `note.md`; do not paste
large logs into the loop files.

## Initial Watchlist

- Version/build-info/package-lock/package tarball/global install drift.
- `rcc start --snap` foreground/daemon/supervisor behavior.
- Port group takeover and shutdown races.
- Stop-intent lifecycle under `~/.rcc/state/runtime-lifecycle/ports/<port>/`.
- PID registry trust and stale PID handling.
- Verification-map coverage for lifecycle/release gates.
- Dirty-worktree collision with other workers.

## L2 Gate Matrix

L2 actions must use exactly one row from `gate-matrix.md`:

- `release_install_sync`
- `runtime_lifecycle`
- `verification_gate_mapping`
- `worker_collision`

The selected row defines the required owner, whitebox gates, blackbox gates,
quality checks, evidence, and escalation condition for that run.
