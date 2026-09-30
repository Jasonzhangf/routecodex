---
name: rcc-dev-skills
description: "RouteCodex V3 transparent-proxy development/debug: maximize cross-protocol passage; never block a passable request or response with extra validation. For 502/598/599, routing, provider, protocol/SSE, or tool failures, read the DAGPipe graph first, find the first divergence, and replay the installed entry. Active config: ~/.rcc/config.toml; samples: ~/.rcc/codex-samples."
---

# RouteCodex V3 Development

This skill owns V3 command and gate sequencing. Inherit general methods from `coding-principals` and boundaries from project `AGENTS.md`; do not also run a generic development phase workflow. Pure instruction/document edits validate affected references and contracts; runtime build/install/restart/replay applies only when runtime behavior or its delivery changes.

## Command-First Flow

1. Read `AGENTS.md`.
   For a module under DAGPipe governance, first read `docs/architecture/dagpipe/README.md` and its business graph. Correct and review the target graph against the proxy contract, then compare it with the maps, code and same-entry evidence. Run `npm run verify:v3-dagpipe-governance` for registered static graphs. An unregistered module remains pending; CLI validation does not prove SDK compile or runtime execution.
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
7. Patch only mapped owner. For feature development or bug repair, add or update real public-entry black-box behavior tests. A controlled external peer or upstream is acceptable as long as the test enters through a real public entry (HTTP, WebSocket, or CLI); source-string checks, private unit-only tests, or mocks that do not reach the public entry do not satisfy this step. Each such test carries a stable test ID and records the exact command that executes it.
8. Run positive and negative tests, then run feature `required_gates`, including the public-entry black-box tests by their recorded commands, then project architecture gate:

```bash
npm run verify:v3-architecture-ci
```

For runtime code changes, passing local gates on the exact candidate immediately triggers steps 9–10. Run GitHub PR CI in parallel; pending remote CI does not delay local candidate runtime acceptance.

9. Runtime-impacting change: load `references/50-rcc-config-ssot.md`; prove build, install, config check, managed restart, all-listener health, and same-entry replay. `rccv3 restart` controls an existing instance and exits non-zero with `NotRunning` when none is live, leaving the service down; a non-zero restart exit or a status that is not `running` is an incomplete step. Stop this lifecycle path and record the blocker. Do not substitute `start` or another lifecycle action unless that action is explicitly authorized by the applicable project contract or user.
10. If a failing runtime sample exists, include its exact replay or same-entry semantic equivalent in step 9 evidence. For tool/function-call flows, verify the full client round trip: tool identity/namespace, complete arguments, actual client execution receipt/output, and any follow-up request; HTTP 200 or `requires_action` alone is not tool success. Review only after verification; do not repeat an unchanged replay solely for this step.

## Defect Lifecycle

Every execution-bound defect uses the canonical issue intake and close contract
in `.appsdk/skills/appsdk-project-governance/SKILL.md`. For the issue DAG,
per-restart Codex sample audit, and master residual-resource closeout, read
[`references/60-defect-lifecycle.md`](references/60-defect-lifecycle.md).
Repeated regressions require a regression test in the mapped required gate.

For any corresponding AppSDK bug record to close, including a functional work
item with such a record, the stable public-entry black-box test IDs and their
execution commands must be written into that record with
`appsdk bug comment <id> -m <test IDs and commands>`, then read back with
`appsdk bug show <id> --json` and confirmed before close. A record without that
read-back confirmation stays open. Close it with `appsdk bug close` only after
that confirmation exists and all other applicable delivery conditions pass.

## Review Gate

After author verification and before commit/merge, run the ordinary reviewers
required by global `AGENTS.md` L3: Codex Review and AGY Review. Bind both to the
same validated candidate SHA and apply their shared review standards, project
Semantic Invariants, and mapped owner/edge/gate bindings. Do not duplicate the
shared checklist or historical-finding policy here.
Merge still requires applicable review and PR CI PASS. After merge, rebuild,
install, managed restart, and replay from `main`; candidate acceptance does not
prove the merged runtime.

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
`provider.model` direct-pin syntax, not route-config `provider/model`.

## Report

Report goal, owner, first divergence, changed paths, red/green evidence, mapped gates, installed runtime evidence, review result, remaining gap, and next transition. For defects, include issue ID/state, merge receipt, post-restart sample classifications, and resource-cleanup evidence. State why edited owner is unique and which adjacent layers were ruled out.
