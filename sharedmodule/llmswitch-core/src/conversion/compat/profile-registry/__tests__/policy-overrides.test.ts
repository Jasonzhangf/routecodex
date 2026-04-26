import { describe, expect, test } from '@jest/globals';
import { shouldSkipPolicy } from '../policy-overrides.js';
import type { PolicyOverrideConfig } from '../types.js';

describe('shouldSkipPolicy', () => {
  test('returns false when overrides is undefined', () => {
    expect(shouldSkipPolicy(undefined, 'observe')).toBe(false);
    expect(shouldSkipPolicy(undefined, 'enforce')).toBe(false);
  });

  test('returns false when phase override is absent', () => {
    expect(shouldSkipPolicy({}, 'observe')).toBe(false);
    expect(shouldSkipPolicy({}, 'enforce')).toBe(false);
  });

  test('returns false when skip is false', () => {
    const overrides: PolicyOverrideConfig = { observe: { skip: false } };
    expect(shouldSkipPolicy(overrides, 'observe')).toBe(false);
  });

  test('returns true when skip is true for the specified phase', () => {
    const overrides: PolicyOverrideConfig = { observe: { skip: true } };
    expect(shouldSkipPolicy(overrides, 'observe')).toBe(true);
    expect(shouldSkipPolicy(overrides, 'enforce')).toBe(false);
  });

  test('supports both observe and enforce overrides independently', () => {
    const overrides: PolicyOverrideConfig = {
      observe: { skip: true },
      enforce: { skip: false }
    };
    expect(shouldSkipPolicy(overrides, 'observe')).toBe(true);
    expect(shouldSkipPolicy(overrides, 'enforce')).toBe(false);
  });

  test('mirrors hardcoded deepseek-web skip behavior', () => {
    // This mirrors: if (compatibilityProfile === 'chat:deepseek-web') return;
    const overrides: PolicyOverrideConfig = { observe: { skip: true }, enforce: { skip: true } };
    expect(shouldSkipPolicy(overrides, 'observe')).toBe(true);
    expect(shouldSkipPolicy(overrides, 'enforce')).toBe(true);
  });
});
