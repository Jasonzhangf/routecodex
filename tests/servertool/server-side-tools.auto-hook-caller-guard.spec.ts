import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('server-side-tools auto-hook caller guard', () => {
  test('deleted server-side-tools facade cannot restore inline auto-hook orchestration', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts')).toBe(false);
  });
});
