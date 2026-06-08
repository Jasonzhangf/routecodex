import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function createMetadata(requestId: string) {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    providerProtocol: 'openai-responses'
  } as any;
}

describe('virtual-router web_search route selection', () => {
  function buildEngine() {
    const input: any = {
      virtualrouter: {
        providers: {
          demo: {
            id: 'demo',
            type: 'openai',
            enabled: true,
            endpoint: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'thinking-1': {},
              'tools-1': {},
              'search-1': { capabilities: ['web_search'] }
            }
          }
        },
        routing: {
          thinking: [{ id: 'thinking-primary', priority: 300, targets: ['demo.thinking-1'] }],
          tools: [{ id: 'tools-primary', priority: 200, targets: ['demo.tools-1'] }],
          web_search: [{ id: 'web-search-primary', priority: 100, targets: ['demo.search-1'] }],
          default: [{ id: 'default-primary', priority: 50, targets: ['demo.thinking-1'] }]
        }
      }
    };

    const { config } = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);
    return engine;
  }

  it('keeps first-turn web_search tool declaration on thinking route', async () => {
    const engine = buildEngine();

    const result = await engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '帮我查一下今天的新闻。' }],
        tools: [{ type: 'web_search_preview' }]
      } as any,
      createMetadata('req_web_search_declared_first_turn')
    );

    expect(result.decision.routeName).toBe('thinking');
    expect(result.target?.providerKey).toBe('demo.key1.thinking-1');
  });

  it('keeps normal tool continuation on tools route even when web_search tool is declared', async () => {
    const engine = buildEngine();

    const result = await engine.route(
      {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: '继续执行' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_continue_1',
                type: 'function',
                function: {
                  name: 'continue_execution',
                  arguments: '{}'
                }
              }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web'
            }
          }
        ]
      } as any,
      createMetadata('req_continue_execution_with_web_search_declared')
    );

    expect(result.decision.routeName).toBe('tools');
    expect(result.target?.providerKey).toBe('demo.key1.tools-1');
  });

  it('keeps previous web_search continuation on web_search route', async () => {
    const engine = buildEngine();

    const result = await engine.route(
      {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: '继续' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_web_search_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'today news' })
                }
              }
            ]
          }
        ]
      } as any,
      createMetadata('req_real_web_search_continuation')
    );

    expect(result.decision.routeName).toBe('web_search');
    expect(result.target?.providerKey).toBe('demo.key1.search-1');
  });
});
