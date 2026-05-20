import { WindsurfChatProvider } from '../../../../src/providers/core/runtime/windsurf-chat-provider.ts';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('WindsurfChatProvider', () => {
  test('grpc mode preprocessRequest converts tools to tools_preamble and removes tools field', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-high',
        auth: { type: 'apikey', apiKey: 'test-key' },
        extensions: {
          transportBackend: 'grpc',
          lsPort: 42100,
          csrfToken: 'csrf-token'
        }
      }
    } as any, deps);

    const request: any = {
      body: {
        model: 'gpt-5.4-high',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ]
      }
    };

    const processed = await (provider as any).preprocessRequest(request);
    expect(processed.body.tools).toBeUndefined();
    expect(processed.body.tools_preamble).toContain('[Available tools]');
    expect(processed.body.tools_preamble).toContain('exec_command');
    expect(processed.body.tools_preamble).toContain('run shell');
  });

  test('grpc mode maps gpt-5.4-high to the dedicated enum', () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-high',
        auth: { type: 'apikey', apiKey: 'test-key' },
        extensions: {
          transportBackend: 'grpc',
          lsPort: 42100,
          csrfToken: 'csrf-token'
        }
      }
    } as any, deps);

    expect((provider as any).resolveModelEnum('gpt-5.4-high')).toBe(391);
  });
});
