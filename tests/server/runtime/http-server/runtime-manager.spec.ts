import { describe, expect, it, jest } from '@jest/globals';
import { ProviderRuntimeManager } from '../../../../src/server/runtime/http-server/runtime-manager.js';

describe('ProviderRuntimeManager runtime key resolution', () => {
  it('does not resolve an unknown provider through a fallback runtime key', async () => {
    const manager = new ProviderRuntimeManager({
      createHandle: jest.fn(async (runtimeKey: string, runtime: any) => ({
        runtimeKey,
        runtime,
        instance: { cleanup: jest.fn() },
      })),
      materializeRuntime: jest.fn(async (runtime: any) => runtime),
    });

    await manager.initialize({
      'known.key1.model': {
        runtimeKey: 'runtime:known',
        providerId: 'known',
        providerType: 'openai',
        providerFamily: 'openai',
        protocol: 'openai-responses',
      } as any,
    });

    expect(manager.resolveRuntimeKey('missing.key1.model', 'runtime:known')).toBeUndefined();
  });
});
