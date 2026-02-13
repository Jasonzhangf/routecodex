import { describe, expect, it } from '@jest/globals';

import {
  DEEPSEEK_COMPATIBILITY_PROFILE,
  isDeepSeekRuntimeIdentity,
  normalizeDeepSeekProviderRuntimeOptions,
  readDeepSeekProviderRuntimeOptions
} from '../../src/providers/core/contracts/deepseek-provider-contract.js';

describe('deepseek-provider-contract', () => {
  it('normalizes deepseek runtime options with defaults and bounds', () => {
    const normalized = normalizeDeepSeekProviderRuntimeOptions({
      strictToolRequired: 'false',
      textToolFallback: true,
      powTimeoutMs: '999999',
      powMaxAttempts: 0,
      sessionReuseTtlMs: 999
    });

    expect(normalized.strictToolRequired).toBe(false);
    expect(normalized.textToolFallback).toBe(true);
    expect(normalized.powTimeoutMs).toBe(120000);
    expect(normalized.powMaxAttempts).toBe(1);
    expect(normalized.sessionReuseTtlMs).toBe(1000);
  });

  it('detects deepseek runtime identity by family, key, and compat profile', () => {
    expect(isDeepSeekRuntimeIdentity({ providerFamily: 'deepseek' })).toBe(true);
    expect(isDeepSeekRuntimeIdentity({ providerKey: 'deepseek.web.default' })).toBe(true);
    expect(isDeepSeekRuntimeIdentity({ compatibilityProfile: DEEPSEEK_COMPATIBILITY_PROFILE })).toBe(true);
    expect(isDeepSeekRuntimeIdentity({ providerFamily: 'openai', providerId: 'glm' })).toBe(false);
  });

  it('reads deepseek options from runtime/extension/metadata layers', () => {
    const fromRuntime = readDeepSeekProviderRuntimeOptions({
      runtimeOptions: { strictToolRequired: false }
    });
    const fromExtension = readDeepSeekProviderRuntimeOptions({
      extensions: { deepseek: { textToolFallback: false } }
    });
    const fromMetadata = readDeepSeekProviderRuntimeOptions({
      metadata: { deepseek: { powTimeoutMs: 5000 } }
    });

    expect(fromRuntime?.strictToolRequired).toBe(false);
    expect(fromExtension?.textToolFallback).toBe(false);
    expect(fromMetadata?.powTimeoutMs).toBe(5000);
  });
});
