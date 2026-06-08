import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const deletedPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-parser.ts'
);
const textMarkupPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.ts'
);

describe('Hub Pipeline reasoning tool parser helper shell deletion', () => {
  it('keeps the zero-consumer TS parser shell physically deleted', () => {
    expect(existsSync(deletedPath)).toBe(false);
  });

  it('keeps reasoning tool extraction available through the native text markup owner', () => {
    const source = readFileSync(textMarkupPath, 'utf8');

    expect(source).toContain('extractToolCallsFromReasoningTextWithNative');
    expect(source).not.toContain("from './reasoning-tool-parser");
    expect(source).not.toContain('function extractToolCallsFromReasoningText');
  });
});
