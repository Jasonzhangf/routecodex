# rustification-governance

## Purpose

Govern RouteCodex rustification so repeated audit/fix runs do not claim Rust
ownership while TypeScript still owns runtime semantics.

This loop watches:

```text
Hub Pipeline semantics -> Virtual Router semantics -> provider wire boundary
                         -> server IO boundary
```

Initial mode is `L1 report-only`: classify current state, write findings, and
update loop state. It must not edit runtime code, provider config, server
startup, global install state, or live processes.

## Cadence

- Manual at first.
- Recommended trigger: before or after Hub Pipeline, Virtual Router,
  continuation, servertool, provider runtime, or server IO rustification work.
- No scheduler until repeated L1 runs prove stable signal quality.

## Owner

- Human owner: Jason.
- Agent owner: current RouteCodex coding agent for the active run.
- Checker: a separate verifier pass or separate worker before any L2+ change is
  treated as approved.

## Mode Ladder

- `L1 report-only`: read maps/docs/source summaries and append findings only.
- `L2 assisted`: one owner-scoped diff only after function map, mainline map,
  verification map, `gate-matrix.md`, required tests, and checker are clear.
- `L3 unattended`: disabled until run history, budget, kill switch, and verifier
  evidence exist.

## Human Gates

Human approval is required before:

- Enabling L2 or L3.
- Editing runtime code, architecture maps, package scripts, or generated review
  surfaces as a loop action.
- Migrating server IO, provider transport, process lifecycle, auth, secrets,
  provider config, production config, or persistent user state.
- Running live restart, live replay, global install, release install, or any
  process lifecycle command from the loop.

## Kill Switch

Set this exact line in `STATE.md` to stop the loop:

```text
kill_switch: active
```

If the kill switch is active, the loop must append a no-op run log entry and
exit without further inspection.

## Canonical Inputs

- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `docs/goals/hubpipeline-tool-boundary-audit-goal.md`
- `docs/agent-routing/05-foundation-contract.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `.agents/skills/rcc-dev-skills/references/93-lessons-2026-07.md`
- `MEMORY.md`
- `note.md`

## Classification Terms

- `rust_ssot`: Rust owns the semantic contract, state machine, builder/parser,
  and policy; TypeScript does not reimplement the behavior.
- `native_shell_ok`: TypeScript is a thin wrapper around native truth and has no
  fallback, patch, provider special case, or duplicate semantic branch.
- `ts_io_shell_ok`: TypeScript only owns Express/SSE/fetch/process IO and passes
  semantic payloads through typed/native boundaries.
- `ts_semantic_debt`: TypeScript owns routing, tool governance, continuation,
  payload repair, sanitize, provider patching, error policy, or semantic
  fallback.

## Initial Watchlist

- `hub_pipeline_semantics`: req/resp Chat Process, servertool followup, tool
  governance, reasoning/history governance, and continuation save/restore.
- `virtual_router_semantics`: route classification, candidate selection,
  forwarder behavior, provider failure/reroute policy, and no provider patching.
- `server_io_boundary`: HTTP handlers, Responses handler, SSE writer, process
  lifecycle, metadata attach/release, and client frame IO.
- `provider_transport_boundary`: provider SDK/fetch transport, provider wire
  codec, auth headers, streaming parse, and transport error capture.

## L2 Gate Matrix

L2 actions must use exactly one row from `gate-matrix.md`:

- `hub_pipeline_semantics`
- `virtual_router_semantics`
- `server_io_boundary`
- `provider_transport_boundary`

The selected row defines the required owner, mainline edge, whitebox gates,
blackbox gates, quality checks, evidence, and escalation condition for that run.

## Completion Definitions

`Hub/VR semantic rustification complete` means all Hub Pipeline and Virtual
Router semantic watchlist items are classified as `rust_ssot` or
`native_shell_ok`, and required Rust-only gates pass.

`End-to-end IO rustification complete` is a separate future phase. It requires
server IO and provider transport watchlist items to move beyond
`ts_io_shell_ok` under explicit human approval and new gate rows.
