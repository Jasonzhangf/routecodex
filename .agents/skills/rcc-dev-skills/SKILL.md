---
name: rcc-dev-skills
description: "RouteCodex V3 transparent-proxy development/debug: maximize cross-protocol passage; never block a passable request or response with extra validation. For 502/598/599, routing, provider, protocol/SSE, or tool failures, read the DAGPipe graph first, find the first divergence, and replay the installed entry. Active config: ~/.rcc/config.toml; samples: ~/.rcc/codex-samples."
---

# RouteCodex V3 Development

This skill owns V3 command and gate sequencing. Inherit general methods from `coding-principals` and boundaries from project `AGENTS.md`; do not also run a generic development phase workflow. Pure instruction/document edits validate affected references and contracts; runtime build/install/restart/replay applies only when runtime behavior or its delivery changes.

## Command-First Flow

1. Read `AGENTS.md`.
   For a module under DAGPipe governance, first read `docs/architecture/dagpipe/README.md` and its business graph. Compare the affected path with the proxy contract, owner and same-entry evidence. Validate a changed graph once; reuse unchanged graph results. CLI validation does not prove SDK compile or runtime execution.
2. Query maps before source:

```bash
rcc_task_feature='<feature_id>'
rg -n "feature_id: ${rcc_task_feature}" \
  docs/architecture/v3-resource-operation-map.yml \
  docs/architecture/v3-function-map.yml \
  docs/architecture/v3-mainline-call-map.yml \
  docs/architecture/v3-verification-map.yml
```

3. Lock resource edge, owner, allowed/forbidden paths, caller/callee, and gates. Missing or ambiguous binding blocks edits. Binding must agree with `AGENTS.md`; conflicts require remediation.
4. Read mapped source, generated review surface, current run notes, project `MEMORY.md`, and relevant history.
5. For defects, capture one request id and find first semantic divergence. Keep one active hypothesis.
6. Record red evidence: focused failing test, saved failing shape, or controlled replay.
7. Keep the two response categories separate. A Provider HTTP/error response is control-plane failure: do not return it to the client; let the Error chain recover/reselect, then terminate only the affected transport if candidates are exhausted. A Provider's business/model response, including model-generated invalid tool arguments, is data-plane content: do not semantically judge it; preserve and forward it when representable so the client can correct the next turn. Add public-entry regressions for both categories.
8. Patch only mapped owner. For feature development or bug repair, add or update real public-entry black-box behavior tests. A controlled external peer or upstream is acceptable as long as the test enters through a real public entry (HTTP, WebSocket, or CLI); source-string checks, private unit-only tests, or mocks that do not reach the public entry do not satisfy this step. Each such test carries a stable test ID and records the exact command that executes it.
9. Run the affected positive, negative and side-effect checks through their recorded public commands. Retain checks with a concrete behavior, security or data-correctness guarantee; remove redundant source-text, identity and historical-output locks at their owner and callers. Do not automatically run a full architecture umbrella for every local edit. Reuse unchanged results. Before external release preparation, do not add SHA/checksum, frozen snapshots, candidate identity or packaging checks. Actual release checks cover distribution needs only.

For runtime changes, applicable local behavior verification precedes steps 10–11. Run applicable PR CI in parallel; pending remote CI does not delay authorized local runtime acceptance. Pure rule, tooling and test changes do not trigger a runtime install or restart.

10. Runtime-impacting change: load `references/50-rcc-config-ssot.md`; prove build, install, config check, managed restart, all-listener health, and same-entry replay. `rccv3 restart` controls an existing instance and exits non-zero with `NotRunning` when none is live, leaving the service down; a non-zero restart exit or a status that is not `running` is an incomplete step. Stop this lifecycle path and record the blocker. Do not substitute `start` or another lifecycle action unless that action is explicitly authorized by the applicable project contract or user.
11. If a failing runtime sample exists, include its exact replay or same-entry semantic equivalent in step 10 evidence. For tool/function-call flows, verify the full client round trip: tool identity/namespace, complete arguments, actual client execution receipt/output, and any follow-up request; HTTP 200 or `requires_action` alone is not tool success. Review only after verification; do not repeat an unchanged replay solely for this step.

## Defect Lifecycle

Every execution-bound defect uses the canonical issue intake and close contract
in the installed `~/.agents/skills/appsdk-project-governance/SKILL.md`. For the issue DAG,
per-restart Codex sample audit, and master residual-resource closeout, read
[`references/60-defect-lifecycle.md`](references/60-defect-lifecycle.md).
Repeated regressions require a regression test in the mapped required gate.

For any corresponding AppSDK bug record to close, including a functional work
item with such a record, the stable public-entry black-box test IDs and their
execution commands must be written into that record with
`appsdk bug comment <id> -m <test IDs and commands>`. Use the command receipt;
do not add a routine read-back gate. Close with `appsdk bug close` only after
all applicable delivery conditions pass. A failed or uncertain record write
requires checking that specific failure.

## Review Gate

The global host orchestrator owns review roles, timing and delivery order.
After author verification and applicable runtime acceptance, obtain one
effective independent overall review before commit/integration. Fix blocking
findings and revalidate their affected behavior. Report source, runtime and
delivery results separately without identity packaging; preserve Git
protection and the defect close conditions in `references/60-defect-lifecycle.md`.

## Routes

| Need | Reference |
| --- | --- |
| owner and gates | `references/40-owner-registry.md` |
| first-divergence pipe debug | `references/10-pipedebug-flow.md` |
| protocol/SSE/continuation | `references/25-protocol-sse-continuation-boundary.md` |
| config/install/runtime replay | `references/50-rcc-config-ssot.md` |
| servertool | V3 maps + `docs/agent-routing/30-servertool-lifecycle-routing.md` |
| error chain | `references/96-unified-error-path-audit.md` |
| selected provider model | `references/96-v3-selected-provider-model-binding-sop.md` |
| continuation cache | `references/97-continuation-cache-compliance.md` |
| provider request/error | `references/98-provider-request-dryrun-and-request-error-debug.md` |
| defect issue/sample/resource lifecycle | `references/60-defect-lifecycle.md` |

For an explicit provider/model pin, set the client request `model` to
`<provider_id>.<model_id>` (for example `kdns.deepseek-v4.1-flash`); this is
`provider.model` direct-pin syntax, not route-config `provider/model`. A known
`provider_id` with a known model selects that exact provider+model directly,
skipping route classification and pool selection; an unknown provider prefix
falls back to normal routing.

## Report

Report goal, owner, first divergence, changed paths, red/green evidence, mapped gates, installed runtime evidence, review result, remaining gap, and next transition. For defects, include issue ID/state, merge receipt, post-restart sample classifications, and resource-cleanup evidence. State why edited owner is unique and which adjacent layers were ruled out.
