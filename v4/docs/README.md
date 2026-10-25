# RouteCodex V4

V4 is the isolated AppSDK-managed project root for the RouteCodex refactor.

V3 remains the existing runtime baseline. V4 must not modify, rename, or consume V3 source during bootstrap.

## Architecture

- [`architecture/v4-cordis-node-plugin-architecture.md`](architecture/v4-cordis-node-plugin-architecture.md) — reviewed target architecture: fixed Skeleton, Cordis NodeContainer, ordered NodePlugin chains, plugin library/manager, and WebUI management plane.
- [`architecture/v4-standard-nodes-and-node-graph.md`](architecture/v4-standard-nodes-and-node-graph.md) — standard node families and the fixed machine-controlled graph; its operator/hook composition is refined by the Cordis NodePlugin architecture.
- [`architecture/v4-data-control-plane-boundary.md`](architecture/v4-data-control-plane-boundary.md) — data/control physical-separation contract.
- [`architecture/v4-pipeline-abstraction-model.md`](architecture/v4-pipeline-abstraction-model.md) — six-axis pipeline abstraction and V3 coverage model.

## Architecture maps

The AppSDK version declared by `.appsdk/sdk.lock` owns the governance skeleton in `.appsdk/maps/`, and its
contents must remain exactly aligned with the SDK lock. V4 product truth lives in
`docs/architecture/maps/`: `function-map.json`, `resource-map.json`,
`mainline-call-map.json`, and `verification-map.json`. Architecture gates read
these product maps from that path; `.appsdk/maps/module-registry.json` remains
the AppSDK-owned module registry.

Review uses the current host's independent-review contract and the affected
product maps. Do not add map hashes or a DSH-only reviewer requirement to
ordinary development. Preserve the distinction between SDK governance and V4
product truth; architecture scripts must not read product truth from
`.appsdk/maps/`.

## Product completion

- [`goals/v4-feature-completion-plan.md`](goals/v4-feature-completion-plan.md) — product-completion source of truth: V3 feature parity states, production NodeContainer migration, protocol/provider/router/continuation/tool/admin/release closeout, evidence gates, and canary/cutover readiness.
- [`goals/v4-feature-completion-goal-prompt.md`](goals/v4-feature-completion-goal-prompt.md) — long-horizon `/goal` prompt for executing the completion plan phase by phase. It does not authorize automatic V3 cutover.

## Plans

- [`goals/v4-cordis-plugin-framework-and-webui-plan.md`](goals/v4-cordis-plugin-framework-and-webui-plan.md) — staged implementation and validation plan from foundational elements through plugin management, WebUI, and real-pipeline migration.
- [`goals/v4-foundation-framework-plan.md`](goals/v4-foundation-framework-plan.md) — V4 foundation and V3 reuse-audit plan.
- [`goals/v4-config-compiler-plan.md`](goals/v4-config-compiler-plan.md) — deterministic authoring-to-manifest compiler plan.
- [`goals/v4-long-horizon-goal-prompt.md`](goals/v4-long-horizon-goal-prompt.md) — historical umbrella goal retained for traceability; the feature-completion plan and prompt above define the current product-completion program.
