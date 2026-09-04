---
name: rcc-dev-skills
description: "RouteCodex V3 evidence-first development: query resource/function/mainline/verification maps, prove first divergence, patch one owner, then run mapped gates and installed same-entry replay. Use for debug, protocol, provider, routing, continuation, SSE, servertool, or runtime changes."
---

# RouteCodex V3 Development

## Command-First Flow

1. Read `AGENTS.md`.
2. Query maps before source:

```bash
rcc_task_feature='<feature_id>'
rg -n "feature_id: ${rcc_task_feature}" \
  docs/architecture/v3-resource-operation-map.yml \
  docs/architecture/v3-function-map.yml \
  docs/architecture/v3-mainline-call-map.yml \
  docs/architecture/v3-verification-map.yml
```

3. Lock resource edge, owner, allowed/forbidden paths, caller/callee, and required gates. Missing or ambiguous binding blocks edits.
4. Read mapped source, generated review surface, current run notes, project `MEMORY.md`, and relevant history.
5. For defects, capture one request id and find first semantic divergence. Keep one active hypothesis.
6. Record red evidence: focused failing test, saved failing shape, or controlled replay.
7. Patch only mapped owner. Run positive and negative tests.
8. Run feature `required_gates`, then project architecture gate:

```bash
npm run verify:v3-architecture-ci
```

9. Runtime-impacting change: load `references/50-rcc-config-ssot.md`; prove build, install, config check, managed restart, all-listener health, and same-entry replay.
10. Replay exact old sample or same-entry semantic equivalent. Review only after verification.

## Routes

| Need | Reference |
| --- | --- |
| owner and gates | `references/40-owner-registry.md` |
| first-divergence pipe debug | `references/10-pipedebug-flow.md` |
| protocol/SSE/continuation | `references/25-protocol-sse-continuation-boundary.md` |
| config/install/runtime replay | `references/50-rcc-config-ssot.md` |
| servertool/Stopless | `references/95-v3-stopless-sop.md` |
| error chain | `references/96-unified-error-path-audit.md` |
| selected provider model | `references/96-v3-selected-provider-model-binding-sop.md` |
| continuation cache | `references/97-continuation-cache-compliance.md` |
| provider request/error | `references/98-provider-request-dryrun-and-request-error-debug.md` |

## Report

Report goal, owner, first divergence, changed paths, red/green evidence, mapped gates, installed runtime evidence, review result, remaining gap, and next transition. State why edited owner is unique and which adjacent layers were ruled out.
