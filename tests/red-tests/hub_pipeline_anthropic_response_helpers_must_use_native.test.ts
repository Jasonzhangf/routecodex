import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const helperPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-helpers.ts'
);
const runtimePath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts'
);

describe('Hub Pipeline anthropic response helper Rust-only boundary', () => {
  it('physically removes legacy reasoning/tool helper shell', () => {
    expect(existsSync(helperPath)).toBe(false);
  });

  it('keeps anthropic response runtime as full native invocation glue', () => {
    const source = readFileSync(runtimePath, 'utf8');

    expect(source).toContain('buildOpenAIChatFromAnthropicMessageFullWithNative');
    expect(source).toContain('buildAnthropicResponseFromChatFullWithNative');
    expect(source).not.toContain('response-runtime-anthropic-helpers');
    expect(source).not.toContain('normalizeMessageReasoningPayloadWithNative');
    expect(source).not.toContain('resolveAnthropicToolNameWithNative');
    expect(source).not.toContain('applyReasoningPayloadToMessageWithNative');
    expect(source).not.toMatch(/function\s+isMeaninglessDotOnlyText\b/);
    expect(source).not.toMatch(/function\s+collapseReasoningSegments\b/);
    expect(source).not.toContain('normalizeAnthropicToolName');
    expect(source).not.toMatch(/new\s+Map\s*</);
    expect(source).not.toMatch(/\.map\(\(entry\)/);
    expect(source).not.toMatch(/\.filter\(\(entry\)/);
  });
});
