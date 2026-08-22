# LM Studio Compatibility Tools Payload Copy Budget Test Design

## Feature

- `feature_id`: `debug.lmstudio_compat_tools_payload_copy_budget`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/lmstudio-compatibility-tools-test.mjs::applyLMStudioCompatibility`
- Resource: `debug.lmstudio_compat_tools_projection`

## Risk

The LM Studio compatibility debug script deep-cloned each complete request before creating a `parameters` projection, normalizing tool choice, mapping max tokens, and allocating normalized tool wrappers. Large messages, tools, parameter schemas, content, and extension branches were copied even though only top-level parameters and tool wrappers were rewritten.

## Positive Tests

- The returned debug request and its `parameters` projection are independently owned.
- Normalized tools and function wrappers are independently owned where rewritten.
- Unchanged messages, top-level tools, parameter schemas, content, and extension branches retain reference identity.
- The source request, tool choice, and tool definitions remain unchanged.

## Negative Tests

- Source residue rejects `JSON.parse(JSON.stringify(request))`, `structuredClone`, and `deepClone`.
- Importing the script must not call LM Studio, create report directories, or write artifacts.
- This slice must not change live provider compatibility semantics, provider configuration, `config.toml`, `~/.rcc`, routing, or MetadataCenter.

## Verification

- `pnpm jest tests/scripts/lmstudio-compatibility-tools-payload-copy-budget.spec.ts --runInBand`
- `node --check sharedmodule/llmswitch-core/scripts/tests/lmstudio-compatibility-tools-test.mjs`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- `node scripts/architecture/verify-no-fallback-diff.mjs --files sharedmodule/llmswitch-core/scripts/tests/lmstudio-compatibility-tools-test.mjs tests/scripts/lmstudio-compatibility-tools-payload-copy-budget.spec.ts`
- target `git diff --check`

## Boundary

This is a debug compatibility simulation only. Optional localhost LM Studio IO remains direct CLI execution and is not part of this source/Jest slice. No provider config, `config.toml`, `~/.rcc`, install, restart, live provider request, or RSS measurement is changed.
