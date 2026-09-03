# RouteCodex Agent Contract

## Project

RouteCodex is a multi-protocol, multi-entry proxy gateway.

```text
client -> HTTP server -> Hub Pipeline -> Provider V2 -> upstream
```

Direction: preserve meaning; normalize before governance; keep semantic runtime ownership in Rust Chat Process; keep control state outside business payload; fail fast on invalid or unsupported semantics.

## Highest Rules

1. History immutable. No history rewrite.
2. No request cleanup, guessed repair, fallback, downgrade, silent drop, or compensation path.
3. Control state uses typed side-channel, MetadataCenter, or Error chain only.
4. Payload must not reconstruct control state.
5. One semantic owner, one implementation, adjacent pipeline conversion only.
6. No edits to `main`, dirty worktrees, or another worker's files.
7. No semantic bulk replacement scripts. Read, verify context, use reviewable `apply_patch` hunks.

## Pipeline

Request:

```text
ServerReqInbound01ClientRaw -> HubReqInbound02Standardized
 -> HubReqChatProcess03Governed -> VrRoute04SelectedTarget
 -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload
 -> ProviderReqOutbound07TransportRequest
```

Response:

```text
ProviderRespInbound01Raw -> HubRespInbound02Parsed
 -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic
 -> ServerRespOutbound05ClientFrame
```

Owners: inbound parses; Chat Process governs and owns continuation restore/save; Virtual Router selects; outbound builds provider wire or projects client protocol; provider runtime handles transport/auth/compatibility; Direct preserves protocol; Relay uses adjacent codecs; Stopless current-turn projection uses registered Rust Req04/Resp03 owners.

Error chain:

```text
ErrorErr01SourceRaised -> ErrorErr02HostCaptured
 -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied
 -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected
```

No skipped, duplicated, or local error policy.

## Work

Before code: read `05-foundation-contract.md`; locate owner, resource edges, mainline edges, gates, allowed/forbidden paths; record baseline and red evidence; create clean owner worktree from latest `origin/main`.

After code: audit diff boundaries; run targeted gates; runtime change requires build, install, `routecodex restart`, all health endpoints, same-entry replay; review only after validation; merge only reviewed unchanged verified changes.

Build/test offline or mock-only. Live replay explicit.

## Git Protection

Each governed root requires executable `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/setup/enable-local-protection.sh`, enabled `core.hooksPath`, and `verify:local` / `verify:ci` profiles.

```bash
npm run setup:git-main-protection
appsdk verify-git-main-protection .
```

`pre-commit` rejects `main`/`master`; `pre-push` rejects protected refs. Hook PASS proves Git protection only.

## Routing

| Need | Read |
| --- | --- |
| completion contract | `docs/agent-routing/05-foundation-contract.md` |
| task routing | `docs/agent-routing/00-entry-routing.md` |
| runtime ownership | `docs/agent-routing/10-runtime-ssot-routing.md` |
| build/release | `docs/agent-routing/20-build-test-release-routing.md` |
| servertool/stopless | `docs/agent-routing/30-servertool-lifecycle-routing.md` |
| task memory | `docs/agent-routing/40-task-memory-routing.md` |
| V3 architecture | `.agents/skills/rcc-v3-architecture/SKILL.md` |
| debug method | `.agents/skills/rcc-dev-skills/SKILL.md` |
| AppSDK lifecycle | `.appsdk/skills/appsdk-project-governance/SKILL.md` |

## Evidence

No evidence, no completion claim. Report changed owner/paths, commands/results, proven level, remaining gap, next transition. Facts: `MEMORY.md`; run notes: `.agent-collab/runs/<run_id>/`; reusable method: skills.
