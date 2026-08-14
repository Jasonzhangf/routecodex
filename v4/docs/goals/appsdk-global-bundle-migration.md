# RouteCodex V4 Global AppSDK Bundle Migration

## Scope

Migrate V4 governance to the globally installed `appsdk 0.1.0 (rust)` Bundle. This change owns only SDK admission, Bundle resources, lock identity, governance records, and verification wiring.

## Invariants

- `command -v appsdk` is the only executable entry.
- `.appsdk/sdk.bin` is a read-only, non-executable digest witness and is never invoked.
- Bundle contracts, docs, rules, and skills are installed by `appsdk init`; project code does not maintain independent copies.
- Existing RouteCodex module IDs, Active artifact relationships, Protected history, pipeline semantics, payload semantics, and Rust ownership remain unchanged.
- Runtime may not read `playground/**`, `generated/**`, or `protected/source/**`.
- No fallback, parallel SDK version, second compiler, or compatibility guess is permitted.

## Locked Identity

```text
binary: /Users/fanzhang/.local/bin/appsdk
version: appsdk 0.1.0 (rust)
binary/compiler digest: sha256:6092578e3dee95e2fb9fd3e6f8a3a9f109aed79efaacc164bbfe0b856e4aceae
bundle digest: sha256:1c91fcc629f38663d0f7d3eaa185798bd7b56f66830b7d516227eb3a6dcdf20f
bundle manifest digest: sha256:2b82b87ef07bc31dcb77875f9d3f0405625f963709daed828b64f8eaa8965e95
```

## Verification

```text
appsdk verify v4
cargo fmt --all -- --check
cargo test --workspace
cargo build --release --workspace
```

Negative checks cover Bundle/resource tampering, path traversal, symlink resources, Active artifact mismatch, review rejection, missing FreezeRecord, and local witness execution.

## Known Boundary

Current Cargo consumers still compile frozen modules through source path dependencies. Active-only Cargo library consumption requires an explicit artifact-linking design and is not claimed by this governance-only migration.
