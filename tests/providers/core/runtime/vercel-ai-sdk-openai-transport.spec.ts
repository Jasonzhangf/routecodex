import { once } from 'node:events';

import {
  applyOpenCodeZenThinkingDefaults,
  buildOpenAiSdkChatCallOptions,
  preserveOpenAiSdkChatWireSemantics,
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

  it('fails fast when internal metadata center mirror reaches OpenAI SDK provider options builder', () => {
    expect(() =>
      buildOpenAiSdkChatCallOptions(
        {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }],
          __metadataCenter: {
            runtimeControl: {
              providerProtocol: 'openai-chat'
            }
          }
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

describe('preserveOpenAiSdkChatWireSemantics', () => {
  it('restores stream and raw wire messages/tools when AI SDK rewrites tool history semantics', () => {
    const original = {
      model: 'glm-5.2',
      stream: true,
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_patch_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch'
              }
            }
          ]
        },
        {
          role: 'tool',
          id: 'call_result_1',
          name: 'exec_command',
          tool_call_id: 'call_patch_1',
          content: 'ok'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'patch',
            parameters: { type: 'string' }
          }
        }
      ],
      tool_choice: 'required'
    } as any;

    const sdkArgs = {
      model: 'glm-5.2',
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_patch_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '\"*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch\"'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_patch_1',
          content: 'ok'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'patch',
            parameters: { type: 'string' }
          }
        }
      ],
      tool_choice: { type: 'required' }
    } as any;

    expect(preserveOpenAiSdkChatWireSemantics(original, sdkArgs)).toEqual(original);
  });
});

describe('VercelAiSdkOpenAiTransport', () => {
  it('aborts prepared SDK fetch when upstream never returns headers', async () => {
    const originalFetch = global.fetch;
    global.fetch = ((_: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      const transport = new VercelAiSdkOpenAiTransport();
      await expect(
        transport.executePreparedRequest(
          {
            endpoint: '/chat/completions',
            headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
            targetUrl: 'https://example.com/v1/chat/completions',
            body: {
              model: 'glm-5.2',
              stream: true,
              messages: [{ role: 'user', content: 'hello' }]
            },
            wantsSse: true
          },
          {
            requestId: 'req_sdk_headers_timeout',
            profile: {
              defaultBaseUrl: 'https://example.com/v1',
              defaultEndpoint: '/chat/completions',
              defaultModel: 'glm-5.2',
              requiredAuth: [],
              optionalAuth: [],
              timeout: 200,
              streamHeadersTimeoutMs: 40,
              streamIdleTimeoutMs: 5_000
            }
          } as any
        )
      ).rejects.toMatchObject({
        code: 'UPSTREAM_HEADERS_TIMEOUT',
        statusCode: 504
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('aborts prepared SDK SSE streams when headers arrive but no bytes follow', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Keep the upstream SSE body open without emitting any bytes.
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      });
    }) as typeof fetch;

    try {
      const transport = new VercelAiSdkOpenAiTransport();
      const result = (await transport.executePreparedRequest(
        {
          endpoint: '/chat/completions',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          targetUrl: 'https://example.com/v1/chat/completions',
          body: {
            model: 'glm-5.2',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
          },
          wantsSse: true
        },
        {
          requestId: 'req_sdk_stream_idle_timeout',
          profile: {
            defaultBaseUrl: 'https://example.com/v1',
            defaultEndpoint: '/chat/completions',
            defaultModel: 'glm-5.2',
            requiredAuth: [],
            optionalAuth: [],
            timeout: 5_000,
            streamHeadersTimeoutMs: 1_000,
            streamIdleTimeoutMs: 40
          }
        } as any
      )) as { sseStream: NodeJS.ReadableStream };

      result.sseStream.resume();
      const [error] = (await once(result.sseStream, 'error')) as [Error & { code?: string; statusCode?: number }];
      expect(error).toMatchObject({
        code: 'UPSTREAM_STREAM_IDLE_TIMEOUT',
        statusCode: 504
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

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
