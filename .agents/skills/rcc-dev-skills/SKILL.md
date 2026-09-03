---
name: rcc-dev-skills
description: RouteCodex debug and development routing. Find root cause, owner, evidence.
---

# RCC Dev Skill

## Trigger

RouteCodex development, debug, architecture, provider, SSE, protocol, routing, continuation, or runtime work.

## Order

1. Read `AGENTS.md` and `docs/agent-routing/05-foundation-contract.md`.
2. Resolve feature, resource, function, mainline, and verification maps.
3. Read mainline source and review surface.
4. Check history for prior fix and regression point.
5. Capture request id, entry, port, direct/relay, full raw request, provider request/response, client projection.
6. Lock one hypothesis and first divergence.
7. Write red test or failing sample.
8. Patch unique owner; test positive and negative paths.
9. Runtime change: build -> install -> `routecodex restart` -> all health -> same-entry replay.
10. Review after validation only.

## Hard Rules

- No fallback, downgrade, silent drop, guessed repair, or compensation.
- No semantic bulk replacement scripts. Use read -> context check -> `apply_patch`.
- Control state stays in typed side-channel / MetadataCenter / Error chain.
- Payload never reconstructs control state.
- One owner. Adjacent conversion only.
- Do not edit `main`, dirty worktrees, or another worker's files.

## Provider A/B/C

- A: minimal direct provider request.
- B: exact failed `provider-request.json` direct to same provider.
- C: exact client request through RouteCodex.

A fail -> provider/key/model/endpoint. A pass + B fail -> provider-bound construction. A+B pass + C fail -> transport/parse/projection. Missing B or raw response -> no attribution.

## Boundaries

Rust Chat Process owns semantic governance. Virtual Router selects. Provider runtime handles transport/auth/compatibility. Adjacent codecs convert protocol. SSE frames/parses syntax. Handler/outbound transports/projects. Direct preserves protocol. Relay uses adjacent codecs.

## References

| Topic | Reference |
| --- | --- |
| owner/gates | `references/21-change-workflow.md`, `references/40-owner-registry.md` |
| pipe debug | `references/10-pipedebug-flow.md` |
| SSE/continuation | `references/25-protocol-sse-continuation-boundary.md` |
| servertool/stopless | `references/22-servertool-hook-skeleton-workflow.md`, `references/95-v3-stopless-sop.md` |
| config truth | `references/50-rcc-config-ssot.md` |
| error path | `references/96-unified-error-path-audit.md` |
| provider dry-run | `references/98-provider-request-dryrun-and-request-error-debug.md` |
| continuation cache | `references/97-continuation-cache-compliance.md` |
| V3 invariant index | `references/90-invariant-index.md` |
| memory/skill | `references/60-note-memory-flow.md`, `references/80-skill-routing-convention.md` |

Report owner, first divergence, patch, positive/negative validation, proven runtime level, remaining gap.
