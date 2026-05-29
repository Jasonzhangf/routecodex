import { describe, expect, it, jest } from '@jest/globals';
import { runStartupProviderReprobe } from '../../../src/server/runtime/http-server/provider-startup-reprobe.js';

describe('Windsurf runtime startup probe', () => {
  it('RED: runs Windsurf startup health probe asynchronously without blocking runtime readiness', async () => {
    const checkHealth = jest.fn(async () => await new Promise<boolean>(() => {}));
    const startedAt = Date.now();

    await expect(runStartupProviderReprobe({
      server: { hubPipeline: { getVirtualRouter: () => null } },
      providerKey: 'windsurf.managed.gpt-5.5-low',
      runtimeKey: 'windsurf.managed.gpt-5.5-low',
      providerFamily: 'windsurf',
      instance: { checkHealth },
    })).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(checkHealth).toHaveBeenCalledTimes(1);
  });

  it('keeps non-windsurf startup reprobe synchronous for existing health semantics', async () => {
    const handleProviderSuccess = jest.fn();
    await expect(runStartupProviderReprobe({
      server: { hubPipeline: { getVirtualRouter: () => ({ handleProviderSuccess }) } },
      providerKey: 'openai.key1.gpt-5.4',
      runtimeKey: 'openai.key1.gpt-5.4',
      providerFamily: 'openai',
      instance: { checkHealth: async () => true },
    })).resolves.toBeUndefined();

    expect(handleProviderSuccess).toHaveBeenCalled();
  });
});
