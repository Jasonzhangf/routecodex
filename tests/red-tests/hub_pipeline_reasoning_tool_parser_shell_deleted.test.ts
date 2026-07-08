import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
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
const textMarkupNormalizePath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer/normalize.ts'
);

describe('Hub Pipeline reasoning tool parser helper shell deletion', () => {
  it('keeps the zero-consumer TS parser shell physically deleted', () => {
    expect(existsSync(deletedPath)).toBe(false);
  });

  it('keeps the retired text markup normalizer barrel physically deleted', () => {
    expect(existsSync(textMarkupPath)).toBe(false);
    expect(existsSync(textMarkupNormalizePath)).toBe(false);
  });
});
