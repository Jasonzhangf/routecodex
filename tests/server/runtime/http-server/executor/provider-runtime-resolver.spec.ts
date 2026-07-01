import { describe, expect, it, jest } from '@jest/globals';
import type { ProviderHandle } from '../../../../../src/server/runtime/http-server/types.js';
import { resolveProviderRuntimeOrThrow } from '../../../../../src/server/runtime/http-server/executor/provider-runtime-resolver.js';

describe('resolveProviderRuntimeOrThrow', () => {
  it('does not probe raw or normalized provider keys after the selected runtime key has no handle', async () => {
    const handle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'provider',
      providerProtocol: 'openai-responses',
      instance: { processIncoming: jest.fn(), cleanup: jest.fn() },
    } as unknown as ProviderHandle;

    const getHandleByRuntimeKey = jest.fn((runtimeKey?: string) => (
      runtimeKey === 'provider.key1.model' ? handle : undefined
    ));

    await expect(resolveProviderRuntimeOrThrow({
      requestId: 'req_runtime_key_no_probe',
      target: {
        providerKey: 'provider.key1.model',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
      },
      runtimeKeyHint: 'runtime:missing',
      runtimeManager: {
        resolveRuntimeKey: jest.fn(() => 'runtime:missing'),
        getHandleByRuntimeKey,
      },
      dependencies: {} as any,
      metadata: {},
    })).rejects.toMatchObject({
      code: 'ERR_PROVIDER_NOT_FOUND',
      requestId: 'req_runtime_key_no_probe',
    });

    expect(getHandleByRuntimeKey).toHaveBeenCalledTimes(1);
    expect(getHandleByRuntimeKey).toHaveBeenCalledWith('runtime:missing', {});
  });
});
