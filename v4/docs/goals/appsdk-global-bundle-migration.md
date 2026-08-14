# RouteCodex V4 Global AppSDK Bundle Migration

## Scope

Migrate only V4 governance contracts, SDK lock, Bundle resources, lifecycle validation, and verification wiring to the globally installed AppSDK 0.1.0 Rust CLI. V3, V4 business crates, pipeline semantics, payload semantics, module ownership, Active APIs, and Protected history are outside this change.

## Execution Boundary

- Command truth: `command -v appsdk` and `appsdk version`.
- Required identity: `/Users/fanzhang/.local/bin/appsdk`, `appsdk 0.1.0 (rust)`.
- `.appsdk/sdk.bin` is a non-executable digest witness required by the 0.1.0 lock contract. It is never an execution entry.
- `.appsdk/contracts/`, `.appsdk/docs/`, `.appsdk/rules/`, `.appsdk/skills/`, and `.appsdk/sdk-resources.json` are installed only by global `appsdk init` or `appsdk pin-lock`.
- Existing canonical `contracts/records/**` and `contracts/transitions/**` remain the project contract aliases required by AppSDK 0.1.0. Their content is byte-equivalent to the global Bundle machine contracts; `.appsdk/contracts/**` plus `sdk-resources.json` prove Bundle provenance. Frozen Protected copies remain immutable historical inputs.

## Immutable Baseline

- Project: `routecodex-v4`, lifecycle `contract_bound`.
- Frozen modules: BaseNode `active-v1`, Edge `active-v1`, Control `active-v1`, Error `active-v2`.
- Active files: 14. Protected files: 100. Generated files: 11.
- Pre-migration local SDK digest: `sha256:e915a081afafe8bff0302e14ad7ccdad72669d8352c8ca68ab0f1fcfef2893df`.
- Global SDK digest: `sha256:6092578e3dee95e2fb9fd3e6f8a3a9f109aed79efaacc164bbfe0b856e4aceae`.
- Bundle digest: `sha256:1c91fcc629f38663d0f7d3eaa185798bd7b56f66830b7d516227eb3a6dcdf20f`.

## Runtime Boundary

Runtime may consume only immutable Active artifacts and a verified compiled manifest. Playground, `protected/source/**`, and Generated temporary files are forbidden runtime inputs. The migration does not add runtime wiring.

## Known Active-Library Blocker

The current V4 Cargo workspace still uses source `path` dependencies from Edge, Control, and Error to `../routecodex-v4-base-node`. This bypasses the Active library as a Cargo dependency surface. V4 is not wired into RouteCodex runtime, so this migration records the gap and does not claim Active-only consumer migration. Resolving it requires a separate versioned Rust dependency design; this governance migration must not rewrite module ownership or APIs.

## AppSDK 0.1.0 Contract Boundaries

- At project lifecycle `contract_bound`, `appsdk verify` validates an installed resource record but does not itself require the SDK lock to be pinned. The `sdk_pinned` and `global_sdk_only` gates therefore bind the global binary, lock digest, compiler digest, local non-executable witness, and Bundle digests explicitly.
- AppSDK 0.1.0 requires the canonical project aliases under `contracts/records/**` and `contracts/transitions/**`. They are byte-equivalent to the embedded global Bundle contracts, but the CLI still reads those aliases in addition to validating `.appsdk/contracts/**`. Removing the aliases requires a future AppSDK contract-path change; this migration does not delete or rewrite frozen contract history.

## Acceptance

1. Global `appsdk verify v4` passes.
2. SDK lock and installed Bundle resources match the global binary.
3. Active and Protected file digest sets remain unchanged.
4. V4 workspace and all declared module regressions pass.
5. Bundle/resource/record/artifact tampering fails explicitly.
6. No business source, V3 source, runtime path, payload shape, or pipeline owner changes.
