import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('deepseek search model aliases in virtual router bootstrap', () => {
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
            'deepseek-chat': {},
            'deepseek-reasoner': {}
          }
        }
      },
      routing: {
        default: ['deepseek-web.deepseek-chat-search']
      }
    }
  };

  it('accepts deepseek-chat-search in routing/default without explicit model declaration', () => {
    const result = bootstrapVirtualRouterConfig(input);
    const providerKeys = Object.keys(result.providers);
    expect(providerKeys.some((key) => key.endsWith('.deepseek-chat-search'))).toBe(true);
  });

  it('routes direct provider.model request to deepseek-chat-search alias', async () => {
    const result = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(result.config);

    const routed = await engine.route(
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
    );

    expect(routed.target?.providerKey).toMatch(/deepseek-web/);
    expect(routed.target?.modelId).toBe('deepseek-chat-search');
  });
});
