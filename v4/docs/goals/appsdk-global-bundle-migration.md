# RouteCodex V4 Global AppSDK Bundle Migration

## Scope

Migrate V4 governance to the globally installed `appsdk 0.1.0 (rust)` Bundle. This change owns only SDK admission, Bundle resources, lock identity, governance records, and verification wiring.

## Invariants

- `command -v appsdk` is the only executable entry.
- `.appsdk/sdk.bin` is an optional, gitignored digest witness and is never invoked; the running global binary is the only execution truth.
- Bundle contracts, docs, rules, and skills are installed by `appsdk init`; project code does not maintain independent copies.
- Admission gate `global_sdk_only` verifies only the global binary digest against `sdk.lock.digest` and then runs `appsdk verify`; it never requires or executes a local `sdk.bin`.
- Existing RouteCodex module IDs, Active artifact relationships, Protected history, pipeline semantics, payload semantics, and Rust ownership remain unchanged.
- Runtime may not read `playground/**`, `generated/**`, or `protected/source/**`.
- No fallback, parallel SDK version, second compiler, or compatibility guess is permitted.

## Locked Identity

```text
binary: /Users/fanzhang/.local/bin/appsdk
version: appsdk 0.1.0 (rust)
binary/compiler digest: sha256:199029a778465d51e5890d6e0896bc0b4813b2b03c2954f38e76d6afb0719844
bundle digest: sha256:1c91fcc629f38663d0f7d3eaa185798bd7b56f66830b7d516227eb3a6dcdf20f
bundle manifest digest: sha256:2b82b87ef07bc31dcb77875f9d3f0405625f963709daed828b64f8eaa8965e95
```

## Verification

```text
appsdk verify v4
command -v appsdk && appsdk version && test -x "$(command -v appsdk)" && test "$(shasum -a 256 "$(command -v appsdk)" | cut -d ' ' -f 1)" = "$(jq -r .digest v4/.appsdk/sdk.lock)" && appsdk verify v4
cargo fmt --all -- --check
cargo test --workspace
cargo build --release --workspace
```

## CI Admission

`.github/workflows/test.yml` runs the `v4-appsdk-admission` job on `macos-14` (same arm64 platform as the pinned artifact). The job downloads the public release artifact `appsdk-0.1.0-macos-arm64` from `Jasonzhangf/appsdk` tag `v0.1.0`, installs it as `~/.local/bin/appsdk`, and executes the `global_sdk_only` gate. The gate fails when `appsdk` is absent, when its digest does not match `v4/.appsdk/sdk.lock`, or when `appsdk verify v4` fails. Dev machine and CI consume the identical release artifact, so `sdk.lock` pins a single digest for both.

Negative checks cover Bundle/resource tampering, path traversal, symlink resources, Active artifact mismatch, review rejection, missing FreezeRecord, and local witness execution.

## Known Boundary

Current Cargo consumers still compile frozen modules through source path dependencies. Active-only Cargo library consumption requires an explicit artifact-linking design and is not claimed by this governance-only migration.
