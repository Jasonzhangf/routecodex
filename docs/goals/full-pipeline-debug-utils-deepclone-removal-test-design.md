# Debug Utils DeepClone Removal Test Design

## Scope

`feature_id: debug.unified_surface` owns this narrow dead-API cleanup. It removes only the zero-caller legacy `deepClone` helpers from `src/utils/debug-utils.ts` and the matching `DebugUtils` interface declaration in `src/types/debug-types.ts`.

This slice does not migrate or delete the remaining sanitizer/format/logger utility surface, because `src/utils/logger.ts` still consumes `DebugUtilsStatic.sanitizeData`.

## Lifecycle

1. `src/utils/logger.ts` passes log values through `DebugUtilsStatic.sanitizeData`.
2. The legacy debug utils file still exposes unrelated helper methods.
3. `deepClone` has no production/test caller and is a duplicate full-payload clone API outside the unified debug owner.
4. Removing it must not change sanitize behavior or logger output redaction.

## Positive Cases

- `DebugUtilsStatic.sanitizeData` remains callable for logger/debug usage.
- Sensitive fields continue to be redacted.
- `DebugUtilsStatic.calculateDataSize`, `formatData`, timing helpers, and ID helpers remain unchanged.

## Negative Cases

- `src/utils/debug-utils.ts` must not define `deepClone`.
- `DebugUtilsStatic` must not expose `deepClone`.
- `src/types/debug-types.ts` must not require `DebugUtils.deepClone`.
- No replacement JSON round-trip, `structuredClone`, or recursive clone helper may be introduced in this legacy utility file.

## Boundary

- Do not delete `src/utils/debug-utils.ts` until sanitizer/logger migration has its own owner slice.
- Do not move debug/log data into provider/client payloads, routing, or MetadataCenter.
- This is dead API deletion and source/build memory-risk reduction, not a live RSS claim.

## Required Gates

- `npm run jest:run -- --runInBand --runTestsByPath tests/debug/debug-utils-deepclone-removal.spec.ts tests/debug/unified-surface.owner.spec.ts`
- `npm run verify:debug-unified-surface`
- `npm run verify:function-map-compile-gate`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`
