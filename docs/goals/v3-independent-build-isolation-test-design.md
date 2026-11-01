# V3 Independent Build Isolation Test Design

Status: active behavior contract, updated for governance ablation. Historical implementation results remain in run records.

## Goal

Prove that V3 compilation, tests, install-build, assembly,
package staging, and release artifacts are owned by `v3/`, while explicit global
publication is limited to the verified `~/.local/bin/rccv3` binary. Runtime protocol,
payload, control-plane, Direct/Relay, continuation, provider, Error, and SSE semantics
must remain equivalent.

## Lifecycle

1. `V3BuildDomain00RootDispatcher` may dispatch to a V3-local canonical command.
2. `V3BuildDomain01LocalContractsLoaded` loads only V3-local Node, Cargo, toolchain,
   and version contracts.
3. `V3BuildDomain02AdmissionVerified` checks required local inputs, dependency ownership and dependency/output path isolation. Its historical name does not require an admission snapshot.
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
- Architecture tools read canonical maps directly. Builds do not create admission mirrors.
- Cargo test artifact cleanup preserves reusable dependencies and enforces the 2 GiB
  idle budget on success and failure.
- Install and pack run-scoped targets/staging are created and released under
  `v3/build-control`.
- Version, dist binary, package metadata, installed binary, and health version agree.

## White-Box Negative

- Reject missing V3 package/toolchain/config inputs.
- Reject any Cargo path dependency, source import, target, temp, staging, dist, or
  artifact path escaping V3.
- Reject root dependency/module fallback, root version/build-info input, sharedmodule
  crate revival, duplicate crate owner, and duplicate package source identity.
- Reject root `bin` publication, root `dist/` package output, and resurrection of the
  retired root `start`/`dev`/`start:bg`/`start:fg` lifecycle aliases.
- Reject root package, CI, or release enumeration of V3 crates or internal gates.
- Reject missing/empty test resources and skipped gate matrices.
- Reject build/install/package identity in request/response/provider wire,
  MetadataCenter, debug, continuation, or Error payloads.
- Reject runtime topology, Direct/Relay shape, continuation immutable-interval, and
  Error01-06 mutations.

## Module Black-Box

- Run canonical build, test, verify, install-build, and pack from `v3/`.
- Run root thin dispatchers and the absolute V3 package entry from an unrelated cwd.
- Confirm root runtime aliases remain absent and managed runtime control is only the
  globally installed `routecodex restart` lifecycle.
- Run a standalone V3 copy with root package, root modules, root scripts, V4,
  sharedmodule source, and ancestor Cargo config unavailable.
- Check affected Cargo metadata, consumers, CLI behavior and package contents. Reuse unchanged evidence.

## Project Black-Box

- Audit filesystem writes before/after the full stack; only declared V3 roots and
  external download caches may change before explicit publication.
- When runtime installation is in scope, use the formal install entry, verify command/version and config behavior, then request explicit approval before a live restart.
- Verify every configured listener health endpoint and replay required Direct/Relay
  JSON/SSE old samples through their original entries.
- Audit canonical samples and logs for build-path, provider, pipeline, Error, SSE,
  continuation, and control/payload regressions.

## Required Gates

- `npm run verify:v3-resource-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-module-boundaries`
- `npm --prefix v3 run verify:isolation`
- `npm --prefix v3 run test:isolation:red`
- `npm --prefix v3 run verify:ci`
- `npm --prefix v3 run test:distribution`
- `npm --prefix v3 run test:install-cleanup`
- Select affected isolation, distribution and cleanup checks from actual failure modes. This list does not require rerunning all gates for each edit.
- One milestone review follows author verification. Runtime changes require applicable health and same-entry replay; tooling-only changes use their scoped consumers.

## Known Gaps

Current execution gaps belong to the owning run notes. This design does not claim current build, installation, live acceptance or delivery.
