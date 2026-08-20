# V3 Independent Build Isolation Plan

Status: proposed execution design; implementation pending  
Design ID: `V3-INDEPENDENT-BUILD-ISOLATION-20260816`  
Owner feature: `v3.build.independent_domain`  
Scope root: `v3/`

## 1. Objective and Acceptance Contract

Make RouteCodex V3 a self-contained build domain. All source code participating in
V3 compilation, dependency locks, toolchain declarations, build/test/architecture
gate entrypoints, build-admission manifests, test scratch space, generated files,
assembled binaries, and package staging must be owned under `v3/`.

The completed build domain must satisfy all of the following:

1. `cd v3` is sufficient to install declared V3 build dependencies and run the
   complete V3 build, test, architecture, distribution, and packaging stack.
2. `cargo metadata --manifest-path v3/Cargo.toml` reports `v3/` as
   `workspace_root`, `v3/target` as `target_directory`, and zero path dependencies
   escaping `v3/`.
3. `provider-compat-core`, `servertool-core`, and `stop-message-core` have one V3-owned
   source implementation under `v3/crates/`; the old sharedmodule source owners are
   retired after all consumers and map edges are migrated.
4. V3 build/test/gate/install/pack commands do not depend on root `package.json`, root
   `node_modules`, root build scripts, root `dist`, root `artifacts`, V4, or
   sharedmodule source/build outputs.
5. All mutable compilation, test, assembly, and packaging outputs remain under
   `v3/target`, `v3/build-control`, `v3/generated`, `v3/dist`, or `v3/artifacts`.
6. Root npm, CI, and release workflows contain only thin dispatchers into V3-owned
   canonical commands. They do not duplicate the V3 crate/gate/test matrix.
7. V3 runtime behavior, protocol shapes, request/response/error chains, control-plane
   isolation, Direct/Relay semantics, continuation immutable interval, and provider
   behavior remain byte/semantically equivalent to the approved pre-migration base.
8. The globally installed `~/.local/bin/rccv3` is built from the isolated V3 domain,
   has matching version/hash evidence, survives one aggregate `routecodex restart`,
   and passes all configured listener health plus real old-sample replay before final
   review.

External Cargo/npm download caches and system executables are tool dependencies, not
build outputs. They may be read. The explicit final installation of an already-built
V3 binary into `~/.local/bin` is a publication action and is allowed only after the
isolated V3 source/build gates pass; it must not cause compilation outside `v3/`.

## 2. Current-State Evidence

The implementation must re-audit these facts from the approved base before editing:

- V3 Cargo already resolves `workspace_root=v3` and `target_directory=v3/target`.
- `v3/Cargo.lock` is tracked and the workspace currently contains twelve V3 crates.
- Five Cargo path-dependency edges escape V3:
  - `routecodex-v3-provider-responses -> provider-compat-core`;
  - `routecodex-v3-runtime -> provider-compat-core`;
  - `routecodex-v3-runtime -> servertool-core`;
  - `routecodex-v3-runtime -> stop-message-core`;
  - `routecodex-v3-cli -> servertool-core`.
- The three external crates are under
  `sharedmodule/llmswitch-core/rust-core/crates/`; Cargo manifest search shows no
  non-V3 compiled consumers beyond their containing shared workspace.
- Root `package.json` owns roughly 150 V3-named commands.
- At least 53 V3 architecture verifiers and 50 V3 red-fixture scripts are under root
  `scripts/`, with additional V3 renderers, helpers, install, pack, copy, and Cargo
  test wrappers also rooted outside V3.
- V3 has no local Node package/lock or local `scripts/` owner surface.
- `scripts/run-v3-cargo-test.mjs` is rooted at the repository and owns the V3 Cargo
  test artifact budget/cleanup contract.
- `scripts/install-v3-cli.mjs` reads root package/version/build-info, writes an
  install Cargo target in the OS temporary directory, assembles root
  `dist/bin/rccv3`, and then publishes the global binary.
- `scripts/pack-v3-release.mjs` reads root package version, writes root
  `dist/bin/rccv3` and root `artifacts/pack`, and stages packages in the OS temporary
  directory.
- Root `scripts/gen-build-info.mjs` may update root package/lock and root
  `src/build-info.ts`; it must not remain a V3 build dependency.
- `test:v3-provider-compat-profile-loading` directly builds the sharedmodule Cargo
  workspace instead of the V3 workspace.
- `docs/architecture/v3-build-tool-module-registry.yml` currently assigns V3 build
  owners to root scripts and root test paths.
- V3 function/mainline/resource/verification maps formally record sharedmodule
  provider/servertool owners and root-cwd commands.
- Root GitHub test and release workflows own the V3 internal gate/build/install/pack
  sequence and read the root package version/artifact paths.

These are audit facts, not permission to skip Phase 0 owner and edge verification.

## 3. Scope and Boundaries

### 3.1 In Scope

- V3-local Node package/lock, Rust toolchain/config, Cargo lock, and canonical commands.
- Relocation of all V3-only build, test, verifier, renderer, distribution, install,
  and pack scripts into V3 ownership.
- Relocation of `provider-compat-core`, `servertool-core`, and `stop-message-core` into
  the V3 Cargo workspace without duplicating semantics.
- Replacement of dynamic root architecture inputs with deterministic V3-owned
  build-admission contracts/manifests.
- V3-local version truth, build metadata, test targets, install targets, assembled
  binary, package staging, and release artifacts.
- Root npm/CI/release thinning to V3-local dispatchers.
- Resource/function/mainline/module/verification map lockstep for all changed build
  and crate ownership.
- Positive and negative build isolation tests, global installation, one aggregate
  restart, all-listener health, real old-sample replay, DSH Review, and intentional
  commits.

### 3.2 Explicitly Out of Scope

- V4 source, V4 build system, V4 baselines, V4 AppSDK, or V4 CI semantics.
- New runtime features or behavior changes in protocol codecs, Hub Pipeline,
  Virtual Router, provider runtime, Server, SSE, continuation, Stopless/servertool,
  provider health, or Error policy.
- Rewriting the three migrated Rust crates while moving them. Source relocation must
  preserve behavior; any independent refactor requires a separate owner/design.
- Provider configuration or user configuration migration.
- Changing the global install destination away from `~/.local/bin/rccv3`.
- `routecodex server stop`, `routecodex server start`, foreground/manual starts,
  per-port restart loops, or any restart workaround.
- Retaining root/shared fallback build paths after V3-local migration.
- Moving repo-wide or genuinely cross-version integration gates into V3 merely
  because their filenames mention V3; classify ownership first.

### 3.3 Authorized Non-V3 Changes

The following non-V3 changes are part of achieving the target and are authorized only
within the exact stated boundary:

- Root `package.json`/lock: convert V3 aliases into thin V3 dispatchers and remove
  dependencies proven V3-only after V3 owns them.
- Root `.github/workflows/test.yml` and `.github/workflows/release.yml`: replace V3
  internal command matrices/version/artifact paths with V3 canonical dispatchers and
  V3-owned version/artifact outputs.
- Root V3 architecture authoring docs/maps: update ownership/path/edge/gate references
  and add lockstep with V3-local deterministic admission manifests.
- Root routing docs/skills/AGENTS references: update V3 build-tool paths only where
  needed to keep canonical navigation truthful; runtime architecture rules remain
  unchanged.
- Root V3-only scripts/tests: physically delete after V3-local replacements and all
  references are proven migrated.
- `sharedmodule/llmswitch-core/rust-core/Cargo.toml` and the exact three old crate
  directories: remove their workspace membership/source only after V3-local crates
  pass equivalence, all Cargo/map references point to V3, and no other consumer exists.

No V4 or unrelated root/shared cleanup is authorized.

## 4. Architecture and Ownership

### 4.1 Canonical V3 Build Surface

Create or converge on this ownership surface:

```text
v3/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── .cargo/
│   └── config.toml
├── package.json
├── package-lock.json
├── crates/
│   ├── routecodex-v3-*
│   ├── provider-compat-core/
│   ├── servertool-core/
│   └── stop-message-core/
├── scripts/
│   ├── build.mjs
│   ├── run-cargo-test.mjs
│   ├── cargo-test-artifact-runner.mjs
│   ├── install-cli.mjs
│   ├── pack-release.mjs
│   ├── verify-isolation.mjs
│   ├── architecture/
│   └── tests/
├── build-contracts/
│   ├── architecture-admission/
│   └── manifests/
├── tests/
│   ├── resources/
│   └── scripts/
├── target/
├── build-control/
├── generated/
├── dist/
└── artifacts/
```

The preferred public command contract is:

```text
npm run build
npm run test
npm run verify
npm run verify:red
npm run verify:ci
npm run install
npm run pack:dev
npm run pack:npm
```

`verify:ci` owns the complete V3 source admission stack. Root npm and CI call these
commands through `npm --prefix v3`; they do not enumerate V3 crates or gates.

### 4.2 Path and Environment Resolution

- Node scripts resolve `v3Root` from `import.meta.url`, not `process.cwd()`.
- Local commands use `Cargo.toml`, `.`, `scripts/...`, `target/...`, and
  `build-control/...`; root-prefixed `v3/...` is forbidden inside V3-owned scripts,
  manifests, and package commands.
- The same canonical command must work from V3 root, repository root dispatcher, and
  an unrelated cwd using the absolute V3 package path.
- User-supplied `CARGO_TARGET_DIR`, `TMPDIR`, package output, or staging overrides
  resolving outside V3 must fail explicitly. They must not silently bypass isolation.
- External tool caches may be read, but no external path may become build truth.

### 4.3 Rust Source Ownership Migration

Relocate the exact three Rust crate trees into `v3/crates/`, preserving tracked bytes,
crate names, public APIs, tests, and behavior before making the minimum manifest/map
path changes.

Required dependency topology after migration:

```text
routecodex-v3-provider-responses -> provider-compat-core (V3 workspace)
routecodex-v3-runtime            -> provider-compat-core (V3 workspace)
routecodex-v3-runtime            -> servertool-core (V3 workspace)
routecodex-v3-runtime            -> stop-message-core (V3 workspace)
routecodex-v3-cli                -> servertool-core (V3 workspace)
servertool-core                  -> stop-message-core (V3 workspace)
```

Rules:

1. Add the three crates as explicit V3 workspace members.
2. Path dependencies must be V3-local and preferably use workspace dependency
   declarations where that preserves a single version/source decision.
3. Do not rename crate APIs, change protocol semantics, alter control resources, or
   mix migration with refactoring.
4. Compare pre/post Cargo metadata, dependency graph, unit tests, integration tests,
   compiled binary behavior, and relevant public artifact hashes.
5. Update unique owners and adjacent call/resource edges in V3 maps before reporting
   the migration active.
6. After zero-reference and equivalence proof, remove the old shared workspace members
   and old source trees. Keeping both implementations “for safety” is forbidden.
7. Any true non-V3 consumer discovered in Phase 0 invalidates this relocation design;
   report it and revise the owner boundary before editing that crate.

### 4.4 Architecture Authoring vs Build-Admission Inputs

Root V3 architecture documents may remain the human authoring/review surface, but
ordinary V3 compilation and `verify:ci` must not dynamically depend on paths outside
V3. Use deterministic V3-owned build-admission contracts:

```text
root V3 canonical authoring maps
  -- explicit canonical compile/sync -->
v3/build-contracts/architecture-admission/<versioned manifests>
  -- ordinary local verify -->
V3 source/build admission
```

The compile/sync operation is an explicit repository-maintenance action, not part of
ordinary `build`, `test`, `verify`, install, or pack. It must:

- validate source schemas, owners, allowed/forbidden paths, adjacent edges, and gates;
- produce deterministic sorted output;
- record source paths, source commit/digests, schema version, and generated digest;
- contain no secrets, runtime state, provider config, debug samples, or payload data;
- fail on unknown fields and unresolved paths/symbols;
- be generated only by the declared canonical generator;
- have a root integration gate proving authoring maps and the tracked V3-local
  admission manifests are in lockstep.

Standalone V3 verification consumes only the tracked V3-local manifests and verifies
them against V3 source. It must not fall back to root maps when a local manifest is
missing or stale. Human docs are not a substitute for executable admission manifests.

If analysis proves moving the canonical V3 machine maps themselves under V3 is
smaller and keeps one truth source, that alternative is allowed only after updating
all project routing/docs/generators and proving there is no duplicate root map. Do
not keep two hand-edited canonical copies.

### 4.5 Node Tooling and Gate Ownership

Classify every root script before migration:

- V3-only build/test/verifier/renderer/helper: move to V3 ownership.
- Repo-wide authoring-to-admission compiler or cross-version integration gate: remain
  root-owned and must not be required for standalone V3 build.
- V4-owned V3 comparison gate, such as V4 resource coverage: remain V4-owned and must
  not move into V3.
- Obsolete duplicate/fallback: delete after reference and red-gate proof.

Preserve existing V3 gate IDs and behavior unless the map contract explicitly
requires a rename. Every positive assertion and red fixture must survive. No gate may
silently skip for a missing root path; local required resources must be nonempty and
missing inputs must fail fast.

### 4.6 Version, Install, and Package Ownership

V3 owns its release/build version under `v3/`, preferably through the local package
manifest or a dedicated V3 release manifest. The chosen source must be singular and
must drive:

- `ROUTECODEX_BUILD_VERSION` at Cargo compile time;
- `rccv3 --version`;
- `/health` build version;
- dev/npm package names;
- release workflow tag/artifact lookup.

Root `package.json`, root `src/build-info.ts`, and root version auto-bump are forbidden
V3 compile inputs or side effects.

Required output ownership:

```text
Cargo ordinary/test target     -> v3/target/
install build target           -> v3/build-control/install-target/<run-id>/
pack staging                   -> v3/build-control/pack/<run-id>/
assembled repository binary    -> v3/dist/bin/rccv3
release packages               -> v3/artifacts/pack/
explicit global publication    -> ~/.local/bin/rccv3
```

Installer requirements:

- preserve the existing atomic binary replacement, hash verification, interruption
  handling, owned-process handling, success/failure cleanup, and direct global binary
  invariant;
- never overwrite a running Mach-O binary with a raw `cp` operation;
- compile only inside V3 and publish only after the source gate passes;
- never create `~/.rcc/install/**` or use repo/npm/release-snapshot fallback;
- `routecodex` and `rcc` aliases must resolve to the same installed binary.

### 4.7 Build Output and Artifact-Budget Policy

Preserve the existing V3 Cargo test artifact-budget contract:

- canonical Cargo tests go through the V3-local `run-cargo-test` owner;
- test-owned executables, dep-info, symbol bundles, and filename-owned `*.rcgu.o` are
  released on success and failure;
- reusable `.rlib`, `.rmeta`, proc-macro, fingerprint, and build-script artifacts are
  retained within V3;
- the 2 GiB idle budget is measured and cleanup occurs only when no other V3 builder
  is active;
- active external V3 builders make cleanup fail explicitly instead of racing;
- ownership must never be inferred from mtime.

Move any required Cargo configuration from root ownership into `v3/.cargo/`. Prove
that V3 does not rely on an ancestor `.cargo/config.toml` by running the standalone
isolation test.

## 5. Machine Maps, Resources, and Review Surface

Before source migration, bind the build domain and crate ownership changes into the
V3 architecture system. Do not invent symbols or treat design entries as active.

Required outcomes:

1. `v3-resource-operation-map`
   - register local dependency locks, build-admission manifests, Cargo target/cache,
     install target, pack staging, assembled binary, package artifacts, and explicit
     global publication as separate resources;
   - declare owner, identities, allowed operations, release/cleanup points, forbidden
     paths, and required gates;
   - keep installation/build identity out of request/response/provider wire,
     MetadataCenter, debug, and Error payloads.
2. `v3-function-map`
   - add `v3.build.independent_domain` with unique build-tool owners, real entry
     symbols/commands, allowed/forbidden paths, and verification gates;
   - migrate provider-compat/servertool/stop-message owners to V3-local crates while
     preserving their runtime node responsibilities.
3. `v3-mainline-call-map`
   - express adjacent build flow: root dispatcher -> V3 canonical entrypoint -> local
     build/gate owners -> V3-local artifacts;
   - express the existing runtime calls to the three relocated crates at the same
     adjacent request/response/Chat Process boundaries;
   - prohibit root CI shortcuts to individual V3 gates/crates and prohibit
     sharedmodule call edges.
4. `v3-build-tool-module-registry`
   - move owned paths for global install and artifact-budget modules into V3;
   - add owners for versioning, packaging, architecture admission, and isolation;
   - ensure every V3 build script has exactly one module owner.
5. `v3-verification-map`
   - make commands executable from V3 root;
   - register positive and red isolation gates, standalone tests, package tests,
     install/live closeout, and DSH Review prerequisites.
6. Generated V3 review surfaces and manifests
   - preserve separate Request, Response, and Error graphs;
   - update only file/owner/build edges caused by relocation;
   - do not synthesize a new runtime mainline for build tooling;
   - regenerate only through existing declared renderers/generators.

The P0 runtime invariants remain unchanged:

- request chain:
  `Inbound01 -> Inbound02 -> Continuation03 -> ChatProcess04 -> Execution05 -> Target06 -> Outbound07 -> ProviderCompat06 -> Wire08 -> Transport09`;
- response chain:
  `ProviderRaw01 -> ProviderCompat02 -> Inbound02 -> ChatProcess03 -> Continuation04 -> Outbound05 -> ServerFrame06`;
- error chain:
  `Error01 -> Error02 -> Error03 -> Error04 -> Error05 -> Error06`;
- routing/continuation/retry/health/debug/snapshot/error/scope/Stopless/servertool
  control state remains in typed side-channel/MetadataCenter/Error resources and
  never enters normal payload;
- Direct/Relay and continuation immutable-interval behavior cannot change as a side
  effect of source relocation.

## 6. Implementation Sequence

### Phase 0: Controlled Worktree, Memory, and Boundary Re-audit

1. Refresh `.agent-collab` runs, claims, recent events/evidence, handoff, merge queue,
   and kill switch.
2. Create a run ID and atomically claim `feature_id:v3.build.independent_domain` plus
   any crate-owner/resource/gate IDs needed for the current slice.
3. Work from an explicit clean base in a dedicated `codex/` worktree/branch. Preserve
   every unrelated main-worktree and worker change.
4. Search MemoryPalace if healthy; open returned source. If it returns the known
   internal index error, record the outage once and use `MEMORY.md`, latest `note.md`,
   source maps, and source files without claiming search success.
5. Read the V3 resource/function/mainline/module/verification maps, generated review
   surface, relevant manifests, Cargo metadata, all three shared crate manifests, and
   every build/install/pack owner before designing patches.
6. Produce a pre-change module boundary table containing unique owner,
   owned/allowed/forbidden paths, adjacent caller/callee, resource reads/writes, and
   required gates for every planned edit.
7. Prove the three shared crates have no live non-V3 compiled consumer. If this is
   false, stop that relocation and report a revised owner design.

Exit: exact scope/base/claims/owners/edges/gates and deletion targets are evidenced.

### Phase 1: V3-Local Toolchain and Canonical Commands

1. Add V3-local Node package/lock and Rust toolchain/config ownership.
2. Establish the singular V3 version source without changing the released version
   accidentally.
3. Move the Cargo test wrapper/artifact runner to V3 and preserve all artifact-budget
   behavior and tests.
4. Implement one canonical build/test/verify orchestration surface.
5. Add initial isolation checks for workspace/target, escaping dependencies,
   environment overrides, root dependency reads, and write destinations.
6. Prove the local commands work with root `node_modules`, root package scripts, and
   ancestor Cargo config unavailable in an isolated environment.

Exit: V3-local source build/test entrypoints run without root tooling.

### Phase 2: Three-Crate Source Ownership Migration

1. Capture pre-migration Cargo metadata, dependency tree, focused tests, public API
   surface, and representative compiled behavior.
2. Relocate `provider-compat-core`, `servertool-core`, and `stop-message-core` into
   `v3/crates/`, preserving content before minimal path edits.
3. Add them to the V3 workspace and update the six local dependency edges, including
   servertool-to-stop-message.
4. Update owner/maps/manifests/gates and run focused positive/negative crate,
   provider-compat, Chat Process/servertool, continuation, and compile-fail tests.
5. Search all tracked Cargo/source/map/script references. After zero external
   consumers and equivalence are proven, remove the three old shared workspace
   members/source trees.
6. Add red gates rejecting revival of sharedmodule path dependencies, duplicate crate
   owners, duplicate package names from external workspaces, and cross-directory
   source imports.

Exit: Cargo metadata contains one V3-local owner for each crate and no escaping path
dependency.

### Phase 3: Gate, Script, and Admission-Manifest Migration

1. Classify each root V3-named script by V3-only, repo-wide, V4-owned, or obsolete.
2. Move V3-only verifiers, red fixtures, renderers, helpers, and test resources into
   V3. Read and patch every semantic file individually; no transformation script or
   bulk semantic replacement is permitted.
3. Preserve gate IDs, assertions, fixture counts, missing/empty fail-fast behavior,
   and generated review semantics.
4. Replace cwd/root path assumptions with script-relative V3 paths.
5. Add deterministic V3-owned architecture-admission manifests and the explicit root
   authoring-to-admission lockstep compiler/gate.
6. Make ordinary V3 verify consume only V3-local source/contracts/manifests.
7. After all references and red tests pass, physically delete obsolete root V3-only
   scripts/tests; do not retain fallback copies.

Exit: V3 has one gate implementation surface and root authoring inputs cannot affect
ordinary V3 build without an explicit reviewed admission-manifest update.

### Phase 4: Version, Install, Distribution, and Packaging Isolation

1. Move install/distribution/pack scripts and tests under V3 ownership.
2. Embed the V3-local version through `ROUTECODEX_BUILD_VERSION`; remove all V3
   dependency on root build-info/version mutation.
3. Move install Cargo target into `v3/build-control/install-target/<run-id>` and retain
   cleanup on success, Cargo failure, signal interruption, and publication failure.
4. Assemble the repository binary at `v3/dist/bin/rccv3`.
5. Stage dev/npm packages in `v3/build-control/pack/<run-id>` and write final packages
   to `v3/artifacts/pack`.
6. Update distribution tests for path/hash/version/bin aliases, missing outputs,
   cleanup, interrupted builds, and rejection of external staging/target paths.
7. Ensure global publication remains atomic and no install/release snapshot fallback
   is introduced.

Exit: build/install/pack compilation and staging write only under V3; global install
is an explicit final publication of the verified V3 binary.

### Phase 5: Root npm, CI, and Release Thinning

1. Convert root V3 aliases to thin `npm --prefix v3` dispatchers.
2. Replace root CI's individual V3 gate/build/install/test matrix with the V3
   canonical entrypoint, retaining separate jobs only when platform/runtime isolation
   requires it and still invoking V3-owned commands.
3. Point Node/Cargo caches and dependency paths at V3 locks/targets.
4. Make release workflow read the V3 version, invoke the V3 pack command, and upload
   `v3/artifacts/pack`.
5. Add red gates rejecting future re-expansion of root CI/package scripts into
   individual V3 crates/gates, root version reads, or root artifact paths.
6. Keep genuinely repo-wide cross-version integration checks root-owned and run them
   after—not inside—the standalone V3 admission contract.

Exit: root owns orchestration/integration only; V3 owns its complete build graph.

### Phase 6: Full Source and Isolation Verification

1. Run every static, positive, negative, write-set, architecture, and package gate in
   Section 8 from a clean isolated worktree.
2. Run the canonical V3 command from V3 root, root thin dispatcher, unrelated cwd,
   and a standalone/sparse V3 test environment.
3. Perform the post-diff module boundary review before declaring functional success.
4. Confirm no V4 semantic diff, no root runtime semantic diff, no sharedmodule change
   beyond exact three-crate retirement, and no unrelated worker change.

Exit: source/build/isolation gates green with evidence; no live claim yet.

### Phase 7: Global Install, Aggregate Restart, Live Replay, Review, Commit

1. Build and install through the V3-local canonical install command. Compilation and
   install target remain in V3; publication is atomic to `~/.local/bin/rccv3`.
2. Verify installed path, aliases, code signature where applicable, hash, and embedded
   version against `v3/dist/bin/rccv3` and the V3 version truth.
3. Run `rccv3 config check` against the active V3 config truth.
4. Execute exactly one aggregate restart using the global installed command:
   `routecodex restart -c /Volumes/extension/.rcc/config.v3.toml`, or the verified
   active config path if it has legitimately changed. Never use stop/start,
   foreground/manual start, broad kill, or per-port restart.
5. Discover all configured listener ports from config truth and verify every `/health`
   reports the newly installed build version.
6. Replay representative real old samples through the same entries, including Direct
   and Relay plus JSON/SSE protocol surfaces required by the current V3 verification
   map. Verify terminal shape, usage, logs, and canonical sample evidence.
7. Only after install/restart/live evidence, run DSH Review via the mandated MCP using
   `opencode-go/deepseek-v4-flash`. DSH FAIL enters a repair/revalidation/review loop;
   Codex Review may take over only if DSH explicitly reports unavailable.
8. If review causes any source/test/build/map/config change, invalidate the old PASS
   and repeat affected source, install, restart, live replay, and review steps.
9. Commit intentional changes in reviewable boundaries; exclude generated/build
   outputs and unrelated dirty files.

Exit: installed/runtime truth matches isolated V3 source, DSH PASS exists, scoped
commits are complete, and no required work remains.

## 7. Expected File Surface

The exact list must be finalized by Phase 0. Expected changes include:

### New or V3-Localized

- `v3/package.json`
- `v3/package-lock.json`
- `v3/rust-toolchain.toml`
- `v3/.cargo/config.toml`
- `v3/crates/provider-compat-core/**`
- `v3/crates/servertool-core/**`
- `v3/crates/stop-message-core/**`
- `v3/scripts/*.mjs`
- `v3/scripts/architecture/*.mjs`
- `v3/scripts/tests/*.mjs`
- `v3/tests/scripts/*.mjs`
- `v3/tests/resources/**` required by migrated gates
- `v3/build-contracts/architecture-admission/**`
- V3-local release/version manifest if `v3/package.json` is not the sole version truth
- this plan and affected generated/human V3 review surfaces

### Updated

- `v3/Cargo.toml`
- `v3/Cargo.lock`
- V3 consumer Cargo manifests
- relevant V3 crate/source references required solely by relocation
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/v3-build-tool-module-registry.yml`
- affected V3 manifests/wiki/review surfaces and their canonical generators
- root `package.json`/lock only for V3 thin dispatch/dependency cleanup
- `.github/workflows/test.yml` and `.github/workflows/release.yml` only for V3 thinning
- project routing/skill references only where moved V3 build-tool paths require it
- `sharedmodule/llmswitch-core/rust-core/Cargo.toml` only to retire exact migrated
  workspace members

### Deleted After Proven Migration

- `sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/**`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/**`
- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/**`
- obsolete root V3-only scripts, helpers, tests, and fixtures whose V3-local owners are
  verified and whose references are fully migrated

Deletion is limited to these proven migrated surfaces. No V4 or unrelated root/shared
deletion is authorized.

## 8. Verification Matrix

Skipped gates, missing fixtures, zero samples, fallback execution, or oral inspection
do not count as evidence.

### 8.1 Static Workspace, Dependency, and Ownership Gates

- Cargo metadata asserts V3 workspace root, target root, full member set, and zero
  path dependency outside V3.
- Cargo tree contains one package/source identity for each relocated crate.
- No tracked V3 source/build/test/gate reference compiles from V4, root runtime, or
  sharedmodule.
- V3 Cargo/Node/toolchain/version locks are tracked and consumed; Cargo gates use
  `--locked` where applicable.
- V3 Node resolution cannot fall back to root modules.
- V3 machine/admission maps bind real paths, symbols, owners, adjacent edges, and
  executable local commands.
- Every V3 build script has one module owner; root CI/package aliases match only the
  approved thin-dispatch forms.
- Root authoring maps and V3-local admission manifests pass deterministic lockstep.

### 8.2 Relocated-Crate Equivalence

- Pre/post focused unit and integration tests for all three crates.
- Provider request/response compatibility characterization and red cases.
- Servertool/Stopless request and response Chat Process semantics, continuation, and
  control-plane leakage red cases.
- V3 runtime and CLI consumers compile/test against the V3-local packages.
- Compile-fail and source gates reject duplicate owners, shared path revival, wrong
  direction, non-adjacent calls, provider-specific Hub branches, and control state in
  payload.
- Public API and representative compiled behavior match the approved baseline; any
  unexplained semantic delta fails the migration.

### 8.3 Positive Build, Test, and Architecture Gates

- `npm ci --ignore-scripts` from V3.
- Cargo fmt, clippy, locked build, full workspace tests through the V3-local artifact
  budget wrapper, and CLI release build.
- Existing architecture CI umbrella, resource/function/mainline/module/verification
  gates, generated review sync, Rust-only gates, protocol/Direct/Relay/continuation/
  servertool/Stopless/error/health/debug/SSE gates, and every required red-fixture
  suite after path migration.
- Cargo artifact-budget positive/failure/warm-cache/concurrency/2-GiB cases.
- Distribution and install cleanup tests.
- Dev/npm package creation and content/hash/version/bin-entry verification.
- Canonical `verify:ci` from V3 root, root dispatcher, and unrelated cwd.

### 8.4 Negative Isolation Tests

- Any Cargo path dependency escaping V3 is rejected.
- Sharedmodule crate owner or old package path revival is rejected.
- Duplicate crate/package/source owner is rejected.
- Missing/stale/tampered V3-local admission manifest is rejected without root fallback.
- Root `package.json`, root build-info/version, root `node_modules`, root scripts, root
  dist/artifacts, V4, sharedmodule, or OS-temp compile/staging access is rejected.
- External `CARGO_TARGET_DIR`, temp, dist, artifact, or pack staging override is
  rejected.
- Missing/empty required fixture directory is rejected.
- Root CI/package script enumerating individual V3 gates/crates or reading root
  version/artifacts is rejected.
- Build/install/package identity entering request/response/provider wire,
  MetadataCenter/debug/Error payload is rejected.
- Direct/Relay shape, continuation immutable interval, Error01-06 order, or
  request/response node shortcut mutations remain red.

### 8.5 Filesystem Write-Set Audit

Run the full V3 build/test/verify/install-build/pack stack from a clean isolated
worktree and compare filesystem state before/after.

Allowed mutable build roots:

- `v3/target`;
- `v3/build-control`;
- `v3/generated`;
- `v3/dist`;
- `v3/artifacts`;
- declared external package download caches;
- explicit final publication under `~/.local/bin` only during the install phase.

Any root/V4/sharedmodule/OS-temp compilation or package staging output fails. Tracked
source mutation by ordinary build/test/verify also fails.

### 8.6 Global Install and Live Verification

- `v3/dist/bin/rccv3` and `~/.local/bin/rccv3` hash/version identity.
- `routecodex`, `rcc`, and `rccv3` resolve to the intended installed binary.
- `rccv3 config check` succeeds and `~/.rcc/install/**` remains absent.
- Exactly one aggregate `routecodex restart -c <active-config>` succeeds.
- Every configured listener `/health` reports the new V3 version.
- Same-entry real old samples cover current required Direct/Relay and JSON/SSE paths,
  complete terminally, preserve protocol/payload semantics, and report expected usage.
- Canonical per-port sample directories and server logs contain no new build/path,
  provider, pipeline, Error-chain, SSE, continuation, or payload/control leakage
  regression.

### 8.7 Final Review

- Pre-functional and post-diff module-boundary audits.
- Scoped architecture/diff review with explicit owner/path/resource/edge/plane checks.
- DSH Review PASS after the installed/live evidence.
- `git diff --check` and exact commit/diff scope evidence.

## 9. Risks and Mitigations

| Risk | Required mitigation |
|---|---|
| Three-crate relocation creates duplicate semantic owners | Preserve bytes first, migrate all consumers/maps, prove zero references, then physically remove old trees; never keep both. |
| A hidden non-V3 consumer needs a shared crate | Full Cargo/source consumer audit before relocation; if found, stop and redesign ownership rather than copying. |
| Moving 100+ scripts loses a gate or red fixture | Classify and migrate one file at a time, preserve gate IDs/counts, and compare pre/post command/gate inventories. |
| Root modules/config silently satisfy missing V3 dependencies | Standalone/sparse test with root package, node_modules, scripts, and ancestor Cargo config unavailable. |
| Local admission snapshot becomes a second hand-edited truth | Deterministic canonical generator, source digests, tracked output, root lockstep gate, and no manual semantic editing of generated manifests. |
| Install/pack cleanup writes outside V3 | V3-local run-scoped staging plus positive/failure/signal cleanup tests and write-set audit. |
| Version divergence between binary, package, release, and health | One V3 version truth with red tests for every projection; root version is forbidden input. |
| Build migration accidentally changes runtime semantics | Relocated-crate equivalence, full V3 gates, global install, aggregate restart, and same-entry old-sample replay. |
| Existing workers collide on root maps/runtime crates | Dedicated clean worktree, semantic claims, evidence/handoff protocol, and no broad cleanup/reset. |
| Semantic bulk migration causes unreviewable drift | Read every semantic file and use explicit `apply_patch` hunks; only declared canonical generators may create mechanical outputs. |

## 10. Commit Strategy

Prefer these reviewable boundaries; split further when required to keep buildable
commits:

1. `build(v3): own local toolchain and commands`
   - local package/lock/toolchain/config, canonical runners, isolation skeleton.
2. `refactor(v3): own shared rust crates`
   - three V3-local crates, workspace/consumer changes, owner maps, equivalence gates,
     exact shared workspace/source retirement.
3. `build(v3): localize gates and admission`
   - V3-only scripts/tests/renderers, deterministic admission manifests, maps/review
     surfaces, obsolete root V3 script retirement.
4. `build(v3): isolate install and packages`
   - V3 version truth, install target, dist, pack staging/artifacts, distribution tests.
5. `ci(v3): dispatch isolated build domain`
   - root thin aliases, CI/release thinning, V3 version/artifact paths.

Every commit must exclude target/build-control/generated/dist/artifact outputs and
unrelated dirty files. Review PASS is invalidated by any subsequent source/test/build/
map/CI change.

## 11. Definition of Done

The task is complete only when all statements below have evidence:

- V3 has one local canonical build/test/verify/install/pack surface and owns its
  Node/Rust/version locks.
- Cargo metadata contains all V3-owned crates, including provider-compat/servertool/
  stop-message, and no path dependency escapes V3.
- The old sharedmodule implementations/workspace entries are physically gone after
  zero-consumer and equivalence proof; no duplicate/fallback implementation remains.
- All ordinary V3 compile/test/gate/install-build/pack inputs are under V3 except
  declared external executables/download caches and deterministic repo-integration
  authoring compilation.
- All mutable build/test/package outputs and staging are under V3; only explicit final
  publication writes `~/.local/bin`.
- Root npm, CI, and release are thin V3 dispatchers; root version, root build-info,
  root dist/artifacts, and root V3-only scripts are no longer V3 build owners.
- V3-local architecture admission is deterministic, source-bound, and lockstepped
  with canonical authoring without ordinary-build root fallback.
- All existing V3 positive and red architecture/runtime/build/distribution gates pass.
- Filesystem write-set audit proves no root/V4/sharedmodule/OS-temp compile or package
  output.
- The installed binary matches V3 dist/version/hash; one aggregate restart, every
  listener health, and required real old-sample replays pass.
- Request/response/error topology, payload/control-plane separation, Direct/Relay,
  continuation, provider and SSE behavior remain unchanged.
- V4 and unrelated root/shared semantics have no diff; shared changes are limited to
  exact migrated crate retirement and references.
- Post-diff architecture review and DSH Review pass.
- Intentional commits are complete; generated outputs and unrelated changes are not
  committed.
- `note.md` and `MEMORY.md` contain only verified final truth, and MemoryPalace is
  re-mined/searched when healthy; an index outage is reported rather than hidden.

## 12. Completion Report Contract

The final report must state, with command/artifact evidence:

1. final V3 directory/build ownership and canonical commands;
2. three-crate owner migration and zero escaping dependency proof;
3. Node/Rust/version locks and architecture-admission manifest identity;
4. pre/post gate inventory and all positive/red results;
5. install/pack paths, cleanup, and filesystem write-set result;
6. installed/dist hash/version identity;
7. aggregate restart, all-listener health, real old-sample replay, and log evidence;
8. DSH verdict and exact commits;
9. deleted obsolete owners and confirmation that no fallback/duplicate remains;
10. remaining risks or explicit `none`;
11. explicit confirmation that V4 and unrelated root/shared/runtime semantics were
    untouched.

