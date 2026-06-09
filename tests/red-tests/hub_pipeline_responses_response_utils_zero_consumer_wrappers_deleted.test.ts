import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
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

describe('Hub Pipeline responses response utils Rust-only boundary', () => {
  it('does not keep zero-consumer tool-call and finish-reason TS wrappers', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('buildChatResponseFromResponsesFullWithNative');
    expect(source).not.toContain('collectToolCallsFromResponsesWithNative');
    expect(source).not.toContain('resolveFinishReasonWithNative');
    expect(source).not.toMatch(/export\s+function\s+collectToolCallsFromResponses\b/);
    expect(source).not.toMatch(/export\s+function\s+resolveFinishReason\b/);
  });

  it('does not keep coverage consumers for deleted wrapper exports', () => {
    const source = readFileSync(coverageScriptPath, 'utf8');

    expect(source).not.toMatch(/\bcollectToolCallsFromResponses\b/);
    expect(source).not.toMatch(/\bresolveFinishReason\b/);
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
});
