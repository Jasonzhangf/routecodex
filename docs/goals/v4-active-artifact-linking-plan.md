# V4 Active-Only Artifact Linking Plan

## Objective

Replace V4 consumers' mutable Cargo workspace source-path consumption of frozen modules with a single Active-only artifact linking contract. Consumers must select an immutable Active artifact by module ID, version, platform, target triple, public API hash, and artifact hash; they must never discover, compile, or link `playground/`, `protected/source/`, `generated/`, or a frozen module's mutable crate source.

## Acceptance criteria

- Every frozen V4 module has one immutable Active artifact identity and one owning resolver.
- A consumer build resolves only an Active manifest/record and the matching verified artifact; no Cargo path dependency reaches frozen module source.
- Artifact hash, public API hash, source commit, module version, target triple, and dependency artifact hashes are checked before link/consume.
- Missing, stale, mismatched, cross-target, symlinked, or non-Active artifacts fail fast with a typed error; there is no source fallback, rebuild fallback, or alternate resolver.
- Mutable modules may retain source dependencies only until individually admitted/frozen; the policy distinguishes this explicit transitional state from frozen-module consumption.
- Existing BaseNode and Error frozen artifacts remain byte-identical unless a deliberate new freeze is approved; Protected history remains read-only and auditable.
- V4 workspace tests, artifact-resolution black-box tests, architecture gates, AppSDK lifecycle gates, and MCP review pass.

## Scope

In scope:

- V4 Cargo workspace manifests/build entrypoints and frozen-module consumer edges.
- Active artifact manifest/index schema, typed resolver, linker/build integration, record bindings, architecture maps, verification gates, test design, and generated deterministic metadata.
- BaseNode, Error, and subsequent frozen-module consumer migration in dependency order.

Out of scope:

- RouteCodex V3 runtime behavior, HTTP/provider/pipeline/payload semantics, AppSDK global Bundle migration, new module business behavior, mutation of Protected archives, or changing Active public APIs.

## Non-negotiable invariants

- Active is the sole consumable surface for frozen modules. Protected is audit/archive only; Playground is experiment only; Generated is compiler output only.
- All artifact selection/control facts travel through typed build/control resources, never business payload.
- One resolver owns selection and validation. Cargo manifests, build scripts, runtime code, and tests must not each implement equivalent discovery logic.
- Freeze remains the only producer of a publishable Active artifact. Consumers never compile frozen source as a recovery path.
- No fallback, compatibility shim, dual link path, silent source fallback, or implicit target selection.
- Existing pipeline topology and module ownership remain unchanged except for registered V4 build/consumer edges.

## Required discovery before implementation

1. Refresh `.agent-collab` run/claim state and claim the V4 artifact-linking feature/resource.
2. Read V4 resource map, function map, mainline call map, verification map, module registry, `v4/.appsdk/project.json`, module contracts/artifacts/freeze records, and existing Active/Protected layout.
3. Build an evidence table for every V4 module: stage, source owner, current Cargo consumer edges, Active version/hash, public API hash, target, dependency modules, Protected archive, required regression command, and whether the module is frozen or mutable.
4. Locate the single existing AppSDK producer/verification owner for Active artifacts and the single V4 build owner. If maps cannot name them, repair maps before code.

## Design to produce before code

Write and approve an artifact-linking design that fixes:

1. Typed contracts: `ActiveArtifactIdentity`, `ActiveArtifactManifest`, `ActiveArtifactDependency`, `ActiveArtifactResolution`, and typed failure chain.
2. Storage layout: deterministic Active artifact location and immutable manifest location; no source directories under the consumer path.
3. Resolver API: input identity and expected target/API constraints; output verified linkable artifact only.
4. Producer contract: freeze/publish emits the manifest and dependency closure once; consumer has no write permission to Active.
5. Cargo integration: use one generated Cargo-compatible link surface or a Rust build helper owned by the resolver; do not scatter path rewriting across manifests/build scripts.
6. Dependency graph: migrate BaseNode consumers first, then Error and dependent modules in topological order; mutable modules stay explicitly source-owned until their own freeze admission.
7. Failure behavior: missing artifact, hash mismatch, target mismatch, ABI/API mismatch, source-path edge, symlink, stale record, or dependency closure mismatch must fail before compile/link.
8. Rollout: feature-gated isolated experiment first; no replacement in the main V4 build until the design ID is approved.

## Test design and verification matrix

Red tests must precede the formal implementation.

| Gate | Positive evidence | Negative evidence |
|---|---|---|
| Active resolver | Exact identity resolves matching immutable artifact | Missing/stale/hash/API/target mismatch rejects |
| Source isolation | Frozen consumer builds from Active-only surface | Cargo path to frozen source, Protected source, Playground, Generated rejects |
| Dependency closure | Transitive Active hashes match manifest | Any dependency hash/version swap rejects |
| Immutability | Consumer cannot alter Active/manifest | write/symlink/path-traversal attempt rejects |
| Lifecycle | Freeze publishes deterministic identity and records | non-frozen/missing review/evidence/freeze record cannot publish |
| Compatibility | Existing public API consumer black-box suite passes | old source fallback route is absent and red-tested |
| Project | V4 fmt/test/release build and AppSDK verify pass | architecture gate detects unregistered/duplicate resolver edge |

Where runtime code is touched, complete global installation, aggregate restart, all listener health checks, and an old live sample before review. If this stays build-governance-only, state why no runtime restart applies and verify the actual build consumer path instead.

## Ordered work plan

1. Baseline and maps: create evidence table, dependency graph, test design, and design ID.
2. Isolated Playground experiment: prove a single BaseNode consumer can resolve and link an immutable Active artifact without source discovery; capture positive and reverse evidence.
3. Review the experiment/design; Jason explicitly approves the design ID before formal code.
4. Implement the unique resolver and contracts in the registered owner only; add architecture gate for forbidden source edges.
5. Migrate the first BaseNode consumer, run red-to-green unit/module/project black-box tests, and prove old source path cannot build.
6. Publish/freeze only through existing lifecycle records; verify Active/Protected/record graph identity.
7. Migrate remaining frozen-module consumers one dependency layer at a time, with a separate evidence set and review checkpoint for each layer.
8. Run final V4 build/verification matrix, update maps/wiki/skills/MEMORY, perform MCP review oauth → cc → tcm, and commit only the verified layer.

## Risks and stop conditions

- A Rust `rlib` may not be a stable cross-workspace/distribution interface. If evidence shows direct `rlib` linking is not a valid contract, stop before implementation and redesign the Active artifact format; do not fake Cargo compatibility.
- If a module's public API or dependency closure is insufficiently recorded, stop and complete its module contract/records first.
- If a consumer cannot avoid source-path compilation without changing business semantics, treat that as a design decision for Jason, not a reason to add fallback.
- A discovery of V3/runtime/payload impact expands scope and invalidates this plan until a new approved design is recorded.

## Definition of done

At least one frozen-module consumer (BaseNode first) builds exclusively through the verified Active artifact contract, old frozen-source Cargo consumption is mechanically rejected, all named gates pass, hashes/records/Protected history align, no forbidden root enters build/runtime consumption, and the change receives explicit MCP `VERDICT: PASS`. Subsequent module layers remain separately tracked until they meet the same contract.
