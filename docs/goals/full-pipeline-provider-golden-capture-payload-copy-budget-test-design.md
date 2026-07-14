# Provider Golden Capture Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.provider_golden_capture_payload_copy_budget`
- Owner: `scripts/tools/capture-provider-goldens.mjs::buildDerivedConfig`
- Resource: `debug.provider_golden_capture_config_projection`

## Risk

The provider golden capture CLI deep-cloned the complete loaded config and selected provider config before changing only the provider id, selected provider map, default routing target, and temporary HTTP host/port. Large model catalogs, auth/header extensions, and unrelated config branches were duplicated before the derived config was serialized to its temporary artifact.

## Positive Tests

- The derived config owns independent top-level, `virtualrouter`, `providers`, `routing`, provider-wrapper, and `httpserver` objects.
- The caller-owned base config and provider config remain unchanged.
- Unchanged model, auth, header, extension, and unrelated branches retain reference identity until temporary artifact serialization.
- Existing virtual-router and HTTP-server fields not explicitly overridden remain semantically equivalent.

## Negative Tests

- Source residue rejects complete `baseDoc` and `providerConfig` JSON round-trip clones.
- Source residue rejects generic `structuredClone` and `deepClone` helpers.
- Importing the module must not scan provider configuration, write capture artifacts, spawn RouteCodex, or call provider IO.
- This slice must not change `normalizeProviderIdentifiers`, live provider configuration, `config.toml`, or `~/.rcc`.

## Verification

- `pnpm jest tests/scripts/capture-provider-goldens-payload-copy-budget.spec.ts --runInBand`
- `node --check scripts/tools/capture-provider-goldens.mjs`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `node scripts/architecture/verify-no-fallback-diff.mjs --files scripts/tools/capture-provider-goldens.mjs tests/scripts/capture-provider-goldens-payload-copy-budget.spec.ts`
- target `git diff --check`

## Boundary

This is a debug temporary-config projection only. No provider capture, provider config write, `config.toml`, `~/.rcc`, global install, restart, live provider request, or RSS measurement is part of this slice.
