import {
  GeminiOpenAIConversionCodec,
  buildGeminiFromOpenAIChat,
  buildOpenAIChatFromGeminiRequest,
  buildOpenAIChatFromGeminiResponse
} from '../gemini-openai-codec.js';

describe('gemini-openai-codec native wrapper', () => {
  const profile = {
    id: 'gemini-openai-test',
    incomingProtocol: 'gemini-chat',
    outgoingProtocol: 'openai-chat',
    codec: 'gemini-openai'
  } as any;

  test('request maps gemini payload into openai chat request', async () => {
    const codec = new GeminiOpenAIConversionCodec({});
    const result = await codec.convertRequest(
      {
        model: 'gemini-2.5-pro',
        systemInstruction: { parts: [{ text: 'Use tools carefully' }] },
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'pwd' },
              {
                functionCall: {
                  name: 'exec_command',
                  id: 'call_req',
                  args: { cmd: 'pwd' }
                }
              }
            ]
          }
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'exec_command',
                description: 'Run shell command',
                parameters: {
                  type: 'object',
                  properties: { cmd: { type: 'string' } },
                  required: ['cmd']
                }
              }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 128,
          temperature: 0.3,
          topP: 0.9,
          stopSequences: ['DONE']
        },
        metadata: { requestLabel: 'gemini-req' },
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH' }]
      },
      profile,
      { requestId: 'req_gemini_codec_request' } as any
    );

    expect((result as any).model).toBe('gemini-2.5-pro');
    expect((result as any).messages[0]).toMatchObject({ role: 'system', content: 'Use tools carefully' });
    expect((result as any).messages[1].tool_calls[0]).toMatchObject({
      id: 'call_req',
      function: {
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      }
    });
    expect((result as any).tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Run shell command'
      }
    });
    expect((result as any).max_tokens).toBe(128);
    expect((result as any).temperature).toBe(0.3);
    expect((result as any).top_p).toBe(0.9);
    expect((result as any).stop).toEqual(['DONE']);
    expect((result as any).metadata).toMatchObject({
      requestLabel: 'gemini-req',
      vendor: {
        gemini: {
          safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH' }]
        }
      }
    });
  });

  test('response maps gemini candidates into openai chat shape with normalized web_search tool call', () => {
    const result = buildOpenAIChatFromGeminiResponse({
      id: 'gem_resp_1',
      model: 'gemini-2.5-pro',
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14
      },
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { thought: 'Need shell output' },
              { text: 'Running command' },
              {
                functionCall: {
                  name: 'websearch',
                  args: { query: 'pwd' }
                },
                thoughtSignature: 'sig_1'
              },
              {
                functionResponse: {
                  id: 'call_tool',
                  name: 'websearch',
                  response: { ok: true }
                }
              }
            ]
          }
        }
      ]
    } as any);

    expect((result as any).id).toBe('gem_resp_1');
    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: 'web_search',
        arguments: '{"query":"pwd"}'
      },
      thought_signature: 'sig_1'
    });
    expect((result as any).tool_outputs[0]).toMatchObject({
      tool_call_id: 'call_tool',
      name: 'web_search',
      content: '{"ok":true}'
    });
    expect((result as any).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14
    });
    expect((result as any).__responses_reasoning.content[0]).toEqual({
      type: 'reasoning_text',
      text: 'Need shell output'
    });
  });

  test('response throws ProviderProtocolError on unexpected tool call without usable tool call payload', () => {
    expect(() =>
      buildOpenAIChatFromGeminiResponse({
        candidates: [
          {
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: { role: 'model', parts: [{ text: 'bad tool' }] }
          }
        ]
      } as any)
    ).toThrow(/UNEXPECTED_TOOL_CALL/);
  });

  test('outbound maps openai chat response back to gemini response', async () => {
    const codec = new GeminiOpenAIConversionCodec({});
    const result = await codec.convertResponse(
      {
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Run tool',
              reasoning_content: 'Need cwd',
              tool_calls: [
                {
                  id: 'call_out',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  },
                  extra_content: {
                    google: {
                      thought_signature: 'sig_out'
                    }
                  }
                }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19
        }
      },
      profile,
      { requestId: 'req_gemini_codec_response' } as any
    );

    expect((result as any).id).toBe('chatcmpl_1');
    expect((result as any).candidates[0]).toMatchObject({
      finishReason: 'STOP',
      content: {
        role: 'model'
      }
    });
    expect((result as any).candidates[0].content.parts[0]).toEqual({ text: 'Run tool' });
    expect((result as any).candidates[0].content.parts[1]).toEqual({ reasoning: 'Need cwd' });
    expect((result as any).candidates[0].content.parts[2]).toEqual({
      functionCall: {
        id: 'call_out',
        name: 'exec_command',
        args: { cmd: 'pwd' }
      },
      thoughtSignature: 'sig_out'
    });
    expect((result as any).usageMetadata).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 7,
      totalTokenCount: 19
    });
  });

  test('direct helper returns gemini wire payload', () => {
    const result = buildGeminiFromOpenAIChat({
      id: 'chatcmpl_direct',
      model: 'gpt-4.1',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Done'
          }
        }
      ]
    } as any);

    expect((result as any).candidates[0].content).toEqual({
      role: 'model',
      parts: [{ text: 'Done' }]
    });
  });

  test('direct helper returns openai request payload', () => {
    const result = buildOpenAIChatFromGeminiRequest({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
    } as any);

    expect((result as any)).toEqual({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }]
    });
  });
});
