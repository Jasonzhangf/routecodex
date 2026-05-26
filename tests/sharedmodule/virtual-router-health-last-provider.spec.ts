import { describe, expect, it, jest } from '@jest/globals';
import { ProviderHealthManager } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.js';
import { handleProviderFailureImpl } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/health/index.js';

describe('virtual router health last-provider guard', () => {
  it('does not cooldown the last remaining available provider', () => {
    const healthManager = new ProviderHealthManager();
    healthManager.configure({
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    });
    healthManager.registerProviders(['provider.a']);
    const markProviderCooldown = jest.fn<(providerKey: string, cooldownMs: number | undefined) => void>();

    handleProviderFailureImpl(
      {
        providerKey: 'provider.a',
        reason: 'upstream_error',
        fatal: false,
        statusCode: 502,
        affectsHealth: true,
        cooldownOverrideMs: 30_000
      },
      healthManager,
      healthManager.getConfig(),
      markProviderCooldown
    );

    expect(healthManager.isAvailable('provider.a')).toBe(true);
    expect(markProviderCooldown).not.toHaveBeenCalled();
  });

  it('does not trip the last remaining available provider even on fatal events', () => {
    const healthManager = new ProviderHealthManager();
    healthManager.configure({
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    });
    healthManager.registerProviders(['provider.a', 'provider.b']);
    healthManager.cooldownProvider('provider.b', 'rate_limit', 60_000);
    const markProviderCooldown = jest.fn<(providerKey: string, cooldownMs: number | undefined) => void>();

    handleProviderFailureImpl(
      {
        providerKey: 'provider.a',
        reason: 'client_error',
        fatal: true,
        statusCode: 400,
        affectsHealth: true,
        cooldownOverrideMs: 120_000
      },
      healthManager,
      healthManager.getConfig(),
      markProviderCooldown
    );

    expect(healthManager.isAvailable('provider.a')).toBe(true);
    expect(healthManager.isAvailable('provider.b')).toBe(false);
    expect(markProviderCooldown).not.toHaveBeenCalled();
  });

  it('still cools down a provider when alternatives remain available', () => {
    const healthManager = new ProviderHealthManager();
    healthManager.configure({
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    });
    healthManager.registerProviders(['provider.a', 'provider.b']);
    const markProviderCooldown = jest.fn<(providerKey: string, cooldownMs: number | undefined) => void>();

    handleProviderFailureImpl(
      {
        providerKey: 'provider.a',
        reason: 'rate_limit',
        fatal: false,
        statusCode: 429,
        affectsHealth: true,
        cooldownOverrideMs: 5_000
      },
      healthManager,
      healthManager.getConfig(),
      markProviderCooldown
    );

    expect(healthManager.isAvailable('provider.a')).toBe(false);
    expect(healthManager.isAvailable('provider.b')).toBe(true);
    expect(markProviderCooldown).toHaveBeenCalledWith('provider.a', 5_000);
  });
});
