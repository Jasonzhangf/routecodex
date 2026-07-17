# V3 Skeleton / Edge / Control Architecture Audit Plan

## Goal

Audit RouteCodex V3 architecture against the skeleton-first contract:

- Big skeleton and small skeleton are separated.
- Data plane and control plane are separated end to end.
- Request metadata/control semantics are routed through a dedicated control center such as Metadata Center.
- Every write/mutation is traceable to request, owner, resource, and edge evidence.
- Module call chains are locked by explicit adjacent edges, not by convention.

This is an audit and architecture-locking task. Implementation fixes are out of scope unless a small documentation or gate correction is required to make the audit evidence queryable.

## Acceptance Criteria

- Produce an audit report listing V3 architecture violations, missing locks, and cleanly verified surfaces.
- For every finding, identify:
  - affected big skeleton / small skeleton;
  - feature owner;
  - resource id;
  - mainline edge id or missing edge;
  - data/control boundary;
  - traceability gap;
  - required gate or red fixture.
- Do not claim closure from grep alone. Every finding must be backed by map/doc/source/gate evidence.
- Do not mutate runtime behavior, live config, credentials, global installs, or server processes during the audit.

## Scope

In scope:

- V3 resource map, function map, mainline call map, verification map, lifecycle manifests, wiki/review docs.
- V3 Server, Runtime, Config, Target, Provider, Debug, Error, Continuation, Transport, and CLI/lifecycle skeleton surfaces.
- Existing V3 gates and red fixtures that claim to lock architecture boundaries.

Out of scope:

- V2 runtime behavior except where V3 config compatibility or live evidence explicitly depends on it.
- Provider account/credential debugging.
- Global install, restart, live replay, or production config mutation.
- Large implementation refactors. Create follow-up goals for fixes.

## Audit Rules

### 1. Big Skeleton / Small Skeleton Split

- Big skeleton owns stable topology: lifecycle, protocol entry, request/response mainline phases, resource relations, error chain, debug trace, transport boundary, and execution mode selection.
- Small skeleton owns local lifecycle under a big skeleton node: Direct, Relay, protocol codec, provider transport, continuation save/restore, WebSocket session, and provider-specific wire dispatch.
- Concrete features may only hang from a skeleton node. They must not create a second skeleton, bypass the skeleton, or reverse-control skeleton flow.

### 2. Data / Control Separation

- Client/provider request and response payloads are data plane.
- Routing, target selection, runtime control, continuation/store truth, debug, errors, transport state, auth handles, and resource ownership are control plane.
- Control plane must not enter provider/client normal payloads.
- Data plane fields must not be copied into Metadata Center as a second control truth unless a typed control projection owner explicitly exists.

### 3. Dedicated Control Center

- Intermediate request metadata/control must route through Metadata Center or a V3-equivalent dedicated control center.
- Client protocol inputs such as headers, body fields, `metadata`, `client_metadata`, and `x-*` remain transparent data/protocol input; they can be read but must not become hidden replacement truth.
- Control center writes must be typed, request-scoped, and owned by a named node.

### 4. Traceable Writes and Mutations

- Every write, mutation, projection, commit, release, target selection, provider send, transport state update, and error projection must answer:
  - who wrote;
  - which request/execution;
  - which node/edge;
  - which feature/resource owner;
  - what input it derived from;
  - which downstream owner consumes it;
  - how failure enters Error01-06.
- Hidden singleton state, unowned global cache, requestless mutation, and unlogged side-channel update are audit failures.

### 5. Edge-Locked Module Call Chains

- Skeleton call chains must be represented by explicit adjacent `from_node -> to_node` edges in `docs/architecture/v3-mainline-call-map.yml` or lifecycle manifests.
- Edges must bind caller, callee, owner feature, semantic input/output, and `resource_flow`.
- Resources are truth nodes, not call edges. Resource relationships must ride on call/lifecycle edges through `consumes`, `produces`, `side_channel_reads`, and `side_channel_writes`.
- Multi-source, multi-target, non-adjacent shortcut, undocumented callable path, and feature-local second path are architecture failures.

## Required Reading Order

1. `AGENTS.md`
2. `docs/agent-routing/05-foundation-contract.md`
3. `.agents/skills/rcc-dev-skills/SKILL.md`
4. `.agents/skills/rcc-dev-skills/references/24-node-contract-debug-method.md`
5. `.agents/skills/rcc-dev-skills/references/40-owner-registry.md`
6. `.agents/skills/rcc-dev-skills/references/70-gate-discovery.md`
7. `docs/architecture/v3-resource-operation-map.yml`
8. `docs/architecture/v3-function-map.yml`
9. `docs/architecture/v3-mainline-call-map.yml`
10. `docs/architecture/v3-verification-map.yml`

## Technical Plan

1. Refresh MemoryPalace and project memory for prior V3 architecture lessons.
2. Build an audit matrix from resource map, function map, mainline call map, verification map, and manifests.
3. Classify each V3 feature into big skeleton, small skeleton, or concrete implementation.
4. Check each feature has edge-locked adjacent caller/callee bindings.
5. Check each resource flow is carried by an edge and not by undocumented file/path convention.
6. Sample source for each high-risk skeleton surface and verify:
   - no control leakage into data payload;
   - no data field copied into control truth without owner;
   - no hidden mutation or requestless write;
   - no second path outside the edge map.
7. Check gates/red fixtures cover each architecture rule.
8. Produce an audit report with findings and follow-up fix goals.

## Files and Surfaces

Primary docs:

- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/manifests/*.yml`
- `docs/architecture/wiki/*.md`

Primary source surfaces:

- `v3/crates/routecodex-v3-server/`
- `v3/crates/routecodex-v3-runtime/`
- `v3/crates/routecodex-v3-config/`
- `v3/crates/routecodex-v3-target/`
- `v3/crates/routecodex-v3-provider-responses/`
- `v3/crates/routecodex-v3-debug/`
- `v3/crates/routecodex-v3-error/`
- `v3/crates/routecodex-v3-lifecycle/`
- `v3/crates/routecodex-v3-cli/`

## Verification Plan

Minimum audit gates:

- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-relation-edge-lock`

If touching docs/gates:

- matching verifier for changed map/feature;
- matching red fixture for any new architecture lock;
- `git diff --check`.

No live/runtime claim is allowed unless a later implementation goal explicitly authorizes global install/restart/live replay.

## Deliverables

- Audit report under `docs/goals/` or `docs/architecture/reviews/` with:
  - clean surfaces;
  - violations;
  - missing edges;
  - missing gates;
  - follow-up fix sequence.
- Optional map/gate documentation corrections only if needed for queryability.
- `note.md` update with audit evidence.
- `MEMORY.md` and local skill lesson only for verified reusable architecture findings.

## Definition of Done

- The audit report is written and references concrete files, edges, features, resources, and gates.
- Every finding has evidence and an owner.
- No unverified implementation completion is claimed.
- Remaining fixes are split into follow-up goals with priority and verification gates.
