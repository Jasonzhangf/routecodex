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
const hostNativeExportsPath = join(
  process.cwd(),
  'src/modules/llmswitch/bridge/native-exports.ts'
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
    const hostNativeExports = readFileSync(hostNativeExportsPath, 'utf8');

    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(bridgePath)).toBe(false);
    expect(existsSync(nativeBarrelPath)).toBe(false);
    expect(hostNativeExports).toContain('buildChatResponseFromResponsesNative');
    expect(hostNativeExports).not.toContain('collectToolCallsFromResponsesWithNative');
    expect(hostNativeExports).not.toContain('resolveFinishReasonWithNative');
  });

  it('does not keep public native wrapper exports for deleted response helpers', () => {
    const requiredExports = readFileSync(requiredExportsPath, 'utf8');

    expect(existsSync(nativeBarrelPath)).toBe(false);
    expect(requiredExports).not.toContain('collectToolCallsFromResponsesJson');
    expect(requiredExports).not.toContain('resolveFinishReasonJson');
  });

  it('does not keep coverage consumers for deleted wrapper exports', () => {
    expect(existsSync(coverageScriptPath)).toBe(false);
  });

  it('does not keep coverage-only responses tool utils wrapper exports', () => {
    const requiredExports = readFileSync(requiredExportsPath, 'utf8');

    expect(existsSync(responsesToolUtilsPath)).toBe(false);
    expect(existsSync(responsesToolUtilsCoverageScriptPath)).toBe(false);
    expect(existsSync(bridgePath)).toBe(false);
    expect(requiredExports).not.toContain('normalizeResponsesToolCallIdsWithNative');
    expect(requiredExports).not.toContain('resolveToolCallIdStyleWithNative');
  });

  it('does not keep public native wrapper exports for deleted responses tool id helpers', () => {
    const requiredExports = readFileSync(requiredExportsPath, 'utf8');

    expect(existsSync(nativeBarrelPath)).toBe(false);
    expect(requiredExports).not.toContain('normalizeResponsesToolCallIdsJson');
    expect(requiredExports).not.toContain('resolveToolCallIdStyleJson');
  });
});
