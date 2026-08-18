# V3 Provider Directory Config Test Design

## Lifecycle under test

```text
root config read
  -> native V3 authoring parsed
  -> authoring mode selected
  -> referenced provider ids collected
  -> exact provider/<id>/config.v2.toml files read
  -> V2-compatible Provider codec compiled
  -> combined source identity built
  -> schema validated
  -> registry and manifest published
  -> CLI/server/runtime consume manifest only
```

## White-box positive cases

1. Native V3 root without `[providers.*]` loads referenced Provider files.
2. Forwarder Provider targets and direct route-pool Provider targets are both discovered.
3. Auth `env`, `tokenFile`, and legacy literal `apiKey` compile to internal handles without secret projection.
4. `[provider.v3]` preserves health, semantic-error policy, provider-request cleanup, compatibility profile, model fields, and features.
5. Repeated loads are deterministic.
6. Changing only a referenced Provider file changes `source_sha256` and published manifest.
7. Unreferenced Provider directory entries are not loaded.
8. Legacy all-inline V3 root continues to compile without reading the directory.

## White-box negative cases

1. Referenced Provider file is missing.
2. Directory name, `providerId`, and `[provider].id` disagree.
3. Root partially mixes inline and missing directory providers.
4. Provider file contains unsupported type or malformed V3 extension.
5. Provider model referenced by route/forwarder is absent.
6. Auth has none or more than one of `env`, `tokenFile`, and `apiKey` per entry.
7. Provider source changes cannot leave `source_sha256` unchanged.

## Module black-box

- `V3ConfigStore::load_snapshot_with_source_identity` on a temporary `<root>/config.v3.toml` plus sibling Provider files.
- Assert manifest provider count and exact protocol/model/auth/policy projection.
- Assert no Provider source text or secret literal appears in debug formatting.

## Project black-box

1. `rccv3 config check -c /Volumes/extension/.rcc/config.v3.toml` with no inline Provider blocks.
2. Install and aggregate restart with the published manifest.
3. `/health` on 10000, 4444, and 5555.
4. Provider-request dry-run proves configured Provider/model/auth owner still resolves.
5. Real same-entry request proves Provider switching and response semantics continue.

## Red-first evidence

Before implementation, the positive native-V3 directory fixture must fail because `V3Config02AuthoringParsed.providers` is required or because referenced providers are unknown. The negative mixed-source fixture becomes green only when explicit source-mode rejection exists.

## Required gates

- Focused Provider directory Config tests.
- Existing `test:v3-config-v2-compat-5555`.
- Config crate tests.
- `verify:v3-cargo-fmt`.
- `verify:v3-clippy`.
- `test:v3-workspace`.
- Function/resource/mainline/wiki gates.
- V3 CLI build, global install, config check, aggregate restart, health and live replay.

## Known non-goals

- No Provider hot reload without managed restart.
- No runtime directory discovery.
- No new Provider protocol.
- No movement of route/forwarder/server policy into Provider files.
