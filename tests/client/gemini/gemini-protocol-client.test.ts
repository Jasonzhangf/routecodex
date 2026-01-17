import { GeminiProtocolClient } from '../../../src/client/gemini/gemini-protocol-client.js';

describe('GeminiProtocolClient', () => {
  test('drops metadata from upstream body', () => {
    const client = new GeminiProtocolClient();
    const body = client.buildRequestBody({
      model: 'gemini-1.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      metadata: {
        __raw_request_body: { big: 'blob' },
        clientHeaders: { accept: 'application/json' },
      },
    } as any);

    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('model');
    expect(body).toHaveProperty('contents');
  });
});

