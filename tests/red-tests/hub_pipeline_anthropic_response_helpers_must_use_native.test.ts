import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const helperPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-helpers.ts'
);

describe('Hub Pipeline anthropic response helper Rust-only boundary', () => {
  it('does not keep reasoning/tool normalization semantics in TS', () => {
    const source = readFileSync(helperPath, 'utf8');

    expect(source).toContain('WithNative');
    expect(source).not.toMatch(/function\s+isMeaninglessDotOnlyText\b/);
    expect(source).not.toMatch(/function\s+collapseReasoningSegments\b/);
    expect(source).toMatch(/normalizeMessageReasoningPayloadWithNative/);
    expect(source).toMatch(/resolveAnthropicToolNameWithNative/);
    expect(source).toMatch(/applyReasoningPayloadToMessageWithNative/);
    expect(source).not.toContain('normalizeAnthropicToolName');
    expect(source).not.toMatch(/new\s+Map\s*</);
    expect(source).not.toMatch(/\.map\(\(entry\)/);
    expect(source).not.toMatch(/\.filter\(\(entry\)/);
  });
});
