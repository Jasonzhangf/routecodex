import { buildGeminiFromOpenAIChat } from '../../sharedmodule/llmswitch-core/src/conversion/codecs/gemini-openai-codec.js';

describe('buildGeminiFromOpenAIChat', () => {
  it('wraps array arguments strings into object payloads', () => {
    const chatResp = {
      id: 'chatcmpl_array',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_array_str',
                type: 'function',
                function: {
                  name: 'do_array',
                  arguments: JSON.stringify([{ step: 1 }, { step: 2 }])
                }
              }
            ]
          }
        }
      ]
    };

    const gemini = buildGeminiFromOpenAIChat(chatResp);
    const parts = gemini?.candidates?.[0]?.content?.parts ?? [];
    const functionCall = parts.find((p: any) => p?.functionCall)?.functionCall;

    expect(functionCall).toBeDefined();
    expect(Array.isArray(functionCall.args)).toBe(false);
    expect(functionCall.args).toEqual({
      _raw: JSON.stringify([{ step: 1 }, { step: 2 }])
    });
  });

  it('preserves plain object args when provided as JSON string', () => {
    const chatResp = {
      id: 'chatcmpl_object',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_obj',
                type: 'function',
                function: {
                  name: 'do_object',
                  arguments: JSON.stringify({ foo: 'bar' })
                }
              }
            ]
          }
        }
      ]
    };

    const gemini = buildGeminiFromOpenAIChat(chatResp);
    const parts = gemini?.candidates?.[0]?.content?.parts ?? [];
    const functionCall = parts.find((p: any) => p?.functionCall)?.functionCall;

    expect(functionCall).toBeDefined();
    expect(functionCall.args).toEqual({ foo: 'bar' });
  });
});
