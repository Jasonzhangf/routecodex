# V4 Branch Consolidation - 2026-09-22

Status: cleanup candidate rebased onto `origin/main@3f8b35145f30eab1247cb88bfa27ee53c7987047`.

Goal: align V4 work with the V3 feature baseline and the accepted V4 Cordis architecture without merging historical root/V3/AppSDK noise into `main`.

## Canonical Line

The canonical V4 architecture source for this cleanup is:

- `v4-cordis@593f9005db5f3d40773666f0edb7313085ab1bb3`
- matching worktree branch: `codex/v4-closeout-593f9005-0921`
- tip subject: `test(v4): wait for cordis daemon handshake`

This tip already contains the V4 SSE provider terminal chain and earlier lifecycle work:

- `codex/v4-sse-provider-terminal-0920@785a444d`
- `codex/cad5db7-v4-lifecycle-r3-0920@bc510564`
- `codex/v4-provider-reselect-fix-0920@6abbc3a7`
- `codex/v4-request-record-usage-0920@6f5d4dc`

Those branches are treated as absorbed into the canonical V4 line when their tip is an ancestor of `v4-cordis`, or as superseded by the canonical line when their remaining diff is dirty/stale evidence rather than a clean candidate.

## Merge Decision

Do not merge `v4-cordis` wholesale into repository `main`.

Reason: `main..v4-cordis` includes large non-V4 and root-governance drift, including `.agent-collab`, root `.appsdk`, root `docs/architecture/v3-*`, root skills, and generated/historical evidence. That drift is outside the current V4 architecture-alignment owner and would reintroduce stale governance and V3 documentation changes.

This cleanup instead imports only V4-owned architecture and high-level planning truth:

- Cordis mainline migration plan.
- Cordis mainline ADR and data/control-plane boundary docs.

It deliberately does not import `v4/docs/architecture/maps/*.json` from `v4-cordis` in this pass. A historical replay of those map changes on `main@2d4beecc2` failed the existing `verify:v4-node-graph` and `verify:v4-feature-layer-batches` gates. On the current cleanup base, those gates pass only with the existing `main` maps. The `v4-cordis` map changes must be replayed with the matching runtime implementation or a complete map/gate repair, not as a standalone cleanup import.

It also deliberately does not import unbound JSON contract/schema files from `v4-cordis` in this pass. Those files declare contract or ratchet intent, but the current `main` tree does not yet wire them into a registry, generated artifact, or gate consumer. They remain implementation candidates for a later red/green contract-binding pass, not current `main` truth.

## Drop / Defer Decisions

Drop from this integration pass:

- root `.agent-collab/**` run evidence and handoff files from historical V4 branches;
- root `.appsdk/**` SDK migration churn unrelated to the V4 subtree contract;
- root `docs/architecture/v3-*` and generated V3 evidence changes;
- old ignored or stale AppSDK records whose source tree does not match the current cleanup tree;
- dirty worktree-local artifacts under historical V4 playground checkouts.

Defer as implementation candidates, not cleanup imports:

- V4 architecture map changes under `v4/docs/architecture/maps/*.json`;
- V4 contract/schema imports under `v4/contracts/*.json` that are not yet bound to a gate or registry;
- detailed V4 task-board and milestone claim tables that still point at stale claim storage or old integration branches;
- V4 runtime code changes under `v4/crates/**` and `v4/cordis/**`;
- V4 AppSDK record graph regeneration under `v4/.appsdk/**`;
- install/restart/5520 live replay;
- branch/worktree deletion for dirty or active worktrees.

These require a separate red/green/review integration pass because they change runtime behavior and currently depend on the AppSDK admission record graph.

## Branch State Audit

Observed from repository root on 2026-09-21 local time:

| Branch | Disposition | Evidence |
| --- | --- | --- |
| `v4-cordis` | canonical source for V4 cleanup | `593f9005`, not ancestor of `main` |
| `codex/v4-closeout-593f9005-0921` | duplicate of canonical tip | same `593f9005` |
| `codex/v4-sse-provider-terminal-0920` | absorbed by canonical V4 line | `785a444d` is ancestor of `v4-cordis` |
| `codex/cad5db7-v4-lifecycle-r3-0920` | absorbed by canonical V4 line | `bc510564` is ancestor of `v4-cordis` |
| `codex/v4-provider-reselect-fix-0920` | absorbed by canonical V4 line | `6abbc3a7` is ancestor of `v4-cordis` |
| `codex/v4-request-record-usage-0920` | absorbed by canonical V4 line | `6f5d4dc` is ancestor of `v4-cordis` |
| `codex/v4-cordis-main-integration-r2-0920` | drop for this pass | contains `v4-cordis` but also stale integration drift |
| dirty V4 worktrees | defer/drop per exact owner | not mergeable until clean candidate, gate, and review |

## Next Integration Gate

After this cleanup commit, the next V4 implementation pass must start from a fresh worktree and choose one owner:

1. regenerate the current V4 AppSDK record graph against this cleanup tree, or
2. replay a minimal runtime implementation slice from `v4-cordis` into a fresh worktree.

Either path must run the applicable V4 gates and independent review before any merge to `main`, install, restart, or 5520 live acceptance.
