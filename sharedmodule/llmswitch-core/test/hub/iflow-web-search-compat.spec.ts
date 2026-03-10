import { runRequestCompatPipeline } from '../../src/conversion/hub/pipeline/compat/compat-pipeline-executor.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';

describe('IFlow web_search compat', () => {
  test('transforms top-level web_search helper into function tool', () => {
    const payload = {
      model: 'iFlow-ROME-30BA3B',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '帮我联网搜索一下今天的新闻。' }
      ],
      web_search: {
        query: 'today international news',
        recency: 'day',
        count: 10,
        engine: 'iFlow-ROME-30BA3B'
      }
    } as any;

    const ctx: AdapterContext = {
      requestId: 'req_iflow_web_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'web_search-primary'
    };

    const result = runRequestCompatPipeline('chat:iflow', payload, {
      adapterContext: ctx
    });

    const transformed = result.payload as any;

    expect(transformed.web_search).toBeUndefined();

    const tools = transformed.tools || [];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(1);

    const tool = tools[0];
    expect(tool.type).toBe('function');
    expect(tool.function?.name).toBe('web_search');

    const params = tool.function?.parameters;
    expect(params?.type).toBe('object');
    expect(params?.properties?.query?.type).toBe('string');
    expect(params?.properties?.recency?.type).toBe('string');
    expect(params?.properties?.count?.type).toBe('integer');
    expect(Array.isArray(params?.required)).toBe(true);
    expect(params.required).toContain('query');
  });

  test('drops helper when query is missing', () => {
    const payload = {
      model: 'iFlow-ROME-30BA3B',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '测试空查询行为。' }
      ],
      web_search: {
        query: '',
        recency: 'day',
        count: 10,
        engine: 'iFlow-ROME-30BA3B'
      }
    } as any;

    const ctx: AdapterContext = {
      requestId: 'req_iflow_web_2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'web_search-secondary'
    };

    const result = runRequestCompatPipeline('chat:iflow', payload, {
      adapterContext: ctx
    });

    const transformed = result.payload as any;
    expect(transformed.web_search).toBeUndefined();
    expect(transformed.tools).toBeUndefined();
  });
});

