import { GeminiCLIProtocolClient } from '../../../src/client/gemini-cli/gemini-cli-protocol-client.js';

describe('GeminiCLIProtocolClient', () => {
  test('does not put action/metadata under request', () => {
    const client = new GeminiCLIProtocolClient();
    const body = client.buildRequestBody({
      model: 'gemini-3-pro-high',
      project: 'proj',
      action: 'streamGenerateContent',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      metadata: {
        __rcc_stream: true,
        clientHeaders: { accept: 'application/json' },
      },
      requestId: 'req-test',
      userAgent: 'routecodex',
      requestType: 'agent',
    } as any);

    expect(body).toHaveProperty('model', 'gemini-3-pro-high');
    expect(body).toHaveProperty('project', 'proj');
    expect(body).toHaveProperty('requestId', 'req-test');
    expect(body).toHaveProperty('userAgent', 'routecodex');
    expect(body).toHaveProperty('requestType', 'agent');

    expect(body).toHaveProperty('request');
    expect((body as any).request).toHaveProperty('contents');
    expect((body as any).request).not.toHaveProperty('action');
    expect((body as any).request).not.toHaveProperty('metadata');
  });

  test('preserves tools/toolConfig under request and drops stream/web_search', () => {
    const client = new GeminiCLIProtocolClient();

    const body = client.buildRequestBody({
      model: 'gemini-3-pro-high',
      project: 'proj',
      action: 'generateContent',
      stream: true,
      web_search: { enabled: true },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'clock',
              description: 'get time',
              parameters: {
                type: 'OBJECT',
                properties: { action: { type: 'STRING' } },
                required: ['action'],
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    } as any);

    expect(body).toHaveProperty('request');
    expect((body as any).request).toHaveProperty('tools');
    expect((body as any).request).toHaveProperty('toolConfig');
    expect((body as any).request).not.toHaveProperty('stream');
    expect((body as any).request).not.toHaveProperty('web_search');
  });

  test('handles data envelope and keeps tools in request', () => {
    const client = new GeminiCLIProtocolClient();

    const body = client.buildRequestBody({
      data: {
        model: 'gemini-3-pro-high',
        project: 'proj',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'clock', parameters: { type: 'OBJECT' } }] }],
        metadata: { shouldNot: 'leak' },
      },
    } as any);

    expect(body).toHaveProperty('model', 'gemini-3-pro-high');
    expect(body).toHaveProperty('project', 'proj');
    expect((body as any).request).toBeTruthy();
    expect((body as any).request).toHaveProperty('tools');
    expect((body as any).request).not.toHaveProperty('metadata');
  });
});
