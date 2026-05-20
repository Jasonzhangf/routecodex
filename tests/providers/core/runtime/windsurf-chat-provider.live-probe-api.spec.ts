import { describe, expect, jest, test } from '@jest/globals';
import { WindsurfChatProvider } from '../../../../src/providers/core/runtime/windsurf-chat-provider.ts';
import { WindsurfCloudClient } from '../../../../src/providers/core/runtime/windsurf-cloud-client.ts';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('WindsurfChatProvider cloud probe api', () => {
  test('fetchCloudUserStatus delegates to cloud client with status probes', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: '',
        model: 'gpt-5.5-medium',
        auth: { type: 'apikey', apiKey: 'session-token-1234567890', rawType: 'windsurf-account' },
        extensions: {
          transportBackend: 'cascade-cloud',
          apiBaseUrl: 'https://server.self-serve.windsurf.com',
          apiBaseUrlFallback: 'https://server.codeium.com'
        }
      }
    } as any, deps);

    const spy = jest.spyOn(WindsurfCloudClient.prototype, 'getUserStatus').mockResolvedValue({ ok: true });
    try {
      await expect(provider.fetchCloudUserStatus()).resolves.toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith([
        expect.objectContaining({ path: '/exa.seat_management_pb.SeatManagementService/GetUserStatus' }),
        expect.objectContaining({ path: '/exa.seat_management_pb.SeatManagementService/GetUserStatus' }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('fetchCloudModelConfigs delegates to cloud client with model probes', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: '',
        model: 'gpt-5.5-medium',
        auth: { type: 'apikey', apiKey: 'session-token-1234567890', rawType: 'windsurf-account' },
        extensions: {
          transportBackend: 'cascade-cloud',
          apiBaseUrl: 'https://server.self-serve.windsurf.com',
          apiBaseUrlFallback: 'https://server.codeium.com'
        }
      }
    } as any, deps);

    const spy = jest.spyOn(WindsurfCloudClient.prototype, 'getCascadeModelConfigs').mockResolvedValue({ configs: [] });
    try {
      await expect(provider.fetchCloudModelConfigs()).resolves.toEqual({ configs: [] });
      expect(spy).toHaveBeenCalledWith([
        expect.objectContaining({ path: '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs' }),
        expect.objectContaining({ path: '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs' }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
