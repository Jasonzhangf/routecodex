import { applyDeepSeekWebRequestTransform } from '../deepseek-web-request.js';

describe('deepseek-web-request action wrapper', () => {
  test('injects tool text guidance when toolProtocol=text', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          toolProtocol: 'text'
        }
      } as any
    );

    expect((result as any).prompt).toContain('Tool-call output contract (STRICT)');
    expect((result as any).prompt).toContain('"tool_calls"');
  });

  test('enables search for routeId/web_search triggers', () => {
    const withRoute = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'find news' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'web_search-primary'
      } as any
    );

    const withPayloadSearch = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'find docs' }],
        web_search: { enabled: true }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    expect((withRoute as any).search_enabled).toBe(true);
    expect((withPayloadSearch as any).search_enabled).toBe(true);
  });

  test('maps model families to thinking/search flags through native compat', () => {
    const reasoner = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-r1-search',
        messages: [{ role: 'user', content: 'think and search' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    const chat = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'plain chat' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    expect((reasoner as any).thinking_enabled).toBe(true);
    expect((reasoner as any).search_enabled).toBe(true);
    expect((chat as any).thinking_enabled).toBe(false);
    expect((chat as any).search_enabled).toBe(false);
  });

  test('preserves metadata.deepseek passthrough fields while adding native defaults', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          requestLabel: 'keep',
          deepseek: {
            customFlag: 'keep-me'
          }
        }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          toolProtocol: 'text'
        }
      } as any
    );

    expect((result as any).metadata.requestLabel).toBe('keep');
    expect((result as any).metadata.deepseek).toMatchObject({
      strictToolRequired: true,
      textToolFallback: true,
      customFlag: 'keep-me'
    });
  });
});
