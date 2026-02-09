import { GeminiProtocolClient } from '../../../src/client/gemini/gemini-protocol-client.js';

describe('GeminiProtocolClient', () => {
  test('drops metadata from upstream body', () => {
    const client = new GeminiProtocolClient();
    const body = client.buildRequestBody({
      model: 'gemini-1.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      metadata: {
        __raw_request_body: { big: 'blob' },
        clientHeaders: { accept: 'application/json' }
      }
    } as any);

    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('model');
    expect(body).toHaveProperty('contents');
  });

  test('converts OpenAI chat messages to Gemini contents and systemInstruction', () => {
    const client = new GeminiProtocolClient();
    const body = client.buildRequestBody({
      model: 'gemini-2.5-pro',
      stream: true,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: { text: 'world' } }
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 256
    } as any);

    expect(body).toHaveProperty('contents');
    expect(body).toHaveProperty('systemInstruction');
    expect((body as any).contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: '{"text":"world"}' }] }
    ]);
    expect((body as any).systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'You are helpful.' }]
    });
    expect((body as any).messages).toBeUndefined();
    expect((body as any).stream).toBeUndefined();
    expect((body as any).generationConfig).toEqual(
      expect.objectContaining({
        maxOutputTokens: 256,
        temperature: 0.2,
        topP: 0.9
      })
    );
  });
});
