import { describe, expect, it } from '@jest/globals';

const { applyRequestCompat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js'
);

describe('Responses function tool normalization compat shell', () => {
  it('normalizes chat-style function tools without an explicit compatibility profile', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        }
      ]
    };

    const out = applyRequestCompat(undefined, payload as any, {
      adapterContext: { providerProtocol: 'openai-responses' } as any
    }).payload as any;

    expect(out.tools[0]).toMatchObject({
      type: 'function',
      name: 'exec_command',
      description: 'Run shell command',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } }
      }
    });
    expect(out.tools[0].function).toBeUndefined();
  });
});
