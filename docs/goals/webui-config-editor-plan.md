# WebUI Config Editor Implementation Plan

## Goal

Rebuild the RouteCodex WebUI into an online `config.toml` editor focused on provider configuration, per-port routing configuration, and `fwd.*` aggregation configuration.

## Acceptance Criteria

- WebUI reads the current multi-port `config.toml` shape and renders one routing tab per configured `[[httpserver.ports]]` entry.
- WebUI can create a new port tab and configure standard routing against existing providers.
- Provider section auto-reads existing providers and renders one card per provider.
- Each provider card supports scoped backup and restore without exposing provider secrets.
- `fwd.*` section can aggregate aliases for the same model and configure `priority`, `weighted`, and `roundrobin`.
- All other legacy WebUI functions are removed from the required UI/test surface unless Jason explicitly re-approves them.
- Config writes flow through shared config codec/writer owners; WebUI does not stringify TOML or own routing/forwarder selection semantics.

## Scope

In scope:

- `webui/src/App.tsx`
- `webui/src/styles.css`
- `tests/frontend/webui-app.*`
- Necessary admin/config API surface under mapped owner paths:
  - `src/server/runtime/http-server/daemon-admin/providers-handler.ts`
  - `src/server/runtime/http-server/daemon-admin/providers-handler-routing-utils.ts`
  - `src/server/handlers/config-admin-handler.ts`
- Existing shared config codec/writer tests.

Out of scope unless explicitly approved:

- Live production `~/.rcc/config.toml` mutation during development.
- Provider runtime behavior changes.
- Rust Virtual Router forwarder selection behavior changes.
- Restart/start/stop controls inside WebUI.
- Stats/control/ops pages as required WebUI behavior.
- Auth/secret handling redesign beyond preserving existing admin gate and no-secret-exposure constraints.

## Source Of Truth

- Loop gate: `docs/loops/runtime-lifecycle/gate-matrix.md`, row `webui_config_editor`.
- Feature owner: `docs/architecture/function-map.yml`, `feature_id: webui.config_editor_surface`.
- Verification owner: `docs/architecture/verification-map.yml`, `feature_id: webui.config_editor_surface`.
- Mainline owner: `docs/architecture/mainline-call-map.yml`, `chain_id: webui.config_editor_surface.mainline`.
- Binding budget: `docs/architecture/mainline-binding-budget.yml`, `chain_id: webui.config_editor_surface.mainline`.
- Config codec/write owners:
  - `config.user_config_codec`
  - `config.user_config_write_surface`
  - `config.provider_config_codec`
  - `config.provider_config_write_surface`
- Forwarder runtime owner: `vr.provider_forwarder_runtime`.

## Design Principles

- WebUI is a thin editor surface only.
- Provider config read/write stays in provider config codec/writer owners.
- User config read/write stays in user config codec/writer owners.
- `fwd.*` editor may write config shape, but must not implement provider selection, health, priority, weighted, or roundrobin policy.
- No fallback, no silent success, no disabled/weakened tests.
- Use fixtures/test config for blackbox save validation; do not write live production config without explicit approval.
- Preserve other workers' dirty changes; use precise patches, precise staging, and no checkout/reset.

## Implementation Slices

### Slice 0: Commit Gate/Map Baseline

- Review and precisely stage only the gate/map files already prepared for `webui.config_editor_surface`.
- Do not stage unrelated worker files.
- Commit the baseline before UI implementation.

Required checks:

- `git diff --check`
- `npm run verify:runtime-lifecycle-loop-gate-matrix`
- `npm run verify:architecture-mainline-binding-pending-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:function-map-compile-gate`

### Slice 1: Remove Legacy WebUI Required Surface

- Remove `ops`, `stats`, `control`, and restart-control behavior from required WebUI tests.
- Keep admin authentication gate unless a separate approved scope removes it.
- Update tests so the required surface is config editor only.

Required checks:

- `npm run test:webui`

### Slice 2: Config-Only WebUI Structure

- Build config-focused tabs/sections:
  - Providers
  - Routing by port
  - Forwarders
- Render current providers as cards.
- Render current `[[httpserver.ports]]` as route tabs.
- Render `virtualrouter.forwarders."fwd.*"` as aggregation rows/cards.

Required checks:

- `npm run test:webui`
- `npm run build:webui`

### Slice 3: Provider Cards Backup/Restore

- Add provider backup/restore using shared provider config read/write paths.
- Ensure UI never displays or stores raw provider secrets.
- Use fixture/test provider configs for tests.

Required checks:

- `npm run test:webui`
- `npm run verify:config-ssot`

### Slice 4: Routing Tabs And Provider Picker

- Add per-port route tabs backed by `config.toml`.
- New port creates a new tab and config entry.
- Route provider selection must come only from existing provider IDs.
- Save through shared user config writer/codec.

Required checks:

- `npm run test:webui`
- `npm run verify:config-ssot`

### Slice 5: Forwarder Aggregation Editor

- Support `fwd.*` aggregation config for same-model aliases.
- Expose config for `priority`, `weighted`, and `roundrobin`.
- Do not implement selection policy in WebUI or TS runtime.

Required checks:

- `npm run test:webui`
- `npm run verify:config-ssot`
- `npm run verify:vr-forwarder-runtime`

### Slice 6: Final Blackbox And Build Closure

- Run fixture-backed browser/API smoke:
  - read providers
  - render one card per provider
  - backup/restore one provider
  - render one tab per configured port
  - create a new port tab
  - select providers from existing provider IDs
  - edit `fwd.*` aggregation with all three strategies
  - validate/save config
  - reload and prove semantic equivalence
- Run full mapped gates.

Required checks:

- `npm run test:webui`
- `npm run verify:config-ssot`
- `npm run verify:vr-forwarder-runtime`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-binding-pending-gate`
- `npm run build:base`

## Risk Controls

- If target files contain unrelated dirty edits, stop and report collision before editing.
- If a required API cannot safely save to a fixture/test config, add test-safe path support through mapped owners before feature UI.
- If a WebUI behavior requires provider runtime or VR selection changes, stop and split into a new approved feature.
- If tests require old ops/stats/control UI, update or remove those test expectations in Slice 1 rather than preserving removed product scope.

## Definition Of Done

- WebUI is config-editor only.
- Provider cards, per-port route tabs, provider picker, and `fwd.*` editor are covered by tests.
- Old WebUI functions are not required behavior.
- Config writes are owner-correct and fixture blackbox verified.
- All required gates pass.
- Changes are committed in scoped commits without staging unrelated worker changes.
