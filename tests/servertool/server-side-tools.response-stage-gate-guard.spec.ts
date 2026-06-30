import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('server-side-tools response-stage gate guard', () => {
  test('deleted server-side-tools facade cannot restore response-stage gate semantics', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts')).toBe(false);
  });
});
