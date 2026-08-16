# Coverage Hub Chat Projection Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.coverage_hub_chat_projection_payload_copy_budget`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-standardized-to-chat-native.mjs`
- Resource: `debug.coverage_hub_chat_projection_parity`

## Risk

The standardized-to-chat coverage helper compared already materialized TS and native chat projections by serializing and parsing both complete outputs for both full and minimal fixtures. These four debug-only JSON round trips created comparison graphs without owning conversion semantics.

## Positive Tests

- Full and minimal parity assertions compare the already materialized TS/native outputs directly.
- The helper remains parseable after removing the comparison helper.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify(value))` and the deleted `stableJson` helper.
- Source residue rejects generic `structuredClone` and `deepClone` helpers.
- This slice must not modify conversion semantics, the JS/Rust JSON boundary, provider configuration, or live payload truth.

## Verification

- `pnpm jest tests/scripts/coverage-hub-standardized-to-chat-payload-copy-budget.spec.ts --runInBand`
- `node --check sharedmodule/llmswitch-core/scripts/tests/coverage-hub-standardized-to-chat-native.mjs`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- target `git diff --check`

## Boundary

This is a debug coverage comparison only. Direct CLI execution depends on built sharedmodule artifacts and is not provider/live/RSS evidence. No provider config, `config.toml`, `~/.rcc`, install, restart, or provider request is changed.
