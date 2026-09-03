# RouteCodex Agent Contract

## Correctness

Right:

- Transparent proxy behavior.
- Meaning preserved across protocols and hops.
- Compatibility retained where target protocol supports it.
- Necessary semantic changes explicit, minimal, and contract-bound.
- Invalid or unsupported semantics fail visibly at owning boundary.
- Governance chain is part of the engineering product; its quality gate is mandatory and outranks local code convenience.
- Engineering quality is actively managed; a quality blocker requires a repair path, not passive waiting.

Wrong:

- Hidden payload rewrite, history rewrite, guessed repair, silent drop, or fallback.
- Provider-specific behavior in shared Hub/Router logic.
- Control state in business payload.
- One semantic rule implemented by multiple owners.
- Claiming runtime completion from local tests alone.
- Inbound cleanup, semantic deletion, or early protocol conversion.
- Fallback used to hide an unhandled case.
- Code changed before error reproduction, root-cause proof, and edit-owner decision.
- Unreviewed architecture merged into the project.

## Total Rules

1. History immutable. No history rewrite.
2. No request cleanup, guessed repair, fallback, downgrade, silent drop, or compensation path.
3. Control state uses typed side-channel, MetadataCenter, or Error chain only.
4. Payload must not reconstruct control state.
5. One semantic owner, one implementation, adjacent pipeline conversion only.
6. No edits to `main`, dirty worktrees, or another worker's files.
7. No semantic bulk replacement scripts. Read, verify context, use reviewable `apply_patch` hunks.

## Project

RouteCodex is a multi-protocol, multi-entry proxy gateway:

```text
client -> HTTP server -> Hub Pipeline -> Provider V2 -> upstream
```

Proxy baseline:

- Transparent: preserve request/response intent and observable protocol behavior.
- Minimal change: inbound performs field-level normalization only; no cleanup or semantic loss.
- Chat Process: receives normalized fields and owns semantic governance.
- Compatible: outbound converts according to target protocol and preserves compatible semantics.
- Necessary loss: discard only when target is incompatible and no compatible projection exists; make loss explicit and observable.
- No fallback: handle each case explicitly; do not hide unsupported behavior with a second path.
- Boundary ownership: inbound normalizes, Chat Process governs, outbound converts for target.

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

## Governance And Work

Governance chain is required code infrastructure, not paperwork. Manage engineering quality as a first-class lifecycle. A quality problem is a repair task; do not wait for external rescue when a forward repair is possible.

Error workflow: observe the failure -> build a repeatable reproduction -> locate first divergence -> prove root cause -> choose unique owner and edit method -> patch.

Before edit: read `05-foundation-contract.md`; locate owner, resource edges, mainline edges, gates, allowed/forbidden paths; record baseline and red evidence; create clean owner worktree from latest `origin/main`. Until edit method and owner are confirmed, draft only in `playground/`.

After code: audit diff boundaries and architecture; run targeted gates; runtime change requires build, install, `routecodex restart`, all health endpoints, same-entry replay; review must confirm architecture correctness before merge; merge only reviewed unchanged verified changes.

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
