# V4 Build Domain

Design ID: `V4-INDEPENDENT-BUILD-ISOLATION-20260816`
Owner feature: `v4.build.independent_domain`

## Canonical entrypoints

From `v4/` (or via the root thin dispatcher `npm --prefix v4 ...`, or from any
unrelated cwd through the absolute V4 package path):

| Command | Owner | Covers |
|---|---|---|
| `npm run build` | `v4/scripts/build.mjs` | Cargo workspace release build with tracked lock (`--locked`) |
| `npm run test` | `v4/scripts/test.mjs` | Cargo workspace tests (incl. resolver/compile-fail red tests) with tracked lock |
| `npm run verify` | `v4/scripts/verify.mjs` | workspace build, hermetic Active restore, 11 architecture gates, 9 consumer regressions, Active index gen/verify, isolation positive/red matrix |
| `npm run verify:red` | `v4/scripts/verify-red.mjs` | verifier red self-test suites (isolation matrix is owned by the `verify` positive surface) |
| `npm run verify:ci` | `v4/scripts/verify-ci.mjs` | complete admission matrix (workspace tests + `verify` + `verify:red`; build and isolation run inside `verify`) |
| `node scripts/verify-isolation.mjs` | `v4/scripts/verify-isolation.mjs` | isolation positive + red gates (workspace/target ownership, path deps, forbidden refs, Node resolution, module ownership, root dispatchers, output targets) |

Root `package.json` and `.github/workflows/test.yml` only dispatch to
`verify:ci`; they do not enumerate V4 modules or gates.

`v4/.appsdk/maps/verification-map.json` command entries execute with
`cwd = v4` (declared in `command_context`); they are not runnable from the
repository root.

## Locks and toolchain

- `v4/Cargo.lock` is tracked; all cargo gates run `--locked`.
- `v4/package-lock.json` is tracked; V4 Node dependencies resolve from
  `v4/node_modules` only (`js-yaml` is the sole declared V4 Node dependency).
- `v4/rust-toolchain.toml` pins the verified stable Rust toolchain.

## Build output policy

All mutable V4 build products stay under `v4/`:

| Root | Purpose |
|---|---|
| `v4/target` | Cargo workspace output |
| `v4/build-control` | test consumers, external-dep scratch workspaces, Active index, isolation audit |
| `v4/generated` | deterministic generated outputs (AppSDK lifecycle) |
| `v4/dist`, `v4/artifacts` | assembled binaries/packages |
| `v4/active`, `v4/protected` | AppSDK lifecycle-managed surfaces |

Root, V3, `sharedmodule/`, and OS temp directories are forbidden build-output
targets. Package-manager download caches and the digest-pinned global AppSDK
are read-only tool dependencies.

## V3 compatibility baselines

V4 ordinary build/test/verify never reads live V3 architecture maps. The only
V3 input is the immutable, V4-owned baseline bundle under
`v4/contracts/v3-baseline/`:

- `manifest.json` — schema version, frozen status, source V3 commits, artifact
  digests, canonical identity sets, supersession rule;
- `v3-function-map.yml` — frozen V3 function map snapshot;
- `v3-resource-operation-map.yml` — frozen V3 resource map snapshot;

The pre-existing `v3-feature-baseline.json` feature anchor stays at
`v4/contracts/v3-feature-baseline.json` (contracts root); it is not part of the
immutable `v3-baseline/` bundle.

Baseline updates require explicit reviewed supersession (new `baseline_id`,
digest, and `superseded_by`). Missing, altered, or unauthorized baselines are
red; coordinated removal from baseline + mapping + contract remains red.

## Resource/edge model

The build domain registers distinct resources in
`v4/.appsdk/maps/resource-map.json`:

- `v4.build.domain`, `v4.build.node_lock`, `v4.build.rust_lock`,
  `v4.build.toolchain` — build-domain truth and locks;
- `v4.build.verification_entrypoint`, `v4.build.architecture_gates` —
  canonical V4-owned entrypoints;
- `v4.build.scratch_output`, `v4.build.generated_output`,
  `v4.build.dist_output`, `v4.build.artifact_output`, `v4.build.cargo_target` —
  V4-owned output domains;
- `v4.build.v3_baseline` — immutable V3 parity input;
- `v4.build.root_dispatcher` — root npm/CI, dispatch-only consumer;
- `v4.build.forbidden_v3_live_map`, `v4.build.forbidden_root_dependency` —
  forbidden-read/dependency invariants.

Mainline build edges are adjacent only: root dispatcher -> V4 `verify:ci` ->
V4 local gate/build owners -> build-link -> consumers/artifacts. Root CI
shortcuts into individual V4 consumers are prohibited and red.

## Ownership

`routecodex-v4-governance` owns the build domain authoring surface
(`.appsdk/**`, `contracts/**`, `docs/**`, `tests/**`, `scripts/**`,
`Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`,
`rust-toolchain.toml`, `.gitignore`). Each `crates/<module>/**` tree is owned
by its module. Every V4 source/build file belongs to exactly one module.
