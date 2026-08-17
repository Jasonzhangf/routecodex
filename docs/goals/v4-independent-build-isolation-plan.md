# V4 Independent Build Isolation Plan

Status: proposed execution design; implementation pending  
Design ID: `V4-INDEPENDENT-BUILD-ISOLATION-20260816`  
Owner feature: `v4.build.independent_domain`  
Scope root: `v4/`

## 1. Objective and Acceptance Contract

Make RouteCodex V4 a self-contained build domain. All V4 source inputs, dependency
locks, build/test/architecture-gate entrypoints, intermediate outputs, generated
artifacts, packaging outputs, and machine-readable build ownership must live under
`v4/`. V3, root runtime source, and `sharedmodule/` must not participate in V4
compilation or act as live V4 admission inputs.

The completed build domain must satisfy all of the following:

1. `cd v4` is sufficient to install V4 build dependencies and run the complete V4
   build, test, architecture, AppSDK admission, Active-link, and red-gate stack.
2. `cargo metadata --manifest-path v4/Cargo.toml` reports `v4/` as
   `workspace_root` and `v4/target` as `target_directory`.
3. No V4 Cargo manifest, build script, test runner, AppSDK command, or architecture
   verifier compiles source outside `v4/` or writes build output outside `v4/`.
4. V4 verification does not dynamically read active V3 maps. V3 parity inputs are
   explicit, immutable, versioned V4-owned baseline contracts whose update requires
   a reviewed supersession.
5. Root `package.json` and GitHub Actions contain only thin dispatchers into the V4
   canonical entrypoint; they do not own or duplicate the V4 module/gate matrix.
6. A copy or sparse checkout containing `v4/` can run the complete V4 verification
   stack with only declared external tools and package-manager caches available.
7. V4 runtime semantics, payloads, control resources, Active artifacts, Protected
   history, and frozen module behavior remain unchanged by this build-governance
   migration.

External Rust/npm caches and the globally installed, digest-pinned AppSDK executable
are tool dependencies, not V4 build outputs. They may be read, but V4 compilation,
test scratch space, generated files, and package staging must remain inside `v4/`.
Publishing or installing a completed artifact outside `v4/` is a separate explicit
release action and is out of scope for this task.

## 2. Current-State Evidence

The implementation must re-audit these facts from the approved base before editing;
they are starting evidence, not permission to skip discovery:

- V4 Cargo already resolves `workspace_root=v4` and `target_directory=v4/target`.
- The Cargo workspace contains `routecodex-v4-base-node`,
  `routecodex-v4-build-link`, and `routecodex-v4-skeleton`; the remaining V4
  consumers are built and tested through `routecodex-v4-build-link`.
- Build-link already writes ordinary scratch/output to `v4/target`,
  `v4/build-control`, `v4/generated`, and `v4/active/lib`.
- Eleven V4 architecture verifiers are still owned by root
  `scripts/architecture/verify-v4-*.mjs` and consume root Node dependencies.
- V4 has no local `package.json` or Node lockfile.
- `v4/Cargo.lock` is ignored and untracked.
- `verify-v4-feature-gap.mjs`, `verify-v4-v3-resource-coverage.mjs`, and
  `verify-v4-relay-continuation.mjs` dynamically read active V3 architecture maps.
- `v4/.appsdk/maps/verification-map.json` records root-cwd commands such as
  `--manifest-path v4/Cargo.toml`, `--root v4`, and
  `scripts/architecture/verify-v4-*.mjs`.
- Debug/router/provider/server AppSDK regression commands use V4-local
  `working_directory: "."` but contain root-relative `v4/Cargo.toml` and `v4`
  arguments; the command contract must be normalized and proved by real AppSDK
  execution.
- Root GitHub Actions duplicates the complete V4 consumer regression matrix.

## 3. Scope and Boundaries

### 3.1 In Scope

- V4-local package manifest, dependency lock, Rust toolchain pin, and canonical
  build/test/verify entrypoints.
- Relocation and path normalization of all V4-only architecture verifiers and their
  V4-only red fixtures/helpers.
- V4-owned immutable V3 feature/resource/continuation baseline contracts.
- V4 machine maps and AppSDK project command normalization.
- V4-local build/test/generated/artifact/staging directory policy.
- Static and dynamic isolation gates proving read, dependency, command, and write
  boundaries.
- Root npm and CI compatibility shims reduced to one V4-local invocation.
- Required documentation, map lockstep, tests, DSH Review, and intentional commits.

### 3.2 Explicitly Out of Scope

- Any V3 source, V3 build-system, V3 map, V3 runtime, or V3 release change.
- Root `src/` runtime behavior or `sharedmodule/` changes.
- Provider, routing, retry, continuation, Stopless, servertool, error-policy, SSE, or
  payload semantic changes.
- Re-freezing or changing an existing frozen V4 module solely to move build
  orchestration; frozen source/artifact hashes must remain stable unless an exact
  build-governance contract change demonstrably requires a new AppSDK lifecycle.
- Global RouteCodex installation, managed-server restart, or live provider traffic.
- Reimplementing the existing verifier semantics in a new language without evidence
  that relocation cannot satisfy the objective.
- Introducing a fallback to root scripts, root `node_modules`, active V3 maps, or a
  second build path when the V4-local path fails.

### 3.3 Allowed Root Changes

Root changes are limited to V4 integration points:

- `package.json`: V4 aliases may only dispatch to the V4-local canonical commands.
- `package-lock.json`: only the mechanical consequences of removing root-only V4
  dependencies are allowed, and only when those dependencies are unused elsewhere.
- `.github/workflows/test.yml`: V4 jobs may only install V4 dependencies and invoke
  V4-local commands.
- Other root build/release files may change only when a verified V4 reference must be
  redirected to the V4-local entrypoint.
- Root V4 verifier files may be physically deleted after all references are migrated
  and positive/negative gates prove the V4-local copies are canonical.

No unrelated cleanup is authorized.

## 4. Architecture and Ownership

### 4.1 Canonical V4 Build Surface

Create the following ownership surface, adapting exact filenames only when the
existing project structure proves a smaller equivalent:

```text
v4/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── package.json
├── package-lock.json
├── scripts/
│   ├── build.mjs
│   ├── test.mjs
│   ├── verify.mjs
│   ├── verify-isolation.mjs
│   └── architecture/
│       └── verify-*.mjs
├── contracts/
│   └── v3-baseline/
├── target/
├── build-control/
├── generated/
├── active/
├── dist/
└── artifacts/
```

Do not create wrapper layers that only rename existing commands without establishing
one canonical decision chain. The preferred public contract is:

```text
npm run build
npm run test
npm run verify
npm run verify:red
npm run verify:ci
```

`verify:ci` owns the complete V4 admission matrix. Root CI and root npm aliases call
that command and do not enumerate V4 modules or individual gates.

### 4.2 Path Resolution

All V4 Node entrypoints must resolve `v4Root` from their own `import.meta.url`, not
from `process.cwd()`. Commands must pass from:

- `cd v4`;
- the repository root through `npm --prefix v4`;
- an unrelated current directory using the absolute V4 package path.

Local AppSDK and Cargo commands use V4-local paths:

```text
--manifest-path Cargo.toml
--root .
scripts/architecture/<gate>.mjs
```

The command may omit `--manifest-path` when the V4 working directory makes it
unambiguous. Root-prefixed `v4/Cargo.toml` and `--root v4` are forbidden inside V4
machine maps and `v4/.appsdk/project.json`.

### 4.3 Dependency and Lock Ownership

- Track `v4/Cargo.lock`; remove its ignore rule and execute reproducible Cargo gates
  with `--locked` after the lock is established.
- Pin the supported Rust toolchain in `v4/rust-toolchain.toml`, using the currently
  verified stable toolchain rather than changing compiler semantics opportunistically.
- Declare V4 verifier Node dependencies in `v4/package.json` and track
  `v4/package-lock.json`.
- V4 commands must resolve Node packages from `v4/node_modules`; using root
  `node_modules` as a hidden fallback is forbidden.
- Cargo manifests and build scripts must not contain path dependencies that escape
  `v4/`. Registry/git dependencies require a lock and normal supply-chain review.

### 4.4 V3 Compatibility Baselines

V4 may compare itself with an explicitly frozen V3 contract, but must not read live
V3 maps during ordinary build or verification.

Preserve the existing `v4/contracts/v3-feature-baseline.json` contract and introduce
the smallest additional V4-owned baseline material needed for resource and
relay/continuation coverage. Each baseline must contain or bind:

- schema version;
- source V3 commit/digest;
- ordered or canonically sorted identity set;
- source artifact digest;
- supersedes/superseded-by metadata when applicable;
- an explicit update/review rule.

Baseline generation is never part of `build`, `test`, or `verify:ci`. Updating a
baseline is an explicit reviewed supersession task. A coordinated removal from the
baseline, V4 mapping, V4 contract, and gate input must remain a red case unless a new
reviewed baseline version authorizes it.

### 4.5 Build Output Policy

All mutable V4 build products must be under:

- `v4/target/` for Cargo;
- `v4/build-control/` for test consumers, external dependency scratch workspaces,
  temporary staging, logs needed by gates, and isolation audit manifests;
- `v4/generated/` for deterministic generated outputs;
- `v4/dist/` for assembled binaries/libraries, if any;
- `v4/artifacts/` for packages, if any;
- `v4/active/` and `v4/protected/` only through the existing AppSDK lifecycle.

OS temporary directories, root `dist/`, root `artifacts/`, root `target/`, V3
directories, and sharedmodule target directories are forbidden build-output targets.
Package-manager download caches may remain external, but they may not become source
or artifact truth.

## 5. Machine Map and Contract Changes

Before implementation, bind the build-domain feature into the existing V4 maps. Do
not invent symbols or mark pending work active.

Required map outcomes:

1. `v4/.appsdk/maps/resource-map.json`
   - register the V4 build domain, dependency locks, scratch/output domain, canonical
     verification entrypoint, and immutable V3 baseline as distinct resources;
   - declare root npm/CI as dispatch-only consumers;
   - forbid V3/root/sharedmodule source and active-map dependencies.
2. `v4/.appsdk/maps/function-map.json`
   - register the canonical build/test/verify/isolation entry symbols and their
     required gates.
3. `v4/.appsdk/maps/mainline-call-map.json`
   - express only adjacent build edges: root dispatcher to V4 entrypoint, V4
     entrypoint to local gate/build owners, build-link to local consumer/artifact
     resources;
   - prohibit shortcuts from root CI to individual consumers.
4. `v4/.appsdk/maps/module-registry.json`
   - assign every new V4 build script exactly one module owner;
   - preserve complete, non-overlapping ownership.
5. `v4/.appsdk/maps/verification-map.json`
   - make every command executable from V4 root;
   - register isolation positive and red gates;
   - remove root-relative V4 commands.
6. `v4/.appsdk/project.json`
   - normalize build/regression working directories and local paths;
   - preserve module dependency and Active artifact semantics;
   - do not modify frozen source merely to normalize orchestration.
7. Human-readable V4 architecture/review documents must reflect the same IDs and
   paths. Machine maps remain executable syntax; explanations stay in prose fields or
   this plan.

## 6. Implementation Sequence

### Phase 0: Controlled Worktree and Boundary Re-audit

1. Refresh `.agent-collab` runs, claims, handoffs, merge queue, and kill switch.
2. Create a run ID and claim `feature_id:v4.build.independent_domain`; do not edit a
   semantic area actively owned by another worker without an explicit handoff.
3. Work from an approved clean base in a dedicated `codex/` worktree/branch. Preserve
   every unrelated dirty change in the main worktree.
4. Re-read the V4 resource/function/mainline/module/verification maps and the current
   build-link/AppSDK implementation.
5. Record the exact pre-change read/dependency/write graph and current green/red gate
   baseline in run evidence.

Exit: unique owner, allowed paths, forbidden paths, adjacent edges, required gates,
and existing dirty-work boundaries are documented before edits.

### Phase 1: V4-Local Toolchain and Canonical Commands

1. Add V4-local Node manifest/lock and Rust toolchain/lock ownership.
2. Implement one local build/test/verify orchestration surface.
3. Point all scratch and staging directories into V4.
4. Add initial isolation checks for workspace root, target directory, path
   dependencies, command paths, dynamic V3 reads, and output paths.
5. Prove that root dependencies are not used by temporarily making them unavailable
   in an isolated test environment; do not modify the user's root installation.

Exit: V4-local commands run without root `node_modules` or root package scripts.

### Phase 2: Verifier and Baseline Migration

1. Move each V4-only architecture verifier into `v4/scripts/architecture/`.
2. Read and patch each file individually; do not use semantic bulk replacement.
3. Preserve every positive assertion and red self-test.
4. Replace cwd assumptions with script-relative V4 root resolution.
5. Replace live V3 map reads with reviewed V4-owned immutable baselines.
6. Add red cases for missing baseline, digest mismatch, unauthorized baseline change,
   coordinated collapse, and live V3 dependency revival.
7. After reference checks prove no consumer remains, physically delete the obsolete
   root V4 verifier files rather than keeping fallback copies.

Exit: exactly one verifier implementation exists and all ordinary V4 gate inputs are
inside V4.

### Phase 3: AppSDK and Machine Map Normalization

1. Normalize every V4 AppSDK build/regression command to V4-local paths.
2. Update the five V4 machine maps in lockstep with real paths, commands, symbols,
   ownership, and adjacent build edges.
3. Ensure AppSDK admission still uses the global digest-pinned executable and the
   tracked V4 bundle/records; do not vendor AppSDK into V4.
4. Run real per-module regression and admission checks, including the four commands
   previously mixing V4-local cwd with root-relative paths.

Exit: AppSDK admission and all module regressions execute from V4 root with no
root-relative build input.

### Phase 4: Root and CI Thinning

1. Change root V4 npm aliases into thin `npm --prefix v4 ...` dispatchers.
2. Replace the duplicated V4 GitHub Actions matrix with V4 dependency installation
   and one canonical V4 CI command; keep an AppSDK job only if platform separation is
   required, and make that job call a V4-owned command.
3. Point CI caching at `v4/package-lock.json` and V4 Cargo inputs/outputs.
4. Add a gate that rejects future root CI/package re-expansion into individual V4
   gates or consumer commands.

Exit: root owns orchestration only; the complete module/gate matrix has one V4 owner.

### Phase 5: Full Verification, Review, and Commit

1. Run the full positive and negative matrix in Section 8.
2. Perform post-change architecture boundary review before functional conclusion.
3. Confirm the diff contains no V3, root runtime, sharedmodule, frozen source, Active
   artifact, Protected history, or unrelated worker changes.
4. Only after all required build/test/AppSDK/isolation evidence is complete, run DSH
   Review through the mandated DSH MCP using
   `opencode-go/deepseek-v4-flash`.
5. A DSH FAIL must be fixed and revalidated/reviewed; Codex Review may take over only
   when DSH explicitly reports unavailable.
6. Commit intentional source/config/docs changes with generated outputs excluded.

Exit: review PASS, clean scoped commits, evidence recorded, and no required work
remaining.

## 7. Expected File Surface

The exact list must be finalized after the Phase 0 owner audit. The expected surface
is:

### New or V4-localized

- `v4/package.json`
- `v4/package-lock.json`
- `v4/rust-toolchain.toml`
- `v4/Cargo.lock`
- `v4/scripts/*.mjs`
- `v4/scripts/architecture/verify-*.mjs`
- `v4/contracts/v3-baseline/*`
- isolation red fixtures under `v4/tests/resources/` or another already-allowed,
  tracked V4 test-resource path
- this plan and any necessary V4 review-surface update

### Updated

- `v4/.gitignore`
- `v4/.appsdk/project.json`
- `v4/.appsdk/maps/resource-map.json`
- `v4/.appsdk/maps/function-map.json`
- `v4/.appsdk/maps/mainline-call-map.json`
- `v4/.appsdk/maps/module-registry.json`
- `v4/.appsdk/maps/verification-map.json`
- relevant V4 architecture documents/contracts whose executable references change
- root `package.json` and lock only for thin V4 dispatch/dependency cleanup
- `.github/workflows/test.yml` only for V4 job thinning

### Deleted After Proven Migration

- root `scripts/architecture/verify-v4-*.mjs`
- root-only V4 red helpers/fixtures, if any, after their V4-local canonical copies are
  verified and every reference is migrated

Deletion is limited to confirmed obsolete V4 build/gate files. No V3 or shared file
deletion is authorized.

## 8. Verification Matrix

The implementation must convert these categories into exact executable commands in
the V4 verification map. Skipped or zero-sample gates fail.

### 8.1 Static Architecture and Reproducibility

- Cargo metadata asserts V4 workspace/target ownership.
- All V4 Cargo path dependencies resolve inside V4.
- `v4/Cargo.lock`, `v4/package-lock.json`, and the toolchain pin are tracked and
  consumed.
- No V4 build/gate command contains root-relative `v4/Cargo.toml`, `--root v4`, root
  verifier paths, V3 paths, root `src`, or `sharedmodule` compile inputs.
- V4 Node dependency resolution fails rather than falling back to root modules.
- Machine maps bind real paths/symbols/commands, source files have exactly one owner,
  and build call edges are adjacent and declared.
- Root CI/package files contain only approved V4 dispatcher forms.

### 8.2 Positive Build and Test

- `npm ci --ignore-scripts` from V4.
- V4 Cargo workspace release build and workspace tests with the lock enforced.
- Build-link resolver tests and compile-fail tests.
- Every non-workspace consumer regression through Active/build-link: edge, config,
  control, error, runtime, debug, router, provider, and server.
- Deterministic Active index generation and verification.
- All relocated architecture gates.
- All existing red self-test suites.
- Real `appsdk verify --admission v4` and all required module regressions.
- Canonical `verify:ci` from V4 root, repository root dispatcher, and unrelated cwd.

### 8.3 Negative Isolation Tests

- Escaping Cargo path dependency is rejected.
- A verifier reading `docs/architecture/v3-*` or any path outside V4 is rejected.
- Missing, altered, or unauthorized V3 baseline is rejected.
- Coordinated baseline/mapping/contract collapse remains red.
- Root `node_modules` fallback is rejected.
- Root/V3/sharedmodule/OS-temp build-output target is rejected.
- Root CI enumerating an individual V4 consumer/gate is rejected.
- Root-relative AppSDK command is rejected.
- An unregistered new V4 source/build script or cross-module edge is rejected.
- Frozen source/Active artifact mutation remains rejected by existing lifecycle gates.

### 8.4 Write-Set Audit

Run the full V4 stack from a clean isolated worktree and compare filesystem state
before/after. Allowed mutable write roots are limited to V4-owned ignored build
directories and declared external package-manager caches. Tracked source changes,
root build outputs, V3 outputs, sharedmodule outputs, and OS-temp compile/staging
artifacts fail the audit.

### 8.5 Final Review

- Architecture review: owner/path/resource/edge/map/plane boundaries.
- Diff review: no scope expansion, no fallback, no duplicate verifier, no generated
  artifact commit, no unrelated dirty files.
- DSH Review PASS under the project-prescribed provider/model.

This task does not require global RouteCodex install/restart/live traffic because it
does not change runtime semantics. If implementation unexpectedly changes runtime
code or runtime artifacts, the scope has changed: stop, write a revised design, and
obtain Jason's approval before continuing.

## 9. Risks and Mitigations

| Risk | Required mitigation |
|---|---|
| Verifier relocation silently loses assertions | Preserve each verifier and red test one by one; compare named checks and red-case counts before deleting the root copy. |
| Root Node resolution hides missing V4 dependencies | Run an isolated dependency-resolution negative test with root modules unavailable. |
| Live V3 maps continue to influence V4 | Static forbidden-path gate plus immutable V4-owned baseline digest and supersession contract. |
| Cargo lock/toolchain changes alter frozen artifacts | Establish and review lock/toolchain changes before any freeze action; do not republish frozen modules in this task. |
| CI and V4 local commands become two truth sources | CI calls only `verify:ci`; a red gate rejects individual root V4 gate/consumer commands. |
| AppSDK VCS-clean gate collides with other workers | Use a dedicated clean worktree and `.agent-collab` semantic claim; never clean or overwrite the main worktree. |
| Broad mechanical migration creates semantic drift | Read each file and use explicit `apply_patch` hunks; formatter only for declared mechanical formatting. |
| Standalone criterion is weakened by undocumented exceptions | Keep external-tool/cache exceptions explicit and machine-tested; no root source, root dependency, or live V3 input exception. |

## 10. Commit Strategy

Prefer three reviewable commits, adjusted only if AppSDK freeze mechanics require a
smaller atomic boundary:

1. `build(v4): own local toolchain and gates`
   - local package/toolchain/locks, orchestration, relocated verifier sources,
     immutable baselines, isolation tests.
2. `build(v4): bind isolated AppSDK commands`
   - AppSDK project and five machine maps, V4 review docs, real admission evidence.
3. `ci(v4): dispatch isolated verification`
   - root thin aliases, root verifier deletion, CI thinning.

Each commit excludes ignored/generated artifacts and unrelated changes. Any change
after DSH PASS invalidates that PASS and requires affected verification and review
again.

## 11. Definition of Done

The task is complete only when all statements below are evidenced:

- V4 has one local canonical build/test/verify surface and its own Node/Rust locks.
- Every V4 compiler/test/verifier/AppSDK input needed for ordinary admission is under
  `v4/`, except declared external executables and immutable package caches.
- Every mutable build/test/package output is under `v4/`.
- No Cargo path dependency, verifier, AppSDK command, or CI build step compiles or
  dynamically consumes V3, root runtime source, or `sharedmodule`.
- V3 compatibility is checked exclusively against reviewed V4-owned immutable
  baselines.
- All workspace and non-workspace V4 modules pass the canonical positive stack.
- Isolation, baseline, ownership, edge, payload/control-plane, and lifecycle red
  gates pass by correctly rejecting their fixtures.
- AppSDK admission is `contract_bound` and every affected module regression passes.
- Root npm and CI are thin dispatchers; obsolete root V4 verifier implementations are
  physically gone.
- V3, root runtime, and sharedmodule have no semantic diff from this task.
- The scoped diff passes architecture review and DSH Review.
- Intentional changes are committed; generated outputs and unrelated dirty files are
  not committed.
- `note.md` and `MEMORY.md` contain only verified final truths, and the MemoryPalace
  write/index/search loop is closed when its index is healthy. A MemoryPalace outage
  is reported explicitly and is not misrepresented as a successful search.

## 12. Completion Report Contract

The final report must state, with command or artifact evidence:

1. what moved and what became the unique V4 owner;
2. the final canonical commands;
3. Cargo/Node/toolchain lock and workspace/target facts;
4. positive and negative verification results;
5. AppSDK admission and DSH verdict;
6. filesystem write-set result;
7. exact commits;
8. remaining risks or `none`;
9. explicit confirmation that V3/root runtime/sharedmodule semantics were untouched.
