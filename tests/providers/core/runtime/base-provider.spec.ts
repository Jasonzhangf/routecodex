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

  it('extracts reset-after hints from Gemini CLI 429 messages', () => {
    const extractFallbackQuotaDelayFromTexts = (BaseProvider as unknown as {
      extractFallbackQuotaDelayFromTexts: (texts: string[]) => { delay: string; source: string } | null;
    }).extractFallbackQuotaDelayFromTexts;

    const extracted = extractFallbackQuotaDelayFromTexts([
      'HTTP 429: {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 30s.","status":"RESOURCE_EXHAUSTED"}}'
    ]);
    expect(extracted).not.toBeNull();
    expect(extracted!.delay).toBe('30s');
    expect(extracted!.source).toBe('rate_limit_reset_fallback');
  });
});
