import {
  applyOpenCodeZenThinkingDefaults,
  buildOpenAiSdkChatCallOptions,
  mergePreservedOpenAiRequestFields,
  VercelAiSdkOpenAiTransport
} from '../../../../src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.js';

describe('applyOpenCodeZenThinkingDefaults', () => {
  it('injects enable_thinking=true by default for opencode-zen provider requests', () => {
    expect(
      applyOpenCodeZenThinkingDefaults(
        {
          model: 'nemotron-3-super-free',
          messages: [{ role: 'user', content: 'hello' }]
        },
        {
          providerId: 'opencode-zen-free'
        } as any
      )
    ).toMatchObject({
      model: 'nemotron-3-super-free',
      messages: [{ role: 'user', content: 'hello' }],
      enable_thinking: true
    });
  });

  it('does not override caller-provided thinking flags', () => {
    expect(
      applyOpenCodeZenThinkingDefaults(
        {
          model: 'nemotron-3-super-free',
          messages: [{ role: 'user', content: 'hello' }],
          enable_thinking: false
        },
        {
          providerId: 'opencode-zen-free'
        } as any
      )
    ).toMatchObject({
      enable_thinking: false
    });

    expect(
      applyOpenCodeZenThinkingDefaults(
        {
          model: 'nemotron-3-super-free',
          messages: [{ role: 'user', content: 'hello' }],
          chat_template_args: { enable_thinking: false }
        },
        {
          providerId: 'opencode-zen-free'
        } as any
      )
    ).toMatchObject({
      chat_template_args: { enable_thinking: false }
    });
  });
});

describe('buildOpenAiSdkChatCallOptions', () => {
  it('maps openai chat payload into AI SDK call options and preserves reasoning/tool config', () => {
    const options = buildOpenAiSdkChatCallOptions(
      {
        model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
        messages: [
          { role: 'developer', content: 'You are terse.' },
          {
            role: 'assistant',
            content: 'working',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: '{"command":"pwd"}'
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: { ok: true }
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'continue' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,QUJD',
                  detail: 'high'
                }
              }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'bash',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: {
                  command: { type: 'string' }
                },
                required: ['command']
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'bash' } },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'reply',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string' }
              },
              required: ['answer']
            }
          }
        },
        reasoning_effort: 'high',
        parallel_tool_calls: true,
        max_tokens: 256
      },
      {
        authorization: 'Bearer test'
      }
    );

    expect(options.maxOutputTokens).toBe(256);
    expect(options.toolChoice).toEqual({ type: 'tool', toolName: 'bash' });
    expect(options.tools).toEqual([
      {
        type: 'function',
        name: 'bash',
        description: 'run shell',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      }
    ]);
    expect(options.responseFormat).toEqual({
      type: 'json',
      name: 'reply',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' }
        },
        required: ['answer']
      }
    });
    expect(options.providerOptions).toEqual({
      openai: {
        systemMessageMode: 'system',
        reasoningEffort: 'high',
        forceReasoning: true,
        parallelToolCalls: true,
        strictJsonSchema: true
      }
    });
    expect(options.prompt).toEqual([
      { role: 'system', content: 'You are terse.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: { command: 'pwd' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'tool',
            output: { type: 'json', value: { ok: true } }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'continue' },
          {
            type: 'file',
            data: 'QUJD',
            mediaType: 'image/png',
            providerOptions: {
              openai: { imageDetail: 'high' }
            }
          }
        ]
      }
    ]);
  });
});

describe('mergePreservedOpenAiRequestFields', () => {
  it('keeps top-level provider-specific fields not rebuilt by the SDK', () => {
    expect(
      mergePreservedOpenAiRequestFields(
        {
          model: 'qwen3.5-plus',
          messages: [],
          parameters: { reasoning: true },
          input: [{ role: 'user', content: [{ text: 'hi' }] }],
          __internal: { drop: true }
        },
        {
          model: 'qwen3.5-plus',
          messages: []
        }
      )
    ).toEqual({
      model: 'qwen3.5-plus',
      messages: [],
      parameters: { reasoning: true },
      input: [{ role: 'user', content: [{ text: 'hi' }] }]
    });
  });
});

describe('VercelAiSdkOpenAiTransport', () => {
  it('builds request body via AI SDK and preserves unknown top-level fields before sending', async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'resp_1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    try {
      const transport = new VercelAiSdkOpenAiTransport();
      const response = await transport.executePreparedRequest(
        {
          endpoint: '/chat/completions',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          targetUrl: 'https://example.com/v1/chat/completions',
          body: {
            model: 'qwen3.5-plus',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'high',
            parameters: { reasoning: true }
          },
          wantsSse: false
        },
        {
          requestId: 'req_1'
        } as any
      );

      expect(calls).toHaveLength(1);
      const requestBody = JSON.parse(String(calls[0].init?.body));
      expect(requestBody).toMatchObject({
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'high',
        parameters: { reasoning: true }
      });
      expect(response).toMatchObject({
        status: 200,
        data: {
          id: 'resp_1'
        }
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
