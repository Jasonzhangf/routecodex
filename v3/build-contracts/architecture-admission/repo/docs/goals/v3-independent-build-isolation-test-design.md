# V3 Independent Build Isolation Test Design

Status: active; positive, negative, distribution, install, live, and review-remediation coverage implemented

## Goal

Prove that V3 compilation, tests, architecture admission, install-build, assembly,
package staging, and release artifacts are owned by `v3/`, while explicit global
publication is limited to the verified `~/.local/bin/rccv3` binary. Runtime protocol,
payload, control-plane, Direct/Relay, continuation, provider, Error, and SSE semantics
must remain equivalent.

## Lifecycle

1. `V3BuildDomain00RootDispatcher` may dispatch to a V3-local canonical command.
2. `V3BuildDomain01LocalContractsLoaded` loads only V3-local Node, Cargo, toolchain,
   version, and admission contracts.
3. `V3BuildDomain02AdmissionVerified` rejects missing, stale, tampered, escaping, or
   root-fallback inputs.
4. `V3BuildDomain03LocalArtifactsProduced` writes only declared V3-local mutable roots.
5. `V3BuildDomain04ReleaseSurfaceReady` emits V3-local packages or atomically
   publishes the already-built verified binary.

## White-Box Positive

- V3 package and lock resolve dependencies without root `package.json`,
  `package-lock.json`, or `node_modules`.
- Cargo metadata reports `v3/` workspace root, `v3/target`, the complete member set,
  and zero escaping path dependencies.
- The three relocated crates retain package names, public APIs, tests, and dependency
  direction while moving to one V3-local source owner.
- Architecture admission is deterministic, source-bound, schema-validated, and
  consumed without ordinary-build access to root maps.
- Cargo test artifact cleanup preserves reusable dependencies and enforces the 2 GiB
  idle budget on success and failure.
- Install and pack run-scoped targets/staging are created and released under
  `v3/build-control`.
- Version, dist binary, package metadata, installed binary, and health version agree.

## White-Box Negative

- Reject missing V3 package/toolchain/config/admission inputs.
- Reject any Cargo path dependency, source import, target, temp, staging, dist, or
  artifact path escaping V3.
- Reject root dependency/module fallback, root version/build-info input, sharedmodule
  crate revival, duplicate crate owner, and duplicate package source identity.
- Reject root package, CI, or release enumeration of V3 crates or internal gates.
- Reject missing/empty test resources and skipped gate matrices.
- Reject build/install/package identity in request/response/provider wire,
  MetadataCenter, debug, continuation, or Error payloads.
- Reject runtime topology, Direct/Relay shape, continuation immutable-interval, and
  Error01-06 mutations.

## Module Black-Box

- Run canonical build, test, verify, install-build, and pack from `v3/`.
- Run root thin dispatchers and the absolute V3 package entry from an unrelated cwd.
- Run a standalone V3 copy with root package, root modules, root scripts, V4,
  sharedmodule source, and ancestor Cargo config unavailable.
- Compare pre/post Cargo metadata, tree, focused crate tests, workspace tests, CLI
  behavior, package contents, hashes, and architecture gate inventory.

## Project Black-Box

- Audit filesystem writes before/after the full stack; only declared V3 roots and
  external download caches may change before explicit publication.
- Install the V3-local build globally, verify binary/alias/hash/version identity, run
  config check, then execute exactly one aggregate restart.
- Verify every configured listener health endpoint and replay required Direct/Relay
  JSON/SSE old samples through their original entries.
- Audit canonical samples and logs for build-path, provider, pipeline, Error, SSE,
  continuation, and control/payload regressions.

## Required Gates

- `npm run verify:v3-resource-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-module-boundaries`
- V3-local isolation positive/red gates: pending implementation
- V3-local full architecture CI: pending implementation
- V3-local distribution/install/pack tests: pending implementation
- Filesystem write-set audit: pending implementation
- Post-install DSH Review: pending live closeout

## Known Gaps

The current root-owned build wrappers, scripts, architecture inputs, install target,
dist/artifact outputs, shared crate paths, and CI matrices intentionally make the
future isolation red gate fail. No design entry may be promoted to active until its
real path, symbol, gate, and runtime evidence exist.
