import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourcePath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts'
);
const coverageScriptPath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/scripts/tests/coverage-responses-response-utils.mjs'
);
const responsesToolUtilsPath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts'
);
const responsesToolUtilsCoverageScriptPath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/scripts/tests/coverage-responses-tool-utils.mjs'
);
const nativeBarrelPath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts'
);
const requiredExportsPath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts'
);
const bridgePath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'
);

describe('Hub Pipeline responses response utils Rust-only boundary', () => {
  it('does not keep zero-consumer tool-call and finish-reason TS wrappers', () => {
    const source = readFileSync(bridgePath, 'utf8');

    expect(existsSync(sourcePath)).toBe(false);
    expect(source).toContain('buildChatResponseFromResponsesFullWithNative');
    expect(source).not.toContain('collectToolCallsFromResponsesWithNative');
    expect(source).not.toContain('resolveFinishReasonWithNative');
    expect(source).not.toMatch(/export\s+function\s+collectToolCallsFromResponses\b/);
    expect(source).not.toMatch(/export\s+function\s+resolveFinishReason\b/);
  });

  it('does not keep public native wrapper exports for deleted response helpers', () => {
    const barrel = readFileSync(nativeBarrelPath, 'utf8');
    const requiredExports = readFileSync(requiredExportsPath, 'utf8');

    expect(barrel).not.toContain('collectToolCallsFromResponsesWithNative');
    expect(barrel).not.toContain('resolveFinishReasonWithNative');
    expect(requiredExports).not.toContain('collectToolCallsFromResponsesJson');
    expect(requiredExports).not.toContain('resolveFinishReasonJson');
  });

  it('does not keep coverage consumers for deleted wrapper exports', () => {
    expect(existsSync(coverageScriptPath)).toBe(false);
  });

  it('does not keep coverage-only responses tool utils wrapper exports', () => {
    const source = readFileSync(responsesToolUtilsPath, 'utf8');
    const coverageSource = readFileSync(responsesToolUtilsCoverageScriptPath, 'utf8');

    expect(source).not.toMatch(/export\s+function\s+normalizeResponsesToolCallIds\b/);
    expect(source).not.toMatch(/export\s+function\s+resolveToolCallIdStyle\b/);
    expect(source).not.toContain('normalizeResponsesToolCallIdsWithNative');
    expect(source).not.toContain('resolveToolCallIdStyleWithNative');
    expect(coverageSource).not.toMatch(/\bnormalizeResponsesToolCallIds\b/);
    expect(coverageSource).not.toMatch(/\bresolveToolCallIdStyle\b/);
  });

  it('does not keep public native wrapper exports for deleted responses tool id helpers', () => {
    const barrel = readFileSync(nativeBarrelPath, 'utf8');
    const requiredExports = readFileSync(requiredExportsPath, 'utf8');

    expect(barrel).not.toContain('normalizeResponsesToolCallIdsWithNative');
    expect(barrel).not.toContain('resolveToolCallIdStyleWithNative');
    expect(requiredExports).not.toContain('normalizeResponsesToolCallIdsJson');
    expect(requiredExports).not.toContain('resolveToolCallIdStyleJson');
  });
});
