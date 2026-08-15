# RouteCodex V4 Global AppSDK Bundle Migration

## Scope

Migrate V4 governance to the globally installed `appsdk 0.1.2 (rust)` Bundle. This change owns only SDK admission, Bundle resources, lock identity, governance records, and verification wiring.

## Invariants

- `command -v appsdk` is the only executable entry.
- `.appsdk/sdk.bin` is an optional, gitignored digest witness and is never invoked; the running global binary is the only execution truth.
- Bundle contracts, docs, rules, and skills are installed by `appsdk init`; project code does not maintain independent copies.
- `appsdk init <workspace>` reads `.appsdk-prepare.json` from the workspace argument and resolves the project via its `project_root` (`v4`). For this repository the confirmed invocation is `appsdk init /Users/fanzhang/Documents/github/routecodex`, not `appsdk init .../v4`; the latter fails `PREPARATION_MISSING` because no second preparation record exists inside `v4/`.
- Admission gate `global_sdk_only` verifies only the global binary digest against `sdk.lock.digest` and then runs `appsdk verify --admission`; it never requires or executes a local `sdk.bin` and does not require locally generated artifacts that are gitignored.
- Existing RouteCodex module IDs, Active artifact relationships, Protected history, pipeline semantics, payload semantics, and Rust ownership remain unchanged.
- Runtime may not read `playground/**`, `generated/**`, or `protected/source/**`.
- No fallback, parallel SDK version, second compiler, or compatibility guess is permitted.

## Locked Identity

```text
binary: /Users/fanzhang/.local/bin/appsdk
version: appsdk 0.1.2 (rust)
binary/compiler digest: sha256:3685149eab60ed887737e1ff0c9a6ddbbd0add32424d40595e27296ebf7b8686
bundle digest: sha256:1fecd4fc44263ea270d47f096cf40ed1706b659880f808e2d2dcf24b87001b86
bundle manifest digest: sha256:3786ee502e23be59e4583249b80950d422f0c0212feef70554bb84fb62465301
```

The pinned binary is published as `Jasonzhangf/appsdk` release tag `v0.1.2` asset
`appsdk-0.1.2-macos-arm64`; that asset is byte-identical to the digest in
`sdk.lock` and to the globally installed binary (`sha256` verified at pin time).

## Verification

```text
appsdk verify v4
command -v appsdk && appsdk version && test -x "$(command -v appsdk)" && test "sha256:$(shasum -a 256 "$(command -v appsdk)" | cut -d ' ' -f 1)" = "$(jq -r .digest v4/.appsdk/sdk.lock)" && appsdk verify --admission v4
cargo fmt --all -- --check
cargo test --workspace
cargo build --release --workspace
```

## CI Admission

`.github/workflows/test.yml` runs the `v4-appsdk-admission` job on `macos-14` (same arm64 platform as the pinned artifact). The job downloads the public release artifact `appsdk-0.1.2-macos-arm64` from `Jasonzhangf/appsdk` tag `v0.1.2`, installs it as `~/.local/bin/appsdk`, and executes the `global_sdk_only` gate (`appsdk verify --admission v4`). Admission verify covers SDK identity, lock digest, bundle resources, governance contracts, maps, and goal contract without requiring gitignored generated or Active artifacts. Full `appsdk verify v4` remains the local lifecycle gate where generated artifacts exist. The gate fails when `appsdk` is absent or its digest does not match `v4/.appsdk/sdk.lock`. Dev machine and CI consume the identical release artifact, so `sdk.lock` pins a single digest for both.

Negative checks cover Bundle/resource tampering, path traversal, symlink resources, Active artifact mismatch, review rejection, missing FreezeRecord, and local witness execution.

## Known Boundary

Current Cargo consumers still compile frozen modules through source path dependencies. Active-only Cargo library consumption requires an explicit artifact-linking design and is not claimed by this governance-only migration.
