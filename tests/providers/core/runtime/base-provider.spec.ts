import { describe, expect, it } from '@jest/globals';
import { BaseProvider } from '../../../../src/providers/core/runtime/base-provider.js';

describe('BaseProvider quota reset parsing', () => {
  it('parses millisecond quotaResetDelay values correctly', () => {
    const parseDurationToMs = (BaseProvider as unknown as { parseDurationToMs: (value: string) => number | null })
      .parseDurationToMs;

    const msOnly = parseDurationToMs('983.50885ms');
    expect(msOnly).not.toBeNull();
    expect(msOnly).toBeGreaterThan(0);
    expect(msOnly).toBeCloseTo(984, 0);

    const mixedUnits = parseDurationToMs('1s250ms');
    expect(mixedUnits).not.toBeNull();
    expect(mixedUnits).toBeCloseTo(1250, 0);
  });
});
