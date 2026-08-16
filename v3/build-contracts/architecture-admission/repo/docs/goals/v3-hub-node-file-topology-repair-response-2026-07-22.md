# V3 Hub Node File Topology Repair Response — 2026-07-22

- response_id: v3-hub-node-file-topology-repair-response-20260722
- source_review: /Users/fanzhang/github/rules/routecodex/reviews/routecodex-node-file-topology-review-20260722.md
- target_model: /Users/fanzhang/github/rules/routecodex/reviews/routecodex-node-file-topology-discussion-20260722.md
- work_repo: /Users/fanzhang/github/routecodex
- rules_repo: /Users/fanzhang/github/rules
- run_id: 20260722T040240Z-Macstudio.local-11915-b266ea1c-v3-hub-node-topology-repair
- status: needs_review

## Diagnosis Contract

```yaml
status: passed
symptom:
  observed: V3 Hub v1 source was already split into node files, but map/rule/gate surfaces still allowed root hub_v1.rs owner assumptions.
  expected: Each V3 Hub contract node has one owning split file; builder/parser colocates with the target node; hub_v1.rs is only module declaration/reexport/test-mod surface; maps and gates bind real split owner files.
  entry: Static architecture review handoff RCR-20260722-node-file-topology.
  ids:
    report: /Users/fanzhang/github/rules/routecodex/reviews/routecodex-node-file-topology-review-20260722.md
    target_model: /Users/fanzhang/github/rules/routecodex/reviews/routecodex-node-file-topology-discussion-20260722.md
  raw_evidence:
    - Source probe: v3/crates/routecodex-v3-runtime/src/hub_v1.rs contains only mod/pub use/test mod and no top-level fn/struct/enum/impl.
    - Initial map probe: node builders still had stale hub_v1.rs bindings in docs/architecture/v3-mainline-call-map.yml.
    - Final mainline probe: docs/architecture/v3-mainline-call-map.yml has root_hub_v1_file_bindings=0 and no V3HubRelayResponseHooks stale alias.
    - Function/verification maps previously lacked first-class node_owner_files/shared_helper_owner_files and dedicated topology gates.
sop_model_flow:
  status: known
  flow_id: v3-hub-v1-node-file-topology
  source_docs:
    - AGENTS.md
    - docs/agent-routing/05-foundation-contract.md
    - docs/agent-routing/00-entry-routing.md
    - .agents/skills/rcc-dev-skills/SKILL.md
    - .agents/skills/rcc-dev-skills/references/24-node-contract-debug-method.md
    - docs/design/pipeline-type-topology-and-module-boundaries.md
    - docs/architecture/v3-function-map.yml
    - docs/architecture/v3-mainline-call-map.yml
    - docs/architecture/v3-verification-map.yml
  lifecycle_nodes:
    - hub_v1 root aggregator exports module surface only
    - request contract node files own Req01 through Req09 node structs and adjacent builders
    - response contract node files own Resp01 through Resp06 node structs and adjacent builders
    - shared helper files own reusable cross-node helpers only
    - maps/gates bind actual split owner files and reject stale root owner bindings
  resource_edges:
    - node_file -> target node struct/builder
    - root_aggregator -> module declarations/reexports only
    - shared_helper -> declared multi-node helper boundary only
    - architecture_maps -> real node owner files and topology verification gates
  forbidden_edges:
    - root_aggregator -> node struct/builder implementation
    - shared_helper -> node-local builder/parser implementation
    - mainline/function/verification maps -> stale hub_v1.rs owner for node-local symbols
    - provider compat branch numbering -> undocumented or ambiguous chain position
hypotheses:
  - id: H1
    cause: Hub V1 node split completed in source, but architecture maps, gate scripts, and local rule text still used pre-split root-module owner assumptions.
    modules:
      - docs/architecture/v3-mainline-call-map.yml
      - docs/architecture/v3-function-map.yml
      - docs/architecture/v3-verification-map.yml
      - scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs
      - scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs
      - scripts/architecture/verify-v3-architecture-docs.mjs
      - docs/design/pipeline-type-topology-and-module-boundaries.md
      - .agents/skills/rcc-dev-skills
    supporting_evidence:
      - Split node files define node structs/builders; root hub_v1.rs has no implementation definitions.
      - Mainline map had stale root file references for controlled relay/runtime closeout/servertool/tool-governance edges in addition to fixed skeleton edges.
      - Existing gates did not fail all stale root mappings until the new topology gate was widened to all Hub v1 mainline bindings.
    counter_evidence_or_gap:
      - Source node split itself was structurally correct; root cause was map/gate/rule drift, not runtime semantic source drift.
      - Real live/runtime proof was outside this review scope.
    verification_action: Static map/source topology probe plus deterministic positive gate and red fixtures.
    confidence: 95
active_hypothesis: H1
confirmed_hypothesis: H1
first_divergence_node: architecture map/gate boundary after source node split
root_cause_module: docs/architecture maps plus missing/diffuse topology gates/rule text
unique_owner: v3.hub_pipeline_static_skeleton map/gate/doc surface
allowed_paths:
  - docs/architecture/v3-mainline-call-map.yml
  - docs/architecture/v3-function-map.yml
  - docs/architecture/v3-verification-map.yml
  - docs/design/pipeline-type-topology-and-module-boundaries.md
  - scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs
  - scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs
  - scripts/architecture/verify-v3-architecture-docs.mjs
  - package.json
  - .agents/skills/rcc-dev-skills/SKILL.md
  - .agents/skills/rcc-dev-skills/references/24-node-contract-debug-method.md
  - docs/goals/v3-hub-node-file-topology-repair-response-2026-07-22.md
  - note.md
  - MEMORY.md
  - .agent-collab/runs/20260722T040240Z-Macstudio.local-11915-b266ea1c-v3-hub-node-topology-repair
forbidden_paths:
  - /Users/fanzhang/github/rules
  - ~/.rcc
  - provider credentials/config
  - global install/restart/live runtime
  - V3 runtime semantic implementation changes
required_verification:
  - npm run verify:v3-hub-v1-node-file-topology
  - npm run test:v3-hub-v1-node-file-topology-red-fixtures
  - npm run verify:architecture-mainline-call-map
  - npm run verify:function-map-compile-gate
  - npm run verify:v3-architecture-docs
  - npm run verify:v3-module-boundaries
  - git diff --check
exact_replay: static map/source topology probe plus topology positive gate/red fixtures; live provider replay not applicable to map/gate/doc repair.
changed_paths_match_allowed_paths: true_via_base_contract_and_amendment_01
scope_invalidated: false
```

Additional diagnosis amendment:

- `.agent-collab/runs/20260722T040240Z-Macstudio.local-11915-b266ea1c-v3-hub-node-topology-repair/diagnosis-contract-amendment-01-mainline-gate-coverage.md`
- Reason: final probe found non-H1-chain mainline edges still mapped to root `hub_v1.rs`; same flow/owner, no runtime/config/rules scope change. The repair widened the topology gate to all Hub v1 mainline bindings and kept `verify-v3-architecture-docs` strict for actual file/symbol binding.

## Finding Responses

### RCR-20260722-01

```yaml
finding_id: RCR-20260722-01
status: fixed
changed_paths:
  - docs/architecture/v3-mainline-call-map.yml
evidence:
  - Mainline map now binds V3 Hub node builders/response hook symbols to actual split owner files, including controlled relay chains, runtime closeout, servertool lifecycle, tool/servertool parity, and protocol-boundary rows.
  - Static probe: root_hub_v1_file_bindings=0.
  - npm run verify:v3-hub-v1-node-file-topology: ok; checked Hub V1 mainline bindings: 270.
  - npm run verify:architecture-mainline-call-map: ok; chains=23, edges=124, shared_functions=35.
notes: hub_v1.rs remains absent from caller_file/callee_file bindings for Hub v1 symbols; root aggregator is no longer a map owner for split-node builders.
```

### RCR-20260722-02

```yaml
finding_id: RCR-20260722-02
status: fixed
changed_paths:
  - docs/architecture/v3-function-map.yml
  - docs/architecture/v3-verification-map.yml
evidence:
  - v3.hub_pipeline_static_skeleton now distinguishes module_export_owner_file from node_owner_files and shared_helper_owner_files.
  - node_owner_files lists all 17 V3 Hub v1 contract nodes with owner_file and builder_symbol.
  - required_gates includes npm run verify:v3-hub-v1-node-file-topology and npm run test:v3-hub-v1-node-file-topology-red-fixtures.
  - npm run verify:function-map-compile-gate: ok.
  - npm run verify:v3-architecture-docs: ok.
notes: root hub_v1.rs remains only module export owner; node-local ownership is the split file list.
```

### RCR-20260722-03

```yaml
finding_id: RCR-20260722-03
status: fixed
changed_paths:
  - scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs
  - scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs
  - scripts/architecture/verify-v3-architecture-docs.mjs
  - package.json
  - docs/architecture/v3-verification-map.yml
  - docs/architecture/v3-function-map.yml
evidence:
  - New positive gate verifies root aggregator thinness, 17 node files, node struct/builder colocation, shared-helper boundary, maps, required scripts, design doc phrases, and all Hub v1 mainline symbol/file bindings.
  - New red fixtures reject 8 forbidden mutations: map-to-root, duplicate root builder, duplicate node struct outside owner, missing node owner file, shared-helper builder, ambiguous provider compat numbering, missing function-map node truth, and missing verification-map topology gate.
  - package.json wires verify:v3-hub-v1-node-file-topology and test:v3-hub-v1-node-file-topology-red-fixtures.
  - verify-v3-architecture-docs keeps strict per-file symbol binding and requires the new topology gates in H1.
  - npm run verify:v3-hub-v1-node-file-topology: ok.
  - npm run test:v3-hub-v1-node-file-topology-red-fixtures: ok, 8 forbidden mutations rejected.
notes: The topology gate intentionally scans all Hub v1 mainline bindings, not only the fixed skeleton chain, so controlled relay/servertool/protocol-boundary rows cannot drift back to root hub_v1.rs.
```

### RCR-20260722-04

```yaml
finding_id: RCR-20260722-04
status: fixed
changed_paths:
  - .agents/skills/rcc-dev-skills/SKILL.md
  - .agents/skills/rcc-dev-skills/references/24-node-contract-debug-method.md
evidence:
  - Local skill now states the V3 Hub v1 node-file topology hard rule, root aggregator boundary, and required topology gate/red fixtures.
  - Node contract debug method now documents owner lookup order: function map node_owner_files, mainline caller_file/callee_file, then source-open verification.
  - Shared helper and provider compat branch-local numbering constraints are included.
notes: Project-side local skill edits are repair proposals/process guardrails only. They are not canonical rules repo approval, and /Users/fanzhang/github/rules was not modified.
```

### RCR-20260722-05

```yaml
finding_id: RCR-20260722-05
status: fixed
changed_paths:
  - docs/design/pipeline-type-topology-and-module-boundaries.md
  - docs/architecture/v3-function-map.yml
  - scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs
  - scripts/tests/v3-hub-v1-node-file-topology-red-fixtures.mjs
evidence:
  - Design doc section 2.4 now documents root aggregator boundary, full node-to-owner-file table, shared helper owner boundaries, and provider compat branch-local numbering.
  - Function map lists shared_helper_owner_files for common.rs, side_channel.rs, provider_compat_shared.rs, responses_openai_codec.rs, and request_outbound_format.rs.
  - Topology gate rejects node structs/builders in shared helpers and locks provider compat branch numbering.
  - Red fixtures cover shared-helper builder growth and provider compat branch ambiguity.
notes: Provider compat current branch numbering is preserved and explicitly documented as branch-local contract numbering, not global monotonic order.
```

## Verification

Passed:

- `npm run verify:v3-hub-v1-node-file-topology` — ok; 17 contract nodes, 5 shared helpers, 270 Hub V1 mainline bindings checked.
- `npm run test:v3-hub-v1-node-file-topology-red-fixtures` — ok; 8 forbidden mutations rejected.
- `npm run verify:architecture-mainline-call-map` — ok; chains=23, edges=124, shared_functions=35.
- `npm run verify:function-map-compile-gate` — ok through all sub-gates.
- `npm run verify:v3-architecture-docs` — ok; docs=25, resources=72, edges=212.
- `git diff --check` — ok after response/MEMORY/note writes; final run is recorded in `.agent-collab` evidence.

Not passed / needs review:

- `npm run verify:v3-module-boundaries` currently fails on pre-existing/out-of-scope dirty Rust in `v3/crates/routecodex-v3-server/src/lib.rs`:
  - `config authoring file IO outside config crate: v3/crates/routecodex-v3-server/src/lib.rs`
  - `Server cannot select routes or interpret targets`
- This repair did not edit Rust source and did not take over the active module-boundary/server/model-catalog claims.

Conditionally not applicable for this repair:

- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check` — not run because this repair did not touch Rust source.
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime hub_v1 -- --nocapture` — not run because this repair did not touch Rust source.

## Scope / Repository Safety

```yaml
rules_repo_modified: false
rules_repo_status_checked: clean
local_dirty_worktree_preserved: true
no_reset_checkout_overwrite: true
no_broad_kill: true
no_global_install_restart_live_runtime_mutation: true
runtime_semantics_changed_by_this_repair: false
rust_source_changed_by_this_repair: false
```

## Remaining Risks

- Required gate `verify:v3-module-boundaries` is not green because of unrelated dirty `v3/crates/routecodex-v3-server/src/lib.rs`; independent owner review is needed before claiming full verification closure.
- Local skill edits are project-side proposals/guardrails only; canonical rules repo promotion remains a separate independent rules-review action.
- Existing broad dirty worktree remains outside this repair and was not normalized, reset, or overwritten.

## Next Action

Have the owner of the active V3 server/module-boundary dirty work resolve or hand off `v3/crates/routecodex-v3-server/src/lib.rs`, then rerun `npm run verify:v3-module-boundaries` plus `git diff --check` before promoting this repair as fully green.
