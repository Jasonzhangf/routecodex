import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

describe('deepseek model aliases stay display-only in virtual router bootstrap', () => {
  const input: any = {
    virtualrouter: {
      providers: {
        'deepseek-web': {
          id: 'deepseek-web',
          enabled: true,
          type: 'openai',
          endpoint: 'https://chat.deepseek.com',
          compatibilityProfile: 'chat:deepseek-web',
          auth: { type: 'apikey', apiKey: 'TEST_KEY' },
          models: {
            'deepseek-chat': {
              aliases: ['deepseek-chat-search']
            },
            'deepseek-reasoner': {}
          }
        }
      },
      routing: {
        default: ['deepseek-web.deepseek-chat']
      }
    }
  };

  it('does not register model aliases as routable provider keys', () => {
    const result = bootstrapVirtualRouterConfig(input);
    const providerKeys = Object.keys(result.providers);
    expect(providerKeys.some((key) => key.endsWith('.deepseek-chat'))).toBe(true);
    expect(providerKeys.some((key) => key.endsWith('.deepseek-chat-search'))).toBe(false);
  });

  it('rejects direct provider.model alias input instead of resolving it to canonical', async () => {
    const result = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(result.config);

    expect(() => engine.route(
      {
        model: 'deepseek-web.deepseek-chat-search',
        messages: [{ role: 'user', content: 'Search latest updates' }]
      },
      {
        requestId: 'req-deepseek-search-alias',
        entryEndpoint: '/v1/chat/completions',
        processMode: 'chat',
        stream: false,
        direction: 'request',
        providerProtocol: 'openai-chat'
      }
    )).toThrow(/Unknown model deepseek-chat-search for provider deepseek-web/);
  });

  it('requires canonical model ids in routed targets and inbound direct model input', async () => {
    const v4Input: any = {
      virtualrouter: {
        providers: {
          'deepseek-web': {
            id: 'deepseek-web',
            enabled: true,
            type: 'openai',
            endpoint: 'https://chat.deepseek.com',
            compatibilityProfile: 'chat:deepseek-web',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'DeepSeek-V4-Flash': {
                capabilities: ['web_search', 'multimodal'],
                aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-search', 'deepseek-v4-vision']
              },
              'DeepSeek-V4-Pro': {
                capabilities: ['web_search', 'multimodal'],
                aliases: ['deepseek-v4-pro', 'deepseek-v4-pro-search']
              }
            }
          }
        },
        routing: {
          web_search: ['deepseek-web.DeepSeek-V4-Flash']
        }
      }
    };

    const result = bootstrapVirtualRouterConfig(v4Input);
    const providerKeys = Object.keys(result.providers);
    expect(providerKeys.some((key) => key.endsWith('.DeepSeek-V4-Flash'))).toBe(true);
    expect(providerKeys.some((key) => key.endsWith('.deepseek-v4-flash-search'))).toBe(false);

    const engine = new VirtualRouterEngine();
    engine.initialize(result.config);

    const routed = await engine.route(
      {
        model: 'deepseek-web.DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'Search latest updates' }]
      },
      {
        requestId: 'req-deepseek-v4-pro-alias',
        entryEndpoint: '/v1/chat/completions',
        processMode: 'chat',
        stream: false,
        direction: 'request',
        providerProtocol: 'openai-chat'
      }
    );

    expect(routed.target?.providerKey).toMatch(/deepseek-web/);
    expect(routed.target?.modelId).toBe('DeepSeek-V4-Pro');

    expect(() => engine.route(
      {
        model: 'deepseek-web.deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Search latest updates' }]
      },
      {
        requestId: 'req-deepseek-v4-pro-alias',
        entryEndpoint: '/v1/chat/completions',
        processMode: 'chat',
        stream: false,
        direction: 'request',
        providerProtocol: 'openai-chat'
      }
    )).toThrow(/Unknown model deepseek-v4-pro for provider deepseek-web/);
  });
});
