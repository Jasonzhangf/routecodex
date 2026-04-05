import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildQwenChatSendPlan,
  collectQwenSseAsOpenAiResult,
  createOpenAiMappedSseStream,
  createQwenChatSession,
  extractQwenChatPayload,
  parseIncomingMessages
} from '../../../../src/providers/core/runtime/qwenchat-http-provider-helpers.js';
import { standardToolTextRequestTransformRuntime } from '../../../../src/providers/core/runtime/standard-tool-text-request-transform.js';

describe('qwenchat-http-provider helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps compat prompt payload into messages when messages are missing', () => {
    const payload = extractQwenChatPayload({
      data: {
        model: 'qwen3.6-plus',
        prompt: '请帮我检查工具调用',
        stream: false
      }
    } as any);

    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages).toEqual([{ role: 'user', content: '请帮我检查工具调用' }]);
    expect(parseIncomingMessages(payload.messages).content).toBe('请帮我检查工具调用');
    expect(payload.stream).toBe(false);
  });

  it('keeps original messages when both messages and prompt exist', () => {
    const payload = extractQwenChatPayload({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: '原始消息' }],
      prompt: '兼容提示词',
      stream: true
    } as any);

    expect(payload.messages).toEqual([{ role: 'user', content: '原始消息' }]);
    expect(parseIncomingMessages(payload.messages).content).toBe('原始消息');
    expect(payload.stream).toBe(true);
  });

  it('defaults stream=false when stream flag is omitted', () => {
    const payload = extractQwenChatPayload({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: '默认非流式' }]
    } as any);

    expect(payload.stream).toBe(false);
  });

  it('surfaces upstream rejection reason when create-session returns code/details', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: '您已达到今日的使用上限。'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' }
        })
      ).rejects.toMatchObject({
        code: 'QWENCHAT_CREATE_SESSION_REJECTED',
        statusCode: 429
      });
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' }
        })
      ).rejects.toThrow('upstream rejected request');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps permission-denied session create rejection to HTTP 403 (not 401)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'Forbidden',
            details: '您没有权限访问此资源。请联系您的管理员以获取帮助。'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' }
        })
      ).rejects.toMatchObject({
        code: 'QWENCHAT_CREATE_SESSION_REJECTED',
        statusCode: 403
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts chat id embedded in details object even when success=false', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'Partial',
            details: {
              chat_id: 'test-chat-id-from-details'
            }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' }
        })
      ).resolves.toBe('test-chat-id-from-details');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not forward auth headers by default in guest mode requests', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
    delete process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
    let seenAuth = '';
    let seenReferer = '';
    let seenAccept = '';
    let seenSource = '';
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seenAuth = headers.get('authorization') || '';
      seenReferer = headers.get('referer') || '';
      seenAccept = headers.get('accept') || '';
      seenSource = headers.get('source') || '';
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'chat-id-without-auth-forward'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' },
          authHeaders: { Authorization: 'Bearer should-not-be-forwarded' }
        })
      ).resolves.toBe('chat-id-without-auth-forward');
      expect(seenAuth).toBe('');
      expect(seenReferer).toBe('https://chat.qwen.ai/c/guest');
      expect(seenAccept).toBe('application/json');
      expect(seenSource).toBe('web');
    } finally {
      if (typeof originalEnv === 'string') {
        process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS = originalEnv;
      } else {
        delete process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
      }
      globalThis.fetch = originalFetch;
    }
  });

  it('can forward auth headers when explicitly enabled by env', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
    process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS = 'true';
    let seenAuth = '';
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      seenAuth = String((headers as any).authorization || (headers as any).Authorization || '');
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'chat-id-with-auth-forward'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.ai',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' },
          authHeaders: { Authorization: 'Bearer should-be-forwarded' }
        })
      ).resolves.toBe('chat-id-with-auth-forward');
      expect(seenAuth).toContain('should-be-forwarded');
    } finally {
      if (typeof originalEnv === 'string') {
        process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS = originalEnv;
      } else {
        delete process.env.ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS;
      }
      globalThis.fetch = originalFetch;
    }
  });

  it('uses custom baseUrl when building guest referer', async () => {
    const originalFetch = globalThis.fetch;
    let seenReferer = '';
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seenReferer = headers.get('referer') || '';
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'chat-id-custom-base'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      await expect(
        createQwenChatSession({
          baseUrl: 'https://chat.qwen.test/',
          model: 'qwen3.6-plus',
          chatType: 't2t',
          baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' }
        })
      ).resolves.toBe('chat-id-custom-base');
      expect(seenReferer).toBe('https://chat.qwen.test/c/guest');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not filter tool-markup text from streaming delta content in provider helper', async () => {
    const upstreamPayload = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: 'assistant',
              content:
                '<function_calls>{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"mailbox.status","arguments":{"target":"finger-system-agent"}}}]}</function_calls>'
            },
            finish_reason: null
          }
        ]
      })}\n`,
      'data: [DONE]\n'
    ].join('');

    const upstreamStream = Readable.from([upstreamPayload], { encoding: 'utf8' });
    const mapped = createOpenAiMappedSseStream({
      upstreamStream,
      model: 'qwen3.6-plus'
    });

    let output = '';
    await new Promise<void>((resolve, reject) => {
      mapped.on('data', (chunk: Buffer | string) => {
        output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      mapped.on('end', resolve);
      mapped.on('error', reject);
    });

    expect(output).toContain('<function_calls>');
    expect(output).toContain('data: [DONE]');
  });

  it('fails fast when standard tool-text transform does not produce prompt', async () => {
    jest
      .spyOn(standardToolTextRequestTransformRuntime, 'transform')
      .mockReturnValue({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'fallback message should not be used' }],
        tools: [
          {
            type: 'function',
            function: { name: 'update_plan', parameters: { type: 'object' } }
          }
        ]
      } as any);

    await expect(
      buildQwenChatSendPlan({
        baseUrl: 'https://chat.qwen.ai',
        baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' },
        payload: {
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: '请调用 update_plan' }],
          tools: [
            {
              type: 'function',
              function: { name: 'update_plan', parameters: { type: 'object' } }
            }
          ]
        }
      })
    ).rejects.toMatchObject({
      code: 'QWENCHAT_TOOL_TEXT_TRANSFORM_FAILED',
      statusCode: 422
    });
  });

  it('does not re-inject stale assistant tool-registry failure text into qwenchat tool prompt', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'chat-id-sanitized-history'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    try {
      const plan = await buildQwenChatSendPlan({
        baseUrl: 'https://chat.qwen.ai',
        baxiaTokens: { bxUa: 'bx-ua', bxUmidToken: 'bx-token', bxV: '2.5.36' },
        payload: {
          model: 'qwen3.6-plus',
          messages: [
            { role: 'system', content: '你是 coding assistant' },
            {
              role: 'assistant',
              content:
                'Tool exec_command does not exists.Tool apply_patch does not exists.Tool mailbox.status does not exists.'
            },
            { role: 'user', content: '继续，调用 exec_command 检查目录。' }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                description: 'run shell',
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string' }
                  },
                  required: ['cmd']
                }
              }
            }
          ]
        }
      });

      const content = String(
        (plan.completionBody.messages as Array<Record<string, unknown>>)?.[0]?.content || ''
      );
      expect(content).toContain('exec_command');
      expect(content).toContain('继续');
      expect(content).not.toContain('Tool exec_command does not exists');
      expect(content).not.toContain('Tool apply_patch does not exists');
      expect(content).not.toContain('Tool mailbox.status does not exists');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when upstream SSE ends with finish_reason=stop but empty assistant payload', async () => {
    const upstreamPayload = [
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }]
      })}\n`,
      'data: [DONE]\n'
    ].join('');
    const upstreamStream = Readable.from([upstreamPayload], { encoding: 'utf8' });
    await expect(
      collectQwenSseAsOpenAiResult({
        upstreamStream,
        model: 'qwen3.6-plus'
      })
    ).rejects.toMatchObject({
      code: 'QWENCHAT_EMPTY_ASSISTANT',
      statusCode: 502
    });
  });

  it('fails with 429 when upstream returns non-SSE business rejection payload', async () => {
    const upstreamPayload = JSON.stringify({
      success: false,
      data: {
        code: 'RateLimited',
        details: '您已达到今日的使用上限。'
      }
    });
    const upstreamStream = Readable.from([upstreamPayload], { encoding: 'utf8' });
    await expect(
      collectQwenSseAsOpenAiResult({
        upstreamStream,
        model: 'qwen3.6-plus'
      })
    ).rejects.toMatchObject({
      code: 'QWENCHAT_RATE_LIMITED',
      statusCode: 429
    });
  });
});
