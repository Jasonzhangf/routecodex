import { describe, expect, it, jest } from '@jest/globals';
import { runStartupProviderReprobe } from '../../../src/server/runtime/http-server/provider-startup-reprobe.js';

describe('provider startup reprobe', () => {
  it('clears persisted cooldown path by emitting provider success when checkHealth is true', async () => {
    const handleProviderSuccess = jest.fn();
    await runStartupProviderReprobe({
      server: {
        hubPipeline: {
          getVirtualRouter: () => ({ handleProviderSuccess })
        }
      },
      providerKey: 'sdfv.key1.gpt-5.4',
      runtimeKey: 'sdfv.key1.gpt-5.4',
      providerFamily: 'responses',
      instance: { checkHealth: async () => true }
    });

    const emittedKeys = handleProviderSuccess.mock.calls
      .map((args) => args[0] as { runtime?: { providerKey?: string } })
      .map((event) => event.runtime?.providerKey)
      .filter((value): value is string => typeof value === 'string')
      .sort();

    expect(emittedKeys).toEqual([
      'sdfv.1.gpt-5.4',
      'sdfv.key1.gpt-5.4'
    ]);
  });

  it('does not emit success when checkHealth is false', async () => {
    const handleProviderSuccess = jest.fn();
    await runStartupProviderReprobe({
      server: {
        hubPipeline: {
          getVirtualRouter: () => ({ handleProviderSuccess })
        }
      },
      providerKey: 'sdfv.key1.gpt-5.4',
      runtimeKey: 'sdfv.key1.gpt-5.4',
      providerFamily: 'responses',
      instance: { checkHealth: async () => false }
    });
    expect(handleProviderSuccess).not.toHaveBeenCalled();
  });
});

