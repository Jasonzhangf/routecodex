import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourcePath = join(
  process.cwd(),
  'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts'
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
});
