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
});

