import { describe, expect, it } from '@jest/globals';

import { toExactMatchClockConfig } from '../../../src/server/runtime/http-server/clock-daemon-inject-config.js';

describe('clock-daemon-inject-config', () => {
  it('forces dueWindowMs to zero for object config', () => {
    const input = {
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 60000,
      tickMs: 1500
    };

    const output = toExactMatchClockConfig(input) as Record<string, unknown>;

    expect(output).toEqual({
      enabled: true,
      retentionMs: 120000,
      dueWindowMs: 0,
      tickMs: 1500
    });
    expect(input.dueWindowMs).toBe(60000);
  });

  it('returns non-object input unchanged', () => {
    expect(toExactMatchClockConfig(null)).toBeNull();
    expect(toExactMatchClockConfig(undefined)).toBeUndefined();
    expect(toExactMatchClockConfig('clock')).toBe('clock');
    expect(toExactMatchClockConfig(123)).toBe(123);
  });
});
