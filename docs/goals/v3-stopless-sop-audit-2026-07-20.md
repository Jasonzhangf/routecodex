# V3 Stopless SOP Audit — 2026-07-20


## Corrected coding-agent response document

The previous inline all-fixed coding-agent repair response is superseded by the locked SOP. The corrected architecture/design response is now recorded in:

- `docs/goals/v3-stopless-resource-control-repair-response-sop-review-2026-07-20.md`

That document treats current implementation as RED under SOP 95 and lists the owners, red tests, and acceptance criteria required before any future `fixed` response.

## Scope

This audit uses `.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md` as the current design contract.

This is an SOP and flow audit only. It does not claim runtime fixed, global install completed, or 5555 live replay closed.

## Design contract locked by SOP

```text
Problem:
  model stops early before completion/blockage

Required lifecycle:
  Resp03 stopless intercept/project no-input CLI
    -> Resp04 save finalized canonical continuation
    -> immutable interval with no stopless/servertool semantics
    -> Req04 restore continuation first
    -> Req04 consume no-op evidence and read StoplessCenter state
    -> Req04 emit provider-facing continuation from state machine

CLI:
  routecodex hook run reasoningStop
  no input-json, no args, no state, no stdout parsing

State:
  MetadataCenter.runtime_control.stopless / StoplessCenter state machine
  session-scoped, phaseful, need_continue/blocked/terminal/guard closed
```

## Evidence collected

| Evidence | Result |
| --- | --- |
| Installed CLI: `routecodex hook run reasoningStop` | exits 1: `required option '--input-json <json>' not specified` |
| Installed CLI: `routecodex hook run reasoningStop --input-json '{}'` | exits 0 but prints state-like JSON (`continuationPrompt`, `repeatCount`, `triggerHint`) |
| User live sample response `...154516977-578818-2849/response.json` | projected bare `routecodex hook run reasoningStop`; client then hit installed CLI no-input failure |
| Same sample provider request | provider side had `reasoningStop`/tool guidance evidence; first-turn stop cannot be reduced to “no tools” |
| Worktree source `build_stopless_cli_command()` | draft code returns `routecodex hook run reasoningStop --input-json '{}'`, which is executable for current CLI but violates corrected SOP |
| Worktree `V3StoplessCenterState` | only `natural_stop_count`, `max_natural_stops`, `steering`; not a complete state machine |
| Worktree Req04 hook | consumes stopless pair and appends unconditional `继续。`; does not choose text by phase/streak/blocked/need_continue |
| Worktree request order | continuation restore/merge happens before `apply_v3_stopless_request_hook_at_req04` |
| Worktree response order | `apply_v3_stopless_response_hook_at_resp03` runs during response governance before finalized response is saved for local continuation |
| `npm run verify:v3-stopless-resource-control` after SOP tightening | intentionally RED: state struct lacks state-machine fields/variants; CLI command still has `--input-json` |
| `npm run test:v3-stopless-resource-control-red-fixtures` | PASS: 12 forbidden mutations rejected |
| `git diff --check` | PASS |

## Flow audit matrix

| SOP node / concern | Current status | Evidence / gap |
| --- | --- | --- |
| CLI no-input no-op | RED | installed CLI rejects no-input; worktree draft “fixes” by requiring `--input-json '{}'`, which SOP forbids |
| CLI carries no state | RED | installed `--input-json '{}'` stdout emits `continuationPrompt`, `repeatCount`, `triggerHint`; SOP says stdout must not be parsed or treated as state |
| StoplessCenter state machine completeness | RED | `V3StoplessCenterState` lacks phase, last_stop_kind, need_continue, blocked, terminal, guard_exhausted, next_request_policy, request/response binding |
| Response hook before continuation save | MOSTLY OK / VERIFY | source order has Resp03 governance before Resp04 finalized context; physical StoplessCenter store currently occurs in runtime transition after `run_json_response_hooks`, before local continuation store, and must be checked against the declared Resp03 MetadataCenter owner |
| Request hook after continuation restore | OK | `relay_request.rs` restores/merges local context before calling `apply_v3_stopless_request_hook_at_req04` |
| Req04 no-op evidence handling | PARTIAL | shell pair is stripped, but no-op output/state is not integrated with a complete StoplessCenter state machine |
| Req04 provider-facing continuation text | RED | current code hardcodes `继续。` for all no-op states; SOP requires state-dependent text/policy |
| Data/control separation | PARTIAL | maps/resource gate declare separation; implementation still lacks full state machine and current installed CLI emits state-like JSON |
| Tool surface preservation | NEEDS TEST ALIGNMENT | prior blackbox focus on tool names is insufficient; SOP requires exact original declaration surface + schema/description/strict/custom format + exactly-one internal `reasoningStop` |
| Continuation immutable interval | NEEDS RED LOCK | docs declare boundary; tests must prove save-before-projection and consume-before-restore mutations fail |
| Direct/provider-direct negative | NEEDS REGRESSION RECHECK | required by SOP; not re-run in this audit |
| Live 5555 closure | NOT CLAIMED | no global install/restart/live replay performed in this SOP-first audit |

## Required red tests before implementation

1. CLI binary red:
   - `routecodex hook run reasoningStop` must be the passing path.
   - requiring `--input-json` must fail the contract.
2. Resp03 projection red:
   - client JSON/SSE `exec_command.arguments.cmd` must exactly equal `routecodex hook run reasoningStop`.
   - `--input-json`, session ids, repeat counters, schema feedback, and JSON state in command must fail.
3. StoplessCenter state-machine red:
   - a counter-only `V3StoplessCenterState` must fail.
   - phase, need_continue, blocked, terminal, guard, next_request_policy, and request/response binding transitions must be asserted.
4. Req04 guidance red:
   - same no-op evidence under different StoplessCenter states must produce different provider-facing prompt/policy.
   - a universal hardcoded `继续。` must fail.
5. Continuation boundary red:
   - response save before stopless projection must fail.
   - request hook before continuation restore must fail.
6. Provider blackbox red:
   - Round2 provider request must have no stopless shell/control artifacts.
   - original tool declaration surface must be semantically exact, not names-only.
   - exactly one internal `reasoningStop` may be appended.
7. Guard/terminal red:
   - completed, blocked, need_continue, guard, non-stop progress, already-terminal, and session reset paths must have positive/negative pairs.

## Docs/gates updated by this audit

- `references/95-v3-stopless-sop.md` rewritten as the current SOP.
- `references/22-servertool-hook-skeleton-workflow.md` now marks V3 stopless as the no-input CLI exception.
- `references/23-servertool-hook-dev-debug-flow.md` now routes V3 stopless state through StoplessCenter, not CLI input/stdout.
- `references/24-node-contract-debug-method.md` now points V3 stopless to SOP 95 and replaces repeat/CLI state language with StoplessCenter state-machine language.
- `docs/agent-routing/30-servertool-lifecycle-routing.md` now points stopless to SOP 95.
- `docs/architecture/wiki/stopless-session-mainline-source.md` now describes no-input CLI and MetadataCenter state-machine ownership.
- V3 resource/function/verification/manifest docs now describe `no_input` CLI and state-machine-required StoplessCenter.
- `verify:v3-stopless-resource-control` was tightened to expect no-input CLI and state-machine fields; it is expected to fail until runtime code is fixed.

## Next phase

Do not start implementation until the red tests above are created or tightened and shown red against the current runtime/source. Then fix the unique owners:

1. CLI no-input hook contract.
2. Resp03 client projection command.
3. StoplessCenter state-machine model and transitions.
4. Req04 state-dependent provider-facing guidance.
5. Provider/client blackbox and live 5555 replay.
