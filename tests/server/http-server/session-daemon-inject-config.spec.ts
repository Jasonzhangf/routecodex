import { describe, expect, it } from '@jest/globals';

import { toExactMatchSessionConfig } from '../../../src/server/runtime/http-server/session-daemon-inject-config.js';

describe('session-daemon-inject-config', () => {
  it('forces dueWindowMs to zero for object config', () => {
    const input = {
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 60000,
      tickMs: 1500
    };

    const output = toExactMatchSessionConfig(input) as Record<string, unknown>;

    expect(output).toEqual({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 0,
      tickMs: 1500
    });
    expect(input.dueWindowMs).toBe(60000);
  });

  it('returns non-object input unchanged', () => {
    expect(toExactMatchSessionConfig(null)).toBeNull();
    expect(toExactMatchSessionConfig(undefined)).toBeUndefined();
    expect(toExactMatchSessionConfig('clock')).toBe('clock');
    expect(toExactMatchSessionConfig(123)).toBe(123);
  });
});
