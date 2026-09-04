# V3 Servertool and Stopless Procedure

## When

Use for servertool projection/execution, `reasoningStop`, premature natural stop, Stopless state, continuation loop, or client tool-round closure.

## First Gate: Executable CLI

```bash
rccv3 servertool --help
rccv3 servertool run --help
```

Current CLI source registers `servertool run` and requires `--input-json`; it does not register a `hook` command. Therefore any client-visible command outside current help is an explicit CLI/runtime contract gap. Do not claim executable closure, invent an empty input, or parse stdout as control-state recovery.

## Owner Lookup

```bash
rg -n 'stopless|reasoningStop|servertool' \
  docs/architecture/v3-resource-operation-map.yml \
  docs/architecture/v3-function-map.yml \
  docs/architecture/v3-mainline-call-map.yml \
  docs/architecture/v3-verification-map.yml
```

Separate owners:

- provider-visible tool/guidance declaration;
- typed Stopless control resource and transition;
- Resp03 terminal/intercept decision;
- client-visible tool projection;
- CLI parser/execution;
- next-request continuation restore.

No component may reconstruct another owner's control state from CLI arguments/output, visible text, SSE, debug, or persisted business history.

## Diagnosis

1. Capture first provider request, raw provider response, client projection, client tool result, and second provider request under one session/request chain.
2. Prove whether provider received expected original tools plus any registered internal tool exactly once.
3. Prove whether raw response was natural stop, model tool call, malformed tool arguments, or provider error.
4. Prove Resp03 typed decision before examining client framing.
5. Validate projected command against installed CLI help and exit behavior.
6. Prove next request restores business continuation without internal control artifacts.

## Contract Mismatch

If runtime projects a command absent from CLI:

1. Reproduce with focused projection test and CLI blackbox.
2. Lock one owner decision: add registered CLI behavior or change projection to an existing registered command.
3. Update source, CLI test, runtime test, maps, and this procedure together.
4. No fallback alias or dual command path.

## Verification

```bash
npm run verify:v3-stopless-resource-control
npm run test:v3-stopless-resource-control-red-fixtures
npm run verify:v3-stopless-state-machine-docs
npm run test:v3-stopless-state-machine-docs-red-fixtures
```

Then run the project architecture gate from `../SKILL.md`. Runtime change follows `50-rcc-config-ssot.md` and requires a real two-turn same-entry replay. Report CLI execution, Stopless state transition, provider continuation, and client visibility separately.
