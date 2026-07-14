import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';

import { DebugUtilsStatic } from '../../src/utils/debug-utils.js';

describe('debug.unified_surface legacy DebugUtils deepClone removal', () => {
  it('keeps sanitizer behavior for logger callers', () => {
    expect(DebugUtilsStatic.sanitizeData({
      token: 'secret-token',
      nested: {
        ok: true
      }
    })).toEqual({
      token: '[REDACTED]',
      nested: {
        ok: true
      }
    });
  });

  it('does not expose the legacy deepClone API or clone implementation', () => {
    const source = fs.readFileSync('src/utils/debug-utils.ts', 'utf8');
    const types = fs.readFileSync('src/types/debug-types.ts', 'utf8');

    expect(source).not.toMatch(/\bdeepClone\s*</);
    expect(source).not.toMatch(/\bdeepClone\s*\(/);
    expect(source).not.toMatch(/structuredClone\s*\(/);
    expect(source).not.toMatch(/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/);
    expect(types).not.toMatch(/\bdeepClone\s*</);
    expect(types).not.toMatch(/\bdeepClone\s*\(/);
    expect(typeof (DebugUtilsStatic as unknown as { deepClone?: unknown }).deepClone).toBe('undefined');
  });
});
