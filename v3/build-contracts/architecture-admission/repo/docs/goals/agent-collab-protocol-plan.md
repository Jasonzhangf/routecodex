# Agent Collab Protocol Plan

## Goal

Create a project-local `.agent-collab/` protocol for RouteCodex multi-worker collaboration. The first implementation layer is documentation, schemas, deterministic verification gates, red fixtures, and architecture map wiring only. It must not change runtime behavior.

## Acceptance Criteria

- `.agent-collab/` has a tracked protocol document, JSON schemas, and deterministic examples for black-box multi-worker coordination.
- Runtime collaboration artifacts are explicitly ignored while protocol, schema, and examples remain trackable.
- The protocol uses semantic claims, not file-path claims. Claim keys must support `feature_id`, `resource_id`, `mainline_node_id`, and `gate_id`.
- Atomic claim ownership is based on creating `.agent-collab/claims/<semantic_id>`.
- `run_id` is required for actor, owner, heartbeat, event, and evidence records. `worker_id` is optional.
- Stale heartbeat detection never authorizes high-risk takeover by itself.
- Completion requires append-only `evidence.jsonl`.
- Merge/submit defaults to handoff or merge queue instead of direct overwrite.
- Static verifier and red fixtures fail closed when protocol files, schemas, examples, or required rules are missing.
- Architecture maps bind the protocol to a truthful feature/resource owner and required gates.
- Existing resource/source-binding and architecture review gates remain green.

## Scope

In scope:

- `.agent-collab/PROTOCOL.md`
- `.agent-collab/schema/*.schema.json`
- `.agent-collab/examples/*`
- `.gitignore` entries for `.agent-collab/` runtime state
- `scripts/architecture/verify-agent-collab-protocol.mjs`
- `scripts/tests/agent-collab-protocol-red-fixtures.mjs`
- `package.json` gate wiring
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/resource-operation-map.yml` if a resource binding is required by gates
- `scripts/architecture/verify-function-map-build-wiring.mjs`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `note.md` and `MEMORY.md` after verification

Out of scope:

- Runtime behavior changes
- Provider, Hub Pipeline, Virtual Router, restart, install, or live server changes
- Global install, release, live restart, or process management
- Directly merging or overwriting another worker's dirty work
- Reintroducing fallback, checkout/reset cleanup, or path-based ownership

## Design Principles

- Treat workers as black boxes. No shared in-memory control plane, daemon state, tmux state, or hidden tool state is collaboration truth.
- Files under `.agent-collab/` are the only project-local collaboration contract.
- Claims are semantic and architecture-bound. A worker claims a feature/resource/mainline node/gate, not an arbitrary file.
- Claims are append-only or atomically created. Conflict must be visible and fail-fast.
- Completion is evidence-backed. A worker cannot declare done without command/check results in evidence.
- Merge is explicit. Completed work goes through handoff or merge queue unless Jason explicitly authorizes direct mutation.
- The protocol is a governance resource, not a runtime resource. Do not bind it to provider/client payload or runtime request/response semantics.

## Technical Plan

### Protocol Surface

Create `.agent-collab/PROTOCOL.md` with:

- Directory layout and tracked/ignored boundary.
- Required `run_id` format and optional `worker_id`.
- Actor lifecycle.
- Semantic claim model.
- Atomic `mkdir .agent-collab/claims/<semantic_id>` claim rule.
- Heartbeat contract and stale heartbeat handling.
- Append-only event and evidence model.
- Completion rule requiring `evidence.jsonl`.
- Handoff and merge queue default.
- Conflict and takeover rules.
- Forbidden operations: path-only ownership, stale-heartbeat takeover, destructive cleanup of others' work, direct overwrite of unrelated dirty changes, fallback success.

### Schemas

Create JSON schemas:

- `.agent-collab/schema/actor.schema.json`
- `.agent-collab/schema/owner.schema.json`
- `.agent-collab/schema/heartbeat.schema.json`
- `.agent-collab/schema/event.schema.json`
- `.agent-collab/schema/evidence.schema.json`

Minimum required fields:

- Actor: `run_id`, `cwd`, `git_worktree`, `created_at`
- Owner: `semantic_id`, `run_id`, `status`, `created_at`, `ttl_seconds`, `allowed_paths`, `required_gates`
- Heartbeat: `run_id`, `status`, `updated_at`
- Event: `run_id`, `event_type`, `timestamp`
- Evidence: `run_id`, `claim`, `command_or_check`, `result`, `timestamp`

### Examples

Create deterministic examples under `.agent-collab/examples/` using fake non-secret values:

- Actor example
- Owner claim example
- Heartbeat example
- Event example
- Evidence JSONL example
- Handoff or merge queue example

### Ignore Boundary

Update `.gitignore` so runtime state is ignored while authoring contract remains tracked:

- Ignore `.agent-collab/runs/`
- Ignore `.agent-collab/claims/`
- Ignore `.agent-collab/handoff/`
- Ignore `.agent-collab/merge-queue/`
- Ignore `.agent-collab/KILL_SWITCH`
- Do not ignore `.agent-collab/PROTOCOL.md`
- Do not ignore `.agent-collab/schema/`
- Do not ignore `.agent-collab/examples/`

### Verifier

Create `scripts/architecture/verify-agent-collab-protocol.mjs`.

The verifier must:

- Parse all schema files as JSON.
- Validate required fields in each schema.
- Validate example files against the minimum required fields without adding external dependencies.
- Check protocol text contains required rules:
  - semantic claims include `feature_id`, `resource_id`, `mainline_node_id`, `gate_id`
  - atomic claim path `.agent-collab/claims/<semantic_id>`
  - stale heartbeat does not authorize high-risk takeover
  - completion requires `evidence.jsonl`
  - merge or submit defaults to `handoff/` or `merge-queue/`
- Fail closed with actionable messages.

### Red Fixtures

Create `scripts/tests/agent-collab-protocol-red-fixtures.mjs`.

Negative cases must prove fail-closed behavior for:

- Missing `PROTOCOL.md`
- Invalid JSON schema
- Owner schema missing `semantic_id`
- Actor schema missing `run_id`
- Heartbeat schema missing `updated_at`
- Evidence schema missing `result`
- Protocol omits stale heartbeat non-takeover rule
- Protocol omits evidence-required completion rule
- Protocol omits handoff/merge queue rule

### Gate Wiring

Add npm scripts:

- `verify:agent-collab-protocol`
- `test:agent-collab-protocol-red-fixtures`

Wire:

- `verify:agent-collab-protocol` into `verify:architecture-review-surface-light`
- `test:agent-collab-protocol-red-fixtures` into `verify:architecture-ci-longtail`
- `verify-function-map-build-wiring.mjs` must fail if these gates are removed from their intended paths.

### Architecture Maps

Add a truthful feature entry:

- `feature_id`: `architecture.agent_collab_protocol`
- Owner: architecture governance contract / verifier
- Source anchor: verifier script and protocol document
- Allowed paths: `.agent-collab/`, verifier, red fixture, maps, local skill/docs
- Forbidden paths: runtime source, provider runtime, Hub Pipeline, Virtual Router, restart/install lifecycle unless a later goal explicitly changes scope
- Required gates: verifier, red fixtures, function-map compile gate, architecture review surface

If resource gates require a resource, add:

- `resource_id`: `architecture.agent_collab_protocol_contract`
- Kind: governance contract
- Lifecycle: architecture collaboration protocol
- Owner feature: `architecture.agent_collab_protocol`
- Operations: read/write only on protocol/schema/examples and verification artifacts
- Forbidden: provider/client payload, runtime request/response, metadata carrier, error chain, live process state

Do not fabricate runtime symbols. Mark any unresolved code binding as pending only if the existing gate format permits pending governance docs; otherwise bind to actual verifier/protocol files.

### Skill And Memory

Update `.agents/skills/rcc-dev-skills/SKILL.md` only with reusable rules:

- Check `.agent-collab/` before code/config/long gate work.
- Claim semantic owner before writing.
- Preserve unrelated dirty worktree.
- Never use checkout/reset to clean other workers' changes.
- Completion requires evidence and merge/handoff queue.

After successful verification:

- Append evidence to `note.md`.
- Promote durable truth to `MEMORY.md`.
- Mine the same MemoryPalace wing and verify searchability.

## Verification Matrix

Required direct gates:

- `npm run verify:agent-collab-protocol`
- `npm run test:agent-collab-protocol-red-fixtures`
- `npm run verify:function-map-compile-gate`
- `npm run verify:function-map-build-wiring`
- `npm run verify:architecture-review-surface-light`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `npm run audit:resource-global-coverage`
- `npm run verify:resource-source-bindings`
- `git diff --check`

Memory closeout:

- `mempalace mine . --wing routecodex --agent codex`
- `mempalace search "RouteCodex agent collab protocol gate" --wing routecodex --results 5`

Do not claim completion if any required gate is not run or fails. If a gate is unavailable because of unrelated dirty work, report the exact blocker and do not mark the task complete.

## Implementation Order

1. Read global/project AGENTS, USER profile, coding principles, rcc-dev skill, function map, verification map, resource map, and current goal document.
2. Confirm dirty worktree and preserve unrelated changes.
3. Create `.agent-collab/` protocol, schemas, examples, and ignore boundary.
4. Implement verifier.
5. Implement red fixture harness.
6. Wire package gates and build-wiring guard.
7. Add architecture feature/resource/verification bindings.
8. Update project local skill only for reusable multi-worker protocol rules.
9. Run direct verifier and red fixtures.
10. Run architecture/source-binding gates.
11. Update `note.md`, `MEMORY.md`, and MemoryPalace.
12. Report changes, evidence, remaining risks, and next step.

## Risks And Mitigations

- Risk: accidentally turning collaboration protocol into runtime behavior.
  - Mitigation: forbid runtime source paths in feature map and keep verifier/doc-only scope.
- Risk: path-based claims reappear.
  - Mitigation: protocol and verifier require semantic IDs.
- Risk: stale heartbeat is treated as takeover permission.
  - Mitigation: protocol and red fixture lock non-takeover rule.
- Risk: examples drift from schemas.
  - Mitigation: verifier validates examples against minimum required fields.
- Risk: gate exists but is not on architecture path.
  - Mitigation: build-wiring guard checks script wiring.
- Risk: dirty worktree from another worker is overwritten.
  - Mitigation: no checkout/reset, no broad cleanup, precise patches only.

## Definition Of Done

- The project has a tracked `.agent-collab/` authoring contract and ignored runtime-state boundary.
- The verifier and red fixtures prove the protocol is present, parseable, and fail-closed.
- Architecture maps expose the protocol as a queryable governance feature/resource with required gates.
- Architecture review surface includes the protocol verifier.
- CI longtail includes protocol red fixtures.
- Source-binding and resource coverage gates remain green.
- Local skill and project memory contain only durable reusable rules.
- Final report includes changed scope, exact verification evidence, unresolved risks, and the next task.
