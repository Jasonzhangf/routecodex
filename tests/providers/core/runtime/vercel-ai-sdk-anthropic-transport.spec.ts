import {
  buildAnthropicSdkCallOptions,
  hasRemoteAnthropicImageUrls,
  inlineRemoteAnthropicImageUrls,
  resolveAnthropicRemoteImagePolicy,
  shouldRetryWithInlineRemoteImage
} from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-transport.js';
import {
  executeAnthropicRequestWithBody,
  restoreAnthropicThinkingHistoryFromRawBody
} from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-request-exec.js';

describe('buildAnthropicSdkCallOptions', () => {
  it('maps top-level assistant reasoning_content into AI SDK reasoning parts', () => {
    const options = buildAnthropicSdkCallOptions(
      {
        model: 'mimo-v2.5-pro',
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          {
            role: 'user',
            content: '继续分析'
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'exec_command',
                input: { cmd: 'pwd' }
              }
            ],
            reasoning_content: '.'
          },
          {
            role: 'assistant',
            content: '',
            reasoning_content: '我已经确认工作目录，接下来继续分析锁恢复链路。'
          }
        ]
      },
      {
        'anthropic-beta': 'claude-code'
      }
    );

    expect(options.prompt).toEqual([
      { role: 'user', content: [{ type: 'text', text: '继续分析' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'exec_command',
            input: { cmd: 'pwd' },
            providerExecuted: undefined
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '我已经确认工作目录，接下来继续分析锁恢复链路。'
          }
        ]
      }
    ]);
  });

  it('restores anthropic thinking blocks from raw assistant reasoning history', () => {
    const rawBody = {
      model: 'mimo-v2.5-pro',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        { role: 'user', content: '继续分析' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          reasoning_content: '.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok'
            }
          ]
        },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '我已经确认工作目录，接下来继续分析锁恢复链路。'
        },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '最终结论：继续排查 provider busy 恢复逻辑。'
        }
      ]
    };

    const builtBody = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '继续分析' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok'
            }
          ]
        },
        {
          role: 'assistant',
          content: []
        }
      ]
    };

    const restored = restoreAnthropicThinkingHistoryFromRawBody(rawBody as any, builtBody as any) as any;
    expect(restored.messages).toEqual([
      { role: 'user', content: '继续分析' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'exec_command',
            input: { cmd: 'pwd' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'ok'
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '我已经确认工作目录，接下来继续分析锁恢复链路。' },
          { type: 'thinking', thinking: '最终结论：继续排查 provider busy 恢复逻辑。' }
        ]
      }
    ]);
  });

  it('canonicalizes assistant thinking blocks to anthropic thinking field before send', () => {
    const rawBody = {
      model: 'mimo-v2.5-pro',
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: '继续分析' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '先确认工具结果是否已回填。', signature: 'sig_1' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'echo_json',
              input: { message: 'ping' }
            }
          ]
        }
      ]
    };

    const restored = restoreAnthropicThinkingHistoryFromRawBody(rawBody as any, {
      model: 'mimo-v2.5-pro',
      messages: []
    } as any) as any;

    expect(restored.messages).toEqual([
      { role: 'user', content: '继续分析' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先确认工具结果是否已回填。', signature: 'sig_1' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'echo_json',
            input: { message: 'ping' }
          }
        ]
      }
    ]);
  });


  it('coalesces consecutive user messages into a single anthropic user message with mixed text and tool_result blocks', () => {
    const rawBody = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: 'system-like prompt chunk' },
        { role: 'user', content: 'user asks to continue' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          reasoning_content: '.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok'
            }
          ]
        },
        { role: 'user', content: '继续' }
      ]
    };

    const restored = restoreAnthropicThinkingHistoryFromRawBody(rawBody as any, {
      model: 'mimo-v2.5-pro',
      messages: []
    } as any) as any;

    expect(restored.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'system-like prompt chunk' },
          { type: 'text', text: 'user asks to continue' }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'exec_command',
            input: { cmd: 'pwd' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'ok'
          },
          { type: 'text', text: '继续' }
        ]
      }
    ]);
  });

  it('coalesces consecutive restored assistant reasoning turns into one anthropic assistant message', () => {
    const rawBody = {
      model: 'mimo-v2.5-pro',
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '先测试 WebSocket 节点。'
        },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '再检查 shunt 规则是否生效。'
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          reasoning_content: '.'
        }
      ]
    };

    const restored = restoreAnthropicThinkingHistoryFromRawBody(rawBody as any, {
      model: 'mimo-v2.5-pro',
      messages: []
    } as any) as any;

    expect(restored.messages).toEqual([
      { role: 'user', content: '继续' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先测试 WebSocket 节点。' },
          { type: 'thinking', thinking: '再检查 shunt 规则是否生效。' },
          { type: 'thinking', thinking: '.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'exec_command',
            input: { cmd: 'pwd' }
          }
        ]
      }
    ]);
  });

  it('maps anthropic thinking, effort, tools, and tool results into AI SDK call options', () => {
    const options = buildAnthropicSdkCallOptions(
      {
        model: 'glm-5',
        max_tokens: 1024,
        system: 'You are terse.',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'bash',
                input: { command: 'pwd' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'ok'
              },
              {
                type: 'text',
                text: 'continue'
              }
            ]
          }
        ],
        tools: [
          {
            name: 'bash',
            description: 'run shell',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string' }
              },
              required: ['command']
            }
          }
        ],
        tool_choice: { type: 'any' },
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' }
      },
      {
        'anthropic-beta': 'claude-code'
      }
    );

    expect(options.maxOutputTokens).toBe(1024);
    expect(options.toolChoice).toEqual({ type: 'required' });
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
    expect(options.providerOptions).toEqual({
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'high'
      }
    });
    expect(options.prompt).toEqual([
      { role: 'system', content: 'You are terse.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'toolu_1',
            toolName: 'bash',
            input: { command: 'pwd' },
            providerExecuted: undefined
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_1',
            toolName: 'bash',
            output: { type: 'text', value: 'ok' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'continue'
          }
        ]
      }
    ]);
  });

  it('maps standard input_image and image_url parts into anthropic file parts', () => {
    const options = buildAnthropicSdkCallOptions(
      {
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'look' },
              { type: 'input_image', image_url: 'https://example.com/a.png' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
            ]
          }
        ]
      },
      {}
    );

    expect(options.prompt).toHaveLength(1);
    expect(options.prompt[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'file', mediaType: 'image/*' },
        { type: 'file', mediaType: 'image/png' }
      ]
    });
    const promptContent = (options.prompt[0] as any).content;
    expect(promptContent[1].data).toBeInstanceOf(URL);
    expect(String(promptContent[1].data)).toBe('https://example.com/a.png');
    expect(promptContent[2].data).toBe('QUJD');
  });
});

describe('inlineRemoteAnthropicImageUrls', () => {
  it('inlines remote image URL as base64 and normalizes media type via byte sniff when header is octet-stream', async () => {
    const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const { body, rewrites } = await inlineRemoteAnthropicImageUrls(
      {
        model: 'kimi-k2.5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.com/file.bin'
                }
              }
            ]
          }
        ]
      },
      {
        fetchImpl: (async () => new Response(pngHeader, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' }
        })) as typeof fetch
      }
    );

    expect(rewrites).toBe(1);
    const source = (body.messages as any[])[0].content[0].source;
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/png');
    expect(typeof source.data).toBe('string');
    expect(String(source.data).length).toBeGreaterThan(0);
    expect(source.url).toBeUndefined();
  });

  it('fails fast with explicit error code when remote media type cannot be recognized as image', async () => {
    await expect(
      inlineRemoteAnthropicImageUrls(
        {
          model: 'kimi-k2.5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://example.com/unknown.dat'
                  }
                }
              ]
            }
          ]
        },
        {
          fetchImpl: (async () => new Response('not-an-image', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' }
          })) as typeof fetch
        }
      )
    ).rejects.toMatchObject({
      code: 'REMOTE_IMAGE_UNSUPPORTED_MEDIA_TYPE',
      statusCode: 415
    });
  });

  it('wraps bare network fetch failures with structured remote image error details', async () => {
    await expect(
      inlineRemoteAnthropicImageUrls(
        {
          model: 'qwen3.6-plus',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://example.com/unreachable.png'
                  }
                }
              ]
            }
          ]
        },
        {
          fetchImpl: (async () => {
            throw new TypeError('fetch failed');
          }) as typeof fetch
        }
      )
    ).rejects.toMatchObject({
      code: 'REMOTE_IMAGE_FETCH_NETWORK_ERROR',
      statusCode: 502
    });
  });
});

describe('remote image policy resolution', () => {
  const envBackup = { ...process.env };
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults ali-coding-plan provider to inline policy', () => {
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan' } as any,
      { model: 'kimi-k2.5' }
    )).toBe('inline');
  });

  it('defaults ali-coding-plan qwen3.6-plus to direct_then_inline policy', () => {
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan' } as any,
      { model: 'qwen3.6-plus' }
    )).toBe('direct_then_inline');
  });

  it('supports env override map for provider id', () => {
    process.env.ROUTECODEX_REMOTE_IMAGE_POLICY_OVERRIDES = JSON.stringify({
      'ali-coding-plan': 'direct'
    });
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan' } as any,
      { model: 'kimi-k2.5' }
    )).toBe('direct');
  });

  it('accepts request metadata override as highest priority', () => {
    process.env.ROUTECODEX_REMOTE_IMAGE_POLICY = 'direct';
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan' } as any,
      { model: 'kimi-k2.5', metadata: { remoteImagePolicy: 'direct_then_inline' } }
    )).toBe('direct_then_inline');
  });
});

describe('remote image retry classification', () => {
  it('marks known remote-media compatibility errors as retryable for inline fallback', () => {
    expect(shouldRetryWithInlineRemoteImage(new Error(
      "'media type: application/octet-stream' functionality not supported."
    ))).toBe(true);
    expect(shouldRetryWithInlineRemoteImage({
      statusCode: 400,
      message: 'Download multimodal file timed out'
    })).toBe(true);
  });

  it('does not retry unrelated 4xx payload errors', () => {
    expect(shouldRetryWithInlineRemoteImage({
      statusCode: 400,
      message: 'invalid tool schema'
    })).toBe(false);
  });
});

describe('hasRemoteAnthropicImageUrls', () => {
  it('detects remote image url blocks in anthropic payload', () => {
    expect(hasRemoteAnthropicImageUrls({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]
        }
      ]
    })).toBe(true);
  });

  it('ignores base64 image blocks', () => {
    expect(hasRemoteAnthropicImageUrls({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }]
        }
      ]
    })).toBe(false);
  });
});

describe('executeAnthropicRequestWithBody exact bad-sample family regression', () => {
  it('strips internal session headers and coalesces consecutive anthropic roles before upstream send', async () => {
    const originalFetch = global.fetch;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    global.fetch = (async (_url, init) => {
      capturedHeaders = { ...((init?.headers as Record<string, string>) || {}) };
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    try {
      await executeAnthropicRequestWithBody(
        {
          model: 'mimo-v2.5-pro',
          stream: true,
          thinking: { type: 'adaptive' },
          tool_choice: { type: 'auto' },
          messages: [
            { role: 'user', content: 'u1' },
            { role: 'user', content: 'u2' },
            { role: 'user', content: 'u3' },
            { role: 'assistant', content: '', reasoning_content: 'r1' },
            { role: 'assistant', content: '', reasoning_content: 'r2' },
            { role: 'user', content: '继续' }
          ]
        } as any,
        {
          endpoint: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code',
            'x-api-key': 'test-key',
            session_id: 'sess-internal',
            conversation_id: 'conv-internal',
            originator: 'codex-tui'
          },
          targetUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages',
          body: {},
          wantsSse: true
        } as any
      );

      expect(capturedHeaders?.session_id).toBeUndefined();
      expect(capturedHeaders?.conversation_id).toBeUndefined();
      expect(capturedHeaders?.originator).toBeUndefined();
      expect(Array.isArray(capturedBody?.messages)).toBe(true);
      const roles = ((capturedBody?.messages as Array<Record<string, unknown>>) || []).map((entry) => entry.role);
      expect(roles).toEqual(['user', 'assistant', 'user']);
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[0]?.content).toEqual([
        { type: 'text', text: 'u1' },
        { type: 'text', text: 'u2' },
        { type: 'text', text: 'u3' }
      ]);
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[1]?.content).toEqual([
        { type: 'thinking', thinking: 'r1' },
        { type: 'thinking', thinking: 'r2' }
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('executeAnthropicRequestWithBody', () => {
  it('reclassifies wrapped upstream 502 html from http 500 envelope to HTTP_502', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(
      'data:{"error":{"code":"500","message":"<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>openresty</center></body></html>","param":"","type":"Internal Server Error"}}\n\n',
      {
        status: 500,
        headers: { 'content-type': 'text/event-stream' }
      }
    )) as typeof fetch;

    try {
      await expect(
        executeAnthropicRequestWithBody(
          {
            model: 'mimo-v2.5-pro',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }]
          } as any,
          {
            endpoint: '/v1/messages',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01'
            },
            targetUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages',
            body: {},
            wantsSse: true
          } as any
        )
      ).rejects.toMatchObject({
        statusCode: 502,
        status: 502,
        response: {
          status: 502,
          data: {
            error: {
              code: 'HTTP_502'
            }
          }
        }
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
