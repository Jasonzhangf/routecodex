# 9691233 evidence

Candidate worktree: `playground/provider-cooldown-listener-0912`
at `origin/main` (`6e86a7e60`) plus this uncommitted diff.

- `v3/crates/routecodex-v3-provider-responses/src/health.rs`
- `v3/crates/routecodex-v3-provider-responses/src/health/persistence.rs`

Fix: provider cooldown persistence path is now scoped by the enabled server
scope from the published manifest. Different listener scopes no longer enqueue
replace-ticket snapshots into the same `provider-cooldowns.json`, which was the
last-writer-wins wipe source for independent stores.

Commands and results:

```text
cargo fmt --all -- --check
=> exit 0

git diff --check
=> exit 0

cargo test -p routecodex-v3-provider-responses --lib 'health::persistence::tests::provider_cooldown_state_path_is_scoped_to_enabled_server_id' -- --exact
=> ok

cargo test -p routecodex-v3-provider-responses --lib
=> 81 passed; 0 failed

cargo test -p routecodex-v3-provider-responses --test provider_global_cooldown_persistence_contract
=> 3 passed; 0 failed

cargo clippy -p routecodex-v3-provider-responses --lib --all-targets --no-deps
=> exit 0; existing warnings only, no new blocker
```

Rechecked after `path_component_slug` rename:

```text
cargo fmt --all -- --check
=> exit 0

cargo test -p routecodex-v3-provider-responses --lib 'health::persistence::tests::provider_cooldown_state_path_is_scoped_to_enabled_server_id' -- --exact
=> ok

ROUTECODEX_V3_SOURCE_ROOT=<candidate> node v3/scripts/architecture/verify-v3-module-boundaries.mjs
=> [verify:v3-module-boundaries] ok

ROUTECODEX_V3_SOURCE_ROOT=<candidate> node v3/scripts/architecture/verify-v3-resource-map.mjs
=> [verify:v3-resource-map] ok

cargo test -p routecodex-v3-provider-responses --test provider_global_cooldown_persistence_contract -- --nocapture
=> 3 passed; 0 failed
```

The contract test above was run directly inside the candidate worktree
(`playground/provider-cooldown-listener-0912/v3`), not through the root
`run-v3-cargo-test.mjs` wrapper.

## Codex Review r1 and scope-identity fix

`codex-0912-9691233-r1` failed with two P1 findings:

1. The first scope slug joined enabled server IDs with `_`, so `a_b` and
   `a`+`b` could collide, and the same server ID on different bind/port values
   shared one persistence file.
2. Mapped persistence gates were not all executed/retained in review scope.

Fix applied in the candidate worktree:

- `provider_cooldown_state_path_for_manifest` now hashes a canonical
  length-prefixed encoding of enabled server declarations: server id, bind,
  and port.
- `sha2.workspace = true` was added to
  `v3/crates/routecodex-v3-provider-responses/Cargo.toml`.
- The regression test now covers different IDs, same ID on different
  bind/port, and the `a_b` vs `a`+`b` collision shape.

Post-fix evidence:

```text
cargo fmt --all -- --check
=> exit 0

cargo test -p routecodex-v3-provider-responses --lib 'health::persistence::tests::provider_cooldown_state_path_is_scoped_to_enabled_listener_scope' -- --exact
=> ok

cargo test -p routecodex-v3-provider-responses --lib
=> 81 passed; 0 failed

cargo test -p routecodex-v3-provider-responses --test provider_global_cooldown_persistence_contract -- --nocapture
=> 3 passed; 0 failed

cargo clippy -p routecodex-v3-provider-responses --lib --all-targets --no-deps
=> exit 0; existing warnings only, no new blocker

ROUTECODEX_V3_SOURCE_ROOT=<candidate> node v3/scripts/architecture/verify-v3-module-boundaries.mjs
=> [verify:v3-module-boundaries] ok

ROUTECODEX_V3_SOURCE_ROOT=<candidate> node v3/scripts/architecture/verify-v3-resource-map.mjs
=> [verify:v3-resource-map] ok

git diff --check
=> exit 0
```

No install, restart, health, or same-entry live replay was performed.
