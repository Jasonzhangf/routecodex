# RouteCodex V4 AppSDK 0.1.3 Migration

## Decision

- Design ID: `v4-appsdk-0.1.3-migration-v1`.
- Base commit: `3a845cd50ae0a7c3cf0cf29bd5d25997b7a07d59`.
- Migration issue: AppSDK 0.1.3 rejects the 0.1.2 governance surface because Fix Lifecycle v2 contracts and the module registry are absent.
- Scope: V4 governance contracts, maps, SDK resources, lock, lifecycle records, and immutable Protected history only.
- Forbidden scope: V3, V4 runtime/config/source semantics, existing Active artifacts, and Generated hand edits.

## Version policy

The record contracts are declared inputs of every frozen V4 library. Their change is therefore a contract change, not an in-place lock edit. Migrate in dependency order: base-node first; edge, control, and error only after base-node is frozen again. Preserve every old immutable version:

| Module | Previous | New |
| --- | --- | --- |
| `routecodex-v4-base-node` | `active-v1` | `active-v2` |
| `routecodex-v4-edge` | `active-v3` | `active-v4` |
| `routecodex-v4-control` | `active-v2` | `active-v3` |
| `routecodex-v4-error` | `active-v3` | `active-v4` |

## Evidence contract

1. Reproduce the 0.1.3 admission failure from the clean base with the exact project inputs.
2. Candidate verification must include SDK/resource integrity, map/owner checks, positive 0.1.3 admission, negative 0.1.2 rejection after pin switch, and all four module regressions.
3. Architecture review binds the exact candidate commit/tree/diff, scope, artifact, and four map hashes; the reviewer supplies confidence and rationale.
4. After architecture PASS, rerun the same reproduction input plus positive, negative, and blackbox checks without source changes.
5. Treat `codex/v4-appsdk-0.1.3-migration` as the isolated integration mainline. Each module candidate must be an exact commit on that ref before its promotion, regression, freeze, and publish records are accepted.
6. Compile, freeze, and publish base-node before opening each dependent module. After all four modules pass, merge the exact integration head to `main` in one step.
7. Run global-binary verify/admission, build/install/restart RouteCodex, and replay an online sample before DSH Review.

No historical PASS is synthesized. Old 0.1.2 records are retained under versioned history and remain evidence only for their original releases.
