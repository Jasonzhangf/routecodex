# Hub Chain Equivalence Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.hub_chain_equivalence_payload_copy_budget`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/hub-chain-equivalence.mjs::sanitizePayload`
- Resource: `debug.hub_chain_equivalence_sanitized_payload`

## Risk

The Hub chain equivalence diagnostic script deep-cloned complete protocol payloads before deleting only debug-only comparison fields such as `metadata.__rcc_tools_field_present`, `metadata.__rcc_raw_system`, top-level `__rcc_raw_system`, and top-level `__rcc_provider_metadata`.

## Positive Tests

- `sanitizePayload` returns an independent top-level object only when a diagnostic field is removed.
- Metadata is shallow-owned only when diagnostic metadata fields are removed.
- Unchanged `messages`, `tools`, content, schema, extension, and unrelated branches keep reference identity.
- The source payload remains unchanged.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify(payload))`, `structuredClone`, and `deepClone`.
- Importing the script must not load built Hub dist modules, run conversion chains, read samples, or call provider/native IO.
- This slice must not change protocol conversion semantics, provider config, live payload truth, or MetadataCenter.

## Verification

- `pnpm jest tests/scripts/hub-chain-equivalence-payload-copy-budget.spec.ts --runInBand`
- `node --check sharedmodule/llmswitch-core/scripts/tests/hub-chain-equivalence.mjs`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- target `git diff --check`

## Boundary

This is a debug equivalence comparison projection only. Direct chain execution requires built sharedmodule dist artifacts and is not live provider/RSS evidence. No provider config, `config.toml`, `~/.rcc`, install, restart, or provider request is changed.
