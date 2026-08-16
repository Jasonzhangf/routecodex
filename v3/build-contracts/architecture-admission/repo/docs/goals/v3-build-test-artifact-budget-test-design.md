# V3 Build Test Artifact Budget Test Design

## Goal

Keep the steady-state allocated size of `v3/target/debug` at or below 2 GiB. Every canonical V3 Cargo test must remove only artifacts owned by that test invocation after success or failure while preserving reusable dependency artifacts whenever the dependency cache remains inside the budget.

## Lifecycle

1. `V3BuildTest01CommandAccepted` accepts one V3 `cargo test` argument vector.
2. `V3BuildTest02ArtifactsProduced` runs Cargo with JSON artifact messages and records test executables emitted by that invocation.
3. `V3BuildTest03OwnedArtifactsReleased` removes emitted test executables, matching dep-info, and `rcgu.o` intermediates whose filenames match executables reported by this invocation.
4. `V3BuildTest04BudgetVerified` measures allocated bytes under the RouteCodex-owned target namespace; reusable dependencies remain below 2 GiB, while an idle over-budget cache is evicted with Cargo test-profile cleanup inside that namespace only.

## Positive Tests

- A passing test returns its exit status and removes its emitted test executable and matching intermediates.
- A failing test preserves the test failure exit status and still removes only artifacts matched to executables reported by Cargo.
- Reusable dependency files such as `lib*.rlib`, `lib*.rmeta`, proc-macro dylibs, fingerprints, and build-script outputs remain when the total cache is within 2 GiB.
- Above 2 GiB, an idle build tree is evicted through Cargo's test-profile owner and remeasured.
- The test profile disables incremental state and full debug symbols to bound transient output.
- Lock acquisition records the wrapper's own process-start identity without enumerating processes; failure to initialize the owner record removes the newly created lock.

## Negative Tests

- A raw V3 Cargo test in `package.json` that bypasses the canonical wrapper fails the architecture gate.
- Cleanup must not remove an unrelated dependency artifact, timestamp-new object file, or another test invocation's artifact.
- A stale lock whose recorded owner process is gone or whose PID has been reused is reclaimed; only a live process with the recorded process-start identity remains exclusive. Process-start inspection uses locale-stable output so non-English host locales cannot make two live wrappers share the target.
- When a restricted environment denies process-start inspection for another live PID, the lock remains conservative only for a bounded lease and cannot become permanent.
- A relative `CARGO_TARGET_DIR` is resolved against the repo root, then the wrapper appends `routecodex-v3-test` and passes that isolated absolute namespace to Cargo.
- An explicit shared `CARGO_TARGET_DIR` keeps unrelated workspace artifacts outside the RouteCodex cleanup namespace.
- An over-budget directory with another active V3 builder fails explicitly instead of racing cleanup against compilation.
- A post-eviction directory above 2 GiB fails explicitly; it must not silently report success.
- Runtime crates, request/response payloads, MetadataCenter, provider state, installed releases, and live samples are forbidden cleanup inputs.

## Verification

- `npm run verify:v3-build-test-artifact-budget`
- `npm run test:v3-build-test-artifact-budget-red-fixtures`
- `npm run verify:v3-architecture-ci`
- `npm run verify:v3-resource-map`
- `npm run verify:function-map-compile-gate`
- `git diff --check`

## Known Limit

The 2 GiB contract is a post-test steady-state budget. Rust compilation can temporarily allocate working files before the test executable starts; the reduced test profile minimizes that peak. The wrapper never uses timestamps to infer ownership of failed-build object files because that can corrupt a concurrent Cargo invocation.
