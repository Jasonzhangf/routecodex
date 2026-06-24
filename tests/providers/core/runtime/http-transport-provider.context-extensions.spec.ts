import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot: async () => {}
}), { virtual: true });

import { HttpTransportProvider } from '../../../../src/providers/core/runtime/http-transport-provider.ts';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.ts';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('HttpTransportProvider context extensions', () => {
  it('injects provider config extensions into request executor context when runtime metadata has none', async () => {
    const provider = new HttpTransportProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        providerId: 'XLC',
        baseUrl: 'https://xlapis.com/v1',
        model: 'deepseek-v4-pro',
        auth: { type: 'apikey', apiKey: 'testapikey12345' },
        extensions: {
          errorMapping: {
            rules: [
              {
                origin: {
                  status: 400,
                  error: {
                    type: 'server_error',
                    messageContains: 'All available accounts exhausted'
                  }
                },
                to: {
                  status: 429,
                  code: 'HTTP_429',
                  message: 'All available accounts exhausted'
                }
              }
            ]
          }
        },
        overrides: { maxRetries: 0 }
      }
    } as any, deps, 'openai-standard');

    await provider.initialize();

    const request: any = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '只回复 OK' }],
      stream: true
    };
    attachProviderRuntimeMetadata(request, {
      requestId: 'req_xlc_context_extensions',
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      providerId: 'XLC',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      metadata: { stream: true, entryEndpoint: '/v1/responses' },
      target: {
        providerKey: 'XLC.key2.deepseek-v4-pro',
        providerType: 'openai',
        runtimeKey: 'XLC.key2',
        modelId: 'deepseek-v4-pro'
      }
    });

    await (provider as any).preprocessRequest(request);
    const context = (provider as any).createProviderContext();

    expect(context.runtimeMetadata?.extensions).toBeUndefined();
    expect(context.extensions?.errorMapping).toEqual({
      rules: [
        {
          origin: {
            status: 400,
            error: {
              type: 'server_error',
              messageContains: 'All available accounts exhausted'
            }
          },
          to: {
            status: 429,
            code: 'HTTP_429',
            message: 'All available accounts exhausted'
          }
        }
      ]
    });
  });
});
