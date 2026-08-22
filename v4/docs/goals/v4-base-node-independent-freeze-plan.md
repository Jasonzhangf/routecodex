# V4 BaseNode Independent Freeze Plan

## Objective

Make `BaseNode` a real independently compiled, regression-qualified, publishable, and frozen V4 foundation dependency. `Edge` and later node modules must remain independently mutable and must consume the frozen BaseNode library through an explicit Rust dependency.

This phase closes the gap between the current source/test baseline and an actual AppSDK-governed library lifecycle. It does not add request, response, error-policy, provider, or business operators.

## Confirmed Baseline

- AppSDK regression governance is committed in `c97c188` and `940d8ad`.
- AppSDK source worktree is clean; `dist/` is ignored and generated binaries are not tracked.
- RouteCodex V4 foundation source is committed in `b7f84ecc9`.
- `BaseNode` L0 regression has 12 passing tests with whitebox and blackbox coverage.
- The complete nodegraph crate has 23 passing tests.
- V3 remains the read-only behavior baseline.

## Blocking Gap

The current AppSDK compiler builds one project-level governance artifact:

```text
project modules
  -> generated/project.compiled.json
  -> one project artifact_hash
  -> Active artifact.json
```

This does not provide a module-level compiled library. `BaseNode` and `Edge` also share one Rust crate, so changing Edge changes the same compiled Rust artifact. Freezing the current `routecodex-v4-nodegraph` module would therefore either freeze Edge prematurely or make the BaseNode freeze invalid when Edge evolves.

The required target is:

```text
BaseNode source + contract + API + dependencies
  -> BaseNode Rust library artifact
  -> module artifact hash
  -> Active/BaseNode/<version>
  -> Protected/BaseNode/<version>

Edge source + contract
  -> depends on Active BaseNode version
  -> remains mutable until its own freeze
```

## Scope

### Included

1. AppSDK module-level build, artifact, publish, and freeze contract.
2. Rust compilation boundary between BaseNode and Edge.
3. Non-overlapping V4 module ownership and dependency declarations.
4. Executable V4 resource/function/mainline/verification gates.
5. BaseNode lifecycle records, whitebox plus blackbox regression report, Active publication, and Protected archive.
6. Negative verification that frozen BaseNode cannot change without a new Playground/promotion cycle.
7. Positive verification that Edge can continue development against the frozen BaseNode version.

### Excluded

- Any modification under `v3/`, root `src/`, or `sharedmodule/`.
- Request/response standard node implementation.
- Chat Process group implementation.
- MetadataCenter implementation beyond contracts needed by BaseNode.
- Provider configuration, provider actions, routing policy, retry, switching, or error decision logic.
- Runtime installation, server restart, and live RouteCodex traffic.
- Committing generated build output.

## Architecture Decision

Use Rust crates as the compiled ownership boundary:

```text
routecodex-v4-base-node
  owns BaseNode source, public API, L0 tests, and BaseNode contract

routecodex-v4-edge
  depends on routecodex-v4-base-node
  owns Edge source, public API, L1 tests, and Edge contract

routecodex-v4-nodegraph
  optional thin facade only
  re-exports frozen lower-level libraries without owning their semantics
```

Keeping BaseNode and Edge as source modules in one compiled crate is rejected for this lifecycle because it cannot produce independent immutable artifacts. The facade must stay semantic-free; duplicated types, adapters, and fallback implementations are forbidden.

## Required AppSDK Contract

Extend each module contract with deterministic build and artifact inputs:

```text
module_id
owned_paths
contract_paths
dependency_modules
public_api_command
build_command
artifact_paths
active_artifact
generated_outputs
regression
```

AppSDK must:

1. Validate paths and commands before execution.
2. Build only through the declared module adapter.
3. Hash the exact module source, contracts, public API, dependencies, and produced artifacts.
4. Produce a module-scoped compiled manifest and module artifact hash.
5. Bind EvidenceRecord, ReviewRecord, PromotionRecord, RegressionReport, and FreezeRecord to that module hash.
6. Publish the declared library files and manifest under the module Active version.
7. Archive the matching source/contracts/record graph under the module Protected version.
8. Reject missing, extra, stale, symlinked, or hash-mismatched artifacts.
9. Keep generated output ignored by Git.

Project-level governance compilation may remain for project orchestration, but it must not be used as proof that one module is independently frozen.

## Implementation Sequence

### Phase 0: Contract and Ownership Lock

1. Split the existing BaseNode, Edge, and crate-shell ownership in `.appsdk/project.json`.
2. Split mixed contracts so BaseNode and Edge each have a unique contract owner.
3. Register explicit dependency edges:

```text
routecodex-v4-edge -> routecodex-v4-base-node
routecodex-v4-nodegraph -> routecodex-v4-base-node
routecodex-v4-nodegraph -> routecodex-v4-edge
```

4. Mark unimplemented resources and symbols as `design` or `pending`; do not report them as active truth.
5. Replace nonexistent AppSDK CLI flags in the verification map with real executable gates or mark them pending.

Exit gate: every V4 source file in scope has exactly one owner, every cross-module import is registered, and no generated path is an owned source path.

### Phase 1: AppSDK Module Artifact Support

1. Add module build/artifact fields to the AppSDK schema and template.
2. Add deterministic module input hashing and module artifact validation.
3. Make promotion, regression, freeze, Active publication, and frozen integrity consume module artifact hashes.
4. Copy only declared compiled library artifacts into Active; archive only declared source/contracts into Protected.
5. Add positive and negative AppSDK CLI tests:
   - independent modules produce different hashes;
   - changing Edge does not invalidate frozen BaseNode;
   - changing BaseNode source, contract, API, dependency, or artifact invalidates its report;
   - missing or modified compiled output fails;
   - project-global manifest cannot substitute for a module artifact.

Exit gate: AppSDK can freeze module A while module B remains mutable, and can prove this using distinct artifact hashes.

### Phase 2: V4 Rust Boundary

1. Move BaseNode into `routecodex-v4-base-node`.
2. Move Edge into `routecodex-v4-edge` and depend on BaseNode through Cargo.
3. Reduce `routecodex-v4-nodegraph` to an optional semantic-free facade or remove it after dependency checks.
4. Preserve public behavior and existing L0/L1 tests.
5. Add compile-fail or architecture tests for forbidden reverse/cross-layer dependencies.

Exit gate: BaseNode builds and tests alone; Edge builds only through the declared BaseNode dependency; no duplicate BaseNode implementation exists.

### Phase 3: Machine Gates

Make the registries verify code rather than only describing intent:

1. Resource registry: unique owner, allowed operations, direct/indirect/forbidden resource edges.
2. Module registry: complete non-overlapping source ownership.
3. Function map: real entry symbols and required gates.
4. Mainline call map: real adjacent BaseNode/Edge calls and Cargo dependency edges.
5. Verification map: commands that exist and run in CI/build entrypoints.
6. Red gates:
   - control/debug/snapshot/error/routing resources cannot enter normal payload;
   - Edge cannot bypass BaseNode contracts;
   - no unregistered cross-module import;
   - no duplicate DTO/operator owner;
   - no generated artifact can be committed.

Exit gate: all entries claimed as `active` resolve to real source symbols and executable gates.

### Phase 4: BaseNode Promotion and Freeze

1. Record the exact goal, scope, source commit, contracts, API, dependencies, and regression inputs.
2. Produce the BaseNode Rust library artifact.
3. Run L0 unit/focused tests.
4. Run freeze regression with both:
   - whitebox evidence for internal invariants;
   - blackbox evidence through the public BaseNode API.
5. Generate EvidenceRecord, ReviewRecord, PromotionRecord, RegressionReport, and FreezeRecord.
6. Publish the immutable Active BaseNode version.
7. Archive source, contracts, records, hashes, and regression report into Protected.
8. Verify the complete record graph and artifact hashes.

Exit gate: BaseNode is independently `frozen`; Edge is not.

### Phase 5: Freeze Behavior Verification

Positive checks:

- Edge source and L1 tests can evolve against the frozen BaseNode dependency.
- Unchanged BaseNode ordinary full regression may be disabled.
- BaseNode Active library remains consumable and hash-stable.

Negative checks:

- Direct BaseNode source or Active mutation fails.
- BaseNode source, contract, API, artifact, or dependency changes invalidate the old regression report.
- A changed BaseNode requires a new Playground, review PASS, promotion, library version, Active artifact, and Protected snapshot.
- Debug, snapshot, control, and error records cannot appear in normal payload.

Exit gate: disabled regression is permitted only when all bound inputs remain unchanged.

## Test Policy

- Unit tests and focused tests may be whitebox-only.
- Freeze regression must include whitebox and blackbox evidence.
- Bug reproduction must include whitebox and blackbox evidence.
- State-machine, error, lifecycle, and resource-boundary tests require paired positive and negative cases.
- A passing source test without artifact/hash/record verification is not freeze evidence.

## Commit Boundaries

1. AppSDK: module-level artifact and independent freeze support.
2. RouteCodex V4: BaseNode/Edge crate and ownership split.
3. RouteCodex V4: executable maps and architecture gates.
4. RouteCodex V4: BaseNode lifecycle records, Active publication metadata, and Protected freeze metadata.

Each commit must exclude generated outputs and unrelated dirty files.

## Definition of Done

- AppSDK can independently compile, hash, publish, freeze, and verify one module.
- `routecodex-v4-base-node` is a separately compiled immutable Active library.
- Protected contains the matching BaseNode source, contracts, records, and hashes.
- BaseNode L0 regression report contains both whitebox and blackbox evidence.
- Edge remains mutable and consumes the frozen BaseNode version through a declared dependency.
- All active map entries bind to real paths, symbols, edges, and executable gates.
- Generated artifacts remain Git-ignored and untracked.
- V3 has no diff from this work.

## Next Phase After Completion

Freeze Edge with the same lifecycle, then reassess the remaining foundation components before deriving standard request and response node classes. No standard pipeline node should be implemented on an unfrozen BaseNode/Edge foundation.
