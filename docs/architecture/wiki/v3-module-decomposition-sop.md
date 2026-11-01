# V3 Module Decomposition SOP（模块拆解）

Status: partial execution; the declared module split remains incomplete. Source-count gates, ratchet snapshots and fingerprint authorization wrappers are retired.

Recorded scope from prior module moves: `live_snapshot_projections.rs` owns foundation snapshot and observability projections. `anthropic_relay_runtime/response_closeout.rs` owns shared JSON/SSE closeout. `direct_execution_control.rs` and `direct_runtime_timing.rs` own control resolution and timing finalization. These records do not prove completion of other planned splits.

Feature owner: `v3.module_decomposition` in `docs/architecture/v3-function-map.yml`.
Historical plan: `docs/goals/v3-god-file-decomposition-plan.md`.
Review surface: `docs/architecture/wiki/html/v3-mainline-caller-flow.html`.

## Scope

Use this SOP for changes that move V3 runtime or server responsibilities to their unique modules. Keep the fixed skeleton, public entrypoints, payload/control separation and protocol behavior. A module move does not authorize a new runtime algorithm or a new owner.

## Execution

1. Read the affected DAG and current caller/resource maps. Name the responsibility being moved and its actual callers. Keep planned files pending until they exist.
2. Use the project's external worktree and orchestration flow. Coordinate overlapping files through the existing owner. Collab state and a second claim directory are not prerequisites for independent work.
3. Move code to the unique owner and delete the old implementation. Preserve crate-visible public paths where callers require them. Do not keep a forwarding wrapper solely to preserve a retired layout.
4. Update affected owner files, entry symbols and caller/callee paths in the same coherent change. Keep declarations truthful. Update debug-resource boundaries when the move affects a side channel. Regenerate an affected review surface once after the maps are coherent.
5. Verify the affected consumers and public entry. Select compilation, formatting, compile-fail or protocol regressions from the actual change. Reuse unchanged valid evidence. File length, source spelling and an umbrella run for every small move do not prove behavior.
6. Record changed behavior, actual results and remaining work in the existing run notes. At a complete milestone, perform one independent overall review and applicable CI before normal commit, integration and push. Internal nodes do not require separate review or a fixed number of commits.
7. Install or restart only when runtime acceptance requires it. Explain expected interruption before formal `rccv3 restart` (including the `rcc restart` alias); separate human approval is not required. Execute it once per new build and investigate failure before retrying. Start/stop, including all arguments and aliases, still need explicit human approval. Read listener configuration from its current source; do not copy a historical port list.

## Boundaries

- Preserve real protocol behavior, cancellation, resource accounting, retry, provider health and continuation guarantees. Test affected behavior at its public entry.
- Do not invent symbols or mark pending bindings implemented. A parsed map or a successful source-text check does not prove runtime execution.
- Do not compute development digests, refresh fingerprint records, create frozen source snapshots, or require an identity wrapper for review or delivery.
- Do not modify other owners' changes or bypass Git hooks. Keep the normal delivery and resource-cleanup flow.

## Progress

The decomposition status belongs to the feature map and run evidence. Retiring the old size gate does not complete module decomposition. Historical migration phases and their old gate results remain historical; they do not create current daily requirements.
