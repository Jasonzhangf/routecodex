# Coverage Hub Standardized Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.coverage_hub_standardized_payload_copy_budget`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-envelope-to-standardized-native.mjs`
- Resource: `debug.coverage_hub_standardized_parity_projection`

## Risk

The coverage helper compares TS and native standardized request projections. It previously used a JSON round-trip helper on both outputs before equality checks, creating complete extra object graphs in a debug parity path.

## Positive Tests

- `tests/scripts/coverage-hub-chat-envelope-payload-copy-budget.spec.ts` locks the source path so parity comparison no longer uses JSON round-trip object clones.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify(value))`.
- Source residue rejects the removed `stableJson(` helper.
- Source residue rejects generic `structuredClone(` / `deepClone(` helpers in this diagnostic script.

## Verification

- `pnpm jest tests/scripts/coverage-hub-chat-envelope-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `git diff --check -- sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-envelope-to-standardized-native.mjs tests/scripts/coverage-hub-chat-envelope-payload-copy-budget.spec.ts docs/goals/full-pipeline-coverage-hub-standardized-payload-copy-budget-test-design.md docs/design/payload-copy-hotspot-inventory.md docs/architecture/resource-operation-map.yml docs/architecture/function-map.yml docs/architecture/verification-map.yml docs/architecture/mainline-call-map.yml note.md MEMORY.md .agents/skills/rcc-dev-skills/references/93-lessons-2026-07.md`

## Boundary

This is debug coverage/parity code only. The native call still serializes at the current JS/Rust JSON boundary, which is tracked separately as a contract limit. This slice does not modify provider config, `config.toml`, `~/.rcc`, runtime routing, provider/client payload truth, global install, restart, or live provider replay.
