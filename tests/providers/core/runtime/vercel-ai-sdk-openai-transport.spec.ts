import {
  applyOpenCodeZenThinkingDefaults,
  buildOpenAiSdkChatCallOptions,
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

  it('does not synthesize metadata when thinking history lacks original reasoning_content', () => {
    expect(
      applyOpenCodeZenThinkingDefaults(
        {
          model: 'deepseek-v4-flash-free',
          messages: [
            { role: 'user', content: 'run pwd' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }]
            }
          ]
        },
        {
          providerId: 'opencode-zen-free'
        } as any
      )
    ).toEqual({
      model: 'deepseek-v4-flash-free',
      messages: [
        { role: 'user', content: 'run pwd' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }]
        }
      ],
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
  it('fails fast when request metadata reaches OpenAI SDK provider options builder', () => {
    expect(() =>
      buildOpenAiSdkChatCallOptions(
        {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: 'must-not-leak', routeHint: 'internal' }
        },
        { authorization: 'Bearer test' }
      )
    ).toThrow(/metadata is not allowed in OpenAI SDK provider options/);
  });

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

describe('VercelAiSdkOpenAiTransport', () => {
  it('builds request body via AI SDK without merging raw request fields', async () => {
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
            parameters: { reasoning: true },
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw-only' }] }],
            contextSnapshot: { toolsRaw: [{ type: 'namespace', name: 'bad' }] },
            __raw_request_body: { tools: [{ type: 'namespace', name: 'bad' }] }
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
        messages: [{ role: 'user', content: 'hello' }]
      });
      expect(requestBody.parameters).toBeUndefined();
      expect(requestBody.input).toBeUndefined();
      expect(requestBody.contextSnapshot).toBeUndefined();
      expect(requestBody.__raw_request_body).toBeUndefined();
      expect(requestBody.metadata).toBeUndefined();
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
