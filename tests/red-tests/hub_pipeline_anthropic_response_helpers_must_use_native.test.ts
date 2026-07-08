import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
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

  it('physically removes anthropic response runtime TS invocation glue', () => {
    expect(existsSync(runtimePath)).toBe(false);
  });
});
