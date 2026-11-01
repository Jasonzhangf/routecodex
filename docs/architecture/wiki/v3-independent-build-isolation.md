# V3 Independent Build Isolation

Status: active build-isolation contract. Historical execution results belong to their run records; this page does not assert current build or live acceptance.

## Review Flow

```mermaid
flowchart LR
  A[V3BuildDomain00RootDispatcher] --> B[V3BuildDomain01LocalContractsLoaded]
  B --> C[V3BuildDomain02AdmissionVerified]
  C --> D[V3BuildDomain03LocalArtifactsProduced]
  D --> E[V3BuildDomain04ReleaseSurfaceReady]
```

## Node Contracts

| Node | Owner | Contract |
| --- | --- | --- |
| `V3BuildDomain00RootDispatcher` | root npm/CI/release | Dispatch V3 commands to their V3 owners. |
| `V3BuildDomain01LocalContractsLoaded` | `v3/package.json` | Load V3-local Node, Cargo, toolchain, and version inputs. |
| `V3BuildDomain02AdmissionVerified` | `v3/scripts/verify-isolation.mjs` | Check required local inputs, dependency ownership, and dependency/output path isolation. The historical node name does not require an admission snapshot. |
| `V3BuildDomain03LocalArtifactsProduced` | `v3/scripts/**` | Write compilation, test, assembly, and package staging only under declared V3 roots. |
| `V3BuildDomain04ReleaseSurfaceReady` | V3 install/pack owners | Emit V3-local packages or atomically publish the verified binary. |

## Resource Boundaries

- Source contracts: `v3.build.node_dependency_lock`,
  `v3.build.cargo_dependency_lock`, `v3.build.rust_toolchain_contract`,
  and `v3.build.version_truth`.
- Mutable local outputs: `v3.build.ordinary_cargo_target`,
  `v3.build.install_target`, `v3.build.pack_staging`,
  `v3.build.test_artifact_store`, and `v3.build.dependency_cache`.
- Release candidates: `v3.build.assembled_binary` and
  `v3.build.release_artifacts`.
- Explicit publication: `v3.global_binary_install`.
- Build identity and artifacts never enter request/response/provider wire,
  MetadataCenter, continuation, debug, or Error payloads.

## Ownership Review

- `provider-compat-core` and `servertool-core` move byte-first
  into `v3/crates/`; path edits follow the move.
- Shared crate ownership stays in V3. Verify affected consumers and path isolation when that ownership changes.
- V4 and root runtime semantics are forbidden scope.
- Root authoring maps remain canonical. Architecture tools read those maps directly; ordinary builds do not create an admission mirror.

## Failure Paths

- Missing local input: fail before build.
- Escaping dependency or output path: fail before write.
- Active concurrent V3 builder during over-budget eviction: fail without racing.
- Failed install/pack: release run-owned staging; do not publish partial output.
- Any runtime semantic delta: fail migration and return to the owning runtime feature.

## Verification Boundaries

Use the affected isolation consumer tests and actual build/install results. Keep runtime request/response/error behavior in its owning regression suite. A tooling result does not prove installation, restart, health, or live replay. Live lifecycle actions require explicit approval.

## Canonical Sources

- `docs/goals/v3-independent-build-isolation-plan.md`
- `docs/goals/v3-independent-build-isolation-test-design.md`
- `docs/architecture/manifests/v3.build.independent_domain.mainline.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-build-tool-module-registry.yml`
- `docs/architecture/v3-verification-map.yml`
