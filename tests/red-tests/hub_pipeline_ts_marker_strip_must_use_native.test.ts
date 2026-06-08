import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();

describe('Hub Pipeline TS marker strip boundary', () => {
  it('keeps legacy chat-process generic marker strip wrapper physically removed', () => {
    const wrapperPath = resolve(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-generic-marker-strip.ts',
    );

    expect(existsSync(wrapperPath)).toBe(false);
  });
});
