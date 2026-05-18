import { describe, expect, test } from '@jest/globals';
import { Readable } from 'node:stream';

import {
  isQwenWafHtmlPayload,
  parseIncomingMessagesForQwenChat,
} from '../../../src/providers/core/runtime/qwenchat-web-payload.js';
import { QwenChatWebProvider } from '../../../src/providers/core/runtime/qwenchat-web-provider.js';

describe('qwenchat web provider request shaping', () => {
  test('preserves history and last-turn attachments instead of collapsing to last text only', () => {
    const parsed = parseIncomingMessagesForQwenChat({
      model: 'qwen3.6-plus',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'please inspect this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
          ]
        }
      ]
    } as any);

    expect(parsed.content).toContain('[System]: You are helpful.');
    expect(parsed.content).toContain('[User]: first ask');
    expect(parsed.content).toContain('[Assistant]: first answer');
    expect(parsed.content).toContain('[User]: please inspect this image');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.source).toBe('https://example.com/test.png');
    expect(parsed.chatType).toBe('t2t');
  });

  test('uses attachment prompt fallback when latest user turn has only files', () => {
    const parsed = parseIncomingMessagesForQwenChat({
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_image', file_url: 'https://example.com/only-image.png' }
          ]
        }
      ]
    } as any);

    expect(parsed.content).toBe('请结合附件内容回答。');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.chatType).toBe('t2t');
  });
});

describe('qwenchat web provider WAF detection', () => {
  test('classifies aliyun waf html payload as upstream error', () => {
    const html = '<!doctypehtml><meta name="aliyun_waf_aa" content="x"><script>window.renderData={}</script>';
    expect(isQwenWafHtmlPayload(html)).toBe(true);
  });

  test('does not misclassify normal sse payload as waf html', () => {
    const sse = 'data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n';
    expect(isQwenWafHtmlPayload(sse)).toBe(false);
  });
});

describe('qwenchat web provider transport shape', () => {
  test('sendRequestInternal strips qwen sdk headers and uses guest browser headers', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    let capturedCreateHeaders: Record<string, string> | undefined;
    let capturedCompletionHeaders: Record<string, string> | undefined;
    (provider as any).buildRequestHeaders = async () => ({
      Authorization: 'Bearer guest',
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': 'QwenCode/0.14.3',
      'X-DashScope-AuthType': 'guest',
      'X-Stainless-Timeout': '120',
      'X-Stainless-Runtime-Version': 'v26.0.0',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Package-Version': '5.11.0',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-OS': 'MacOS',
      'X-Stainless-Runtime': 'node',
      Origin: 'https://chat.qwen.ai',
      Referer: 'https://chat.qwen.ai/c/guest',
      originator: 'codex-tui',
      session_id: 's',
      conversation_id: 'c'
    });
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async (_url: string, _body: unknown, headers: Record<string, string>) => {
        capturedCreateHeaders = { ...headers };
        return {
          status: 200,
          data: { success: true, data: { id: 'chat_123' } },
          headers: { 'content-type': 'application/json' }
        };
      },
      postStream: async (_url: string, _body: unknown, headers: Record<string, string>) => {
        capturedCompletionHeaders = { ...headers };
        return Readable.from(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
      }
    };

    const response = await (provider as any).sendRequestInternal({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(capturedCreateHeaders?.['User-Agent']).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(capturedCreateHeaders?.['Accept-Language']).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(capturedCreateHeaders?.Referer).toBe('https://chat.qwen.ai/c/guest');
    expect(capturedCreateHeaders?.source).toBe('web');
    expect(capturedCreateHeaders?.Origin).toBeUndefined();
    expect(capturedCreateHeaders?.Authorization).toBeUndefined();
    expect(capturedCreateHeaders?.['X-DashScope-AuthType']).toBeUndefined();
    expect(capturedCreateHeaders?.['X-Stainless-Timeout']).toBeUndefined();
    expect(capturedCreateHeaders?.originator).toBeUndefined();
    expect(capturedCompletionHeaders?.version).toBe('0.2.9');
    expect((response as any).choices?.[0]?.message?.content).toBe('ok');
  });

  test('sendRequestInternal fails fast when create-chat returns waf html', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    (provider as any).buildRequestHeaders = async () => ({});
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async () => ({
        status: 200,
        data: '<!doctypehtml><meta name="aliyun_waf_aa" content="x"><script>window.renderData={}</script>',
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    };

    await expect((provider as any).sendRequestInternal({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toMatchObject({
      code: 'QWENCHAT_GUEST_WAF_CHALLENGE'
    });
  });

  test('sendRequestInternal surfaces upstream json rejection instead of empty completion', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    (provider as any).buildRequestHeaders = async () => ({});
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async () => ({
        status: 200,
        data: { success: true, data: { id: 'chat_123' } },
        headers: { 'content-type': 'application/json' }
      }),
      postStream: async () => Readable.from([
        '{"success":false,"request_id":"r1","data":{"code":"Bad_Request","details":"Internal error..."}}'
      ])
    };

    await expect((provider as any).sendRequestInternal({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toMatchObject({
      code: 'QWENCHAT_GUEST_UPSTREAM_REJECTED'
    });
  });

  test('sendRequestInternal surfaces embedded SSE error event instead of empty completion', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    (provider as any).buildRequestHeaders = async () => ({});
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async () => ({
        status: 200,
        data: { success: true, data: { id: 'chat_123' } },
        headers: { 'content-type': 'application/json' }
      }),
      postStream: async () => Readable.from([
        'data: {"response.created":{"chat_id":"c1"}}\n\n',
        'data: {"error":{"code":"internal_error","details":"image width invalid"}}\n\n',
        'data: [DONE]\n\n'
      ])
    };

    await expect((provider as any).sendRequestInternal({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toMatchObject({
      code: 'QWENCHAT_GUEST_UPSTREAM_REJECTED'
    });
  });

  test('sendRequestInternal promotes thinking_summary-only SSE into assistant content', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    (provider as any).buildRequestHeaders = async () => ({});
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async () => ({
        status: 200,
        data: { success: true, data: { id: 'chat_123' } },
        headers: { 'content-type': 'application/json' }
      }),
      postStream: async () => Readable.from([
        'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","extra":{"summary_thought":{"content":["正在分析日志截图中的版本信息"]}}}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    };

    const response = await (provider as any).sendRequestInternal({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect((response as any).choices?.[0]?.message?.content).toContain('正在分析日志截图中的版本信息');
    expect((response as any).choices?.[0]?.message?.reasoning_content).toContain('正在分析日志截图中的版本信息');
  });

  test('sendRequestInternal uses qwen2api-aligned t2t chat_type for image attachments', async () => {
    const provider = new QwenChatWebProvider({
      type: 'qwenchat-web-provider',
      config: {
        providerType: 'openai',
        providerId: 'qwenchat',
        baseUrl: 'https://chat.qwen.ai',
        auth: {
          type: 'apikey',
          rawType: 'qwenchat-guest',
          apiKey: ''
        },
        compatibilityProfile: 'chat:qwenchat-web',
        overrides: { endpoint: '/api/v2/chat/completions' }
      }
    } as any, { logger: {} as any } as any);

    let capturedCreateBody: Record<string, unknown> | undefined;
    let capturedCompletionBody: Record<string, unknown> | undefined;
    (provider as any).buildRequestHeaders = async () => ({
      'bx-ua': 'bxua',
      'bx-umidtoken': 'bxumid',
      'bx-v': '2.5.36'
    });
    (provider as any).finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    (provider as any).httpClient = {
      post: async (_url: string, body: Record<string, unknown>) => {
        capturedCreateBody = body;
        return {
          status: 200,
          data: { success: true, data: { id: 'chat_123' } },
          headers: { 'content-type': 'application/json' }
        };
      },
      postStream: async (_url: string, body: Record<string, unknown>) => {
        capturedCompletionBody = body;
        return Readable.from(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
      }
    };
    (provider as any).uploadAttachments = undefined;

    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.com/test.png') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      }
      if (url === 'https://chat.qwen.ai/api/v2/files/getstsToken') {
        return new Response(JSON.stringify({
          success: true,
          data: {
            file_url: 'https://qwen-webui-prod.oss-accelerate.aliyuncs.com/anonymous/test.png?x-oss-credential=ak%2F20260304%2Fap-southeast-1%2Foss%2Faliyun_v4_request&x-oss-date=20260304T065915Z',
            file_id: 'file_123',
            access_key_id: 'ak',
            access_key_secret: 'sk',
            security_token: 'token'
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://qwen-webui-prod.oss-accelerate.aliyuncs.com/anonymous/test.png') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://chat.qwen.ai/api/v2/users/status') {
        return new Response(JSON.stringify({ data: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    try {
      const response = await (provider as any).sendRequestInternal({
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是什么图片' },
              { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
            ]
          }
        ]
      });

      expect(capturedCreateBody?.chat_type).toBe('t2t');
      const message = Array.isArray(capturedCompletionBody?.messages)
        ? capturedCompletionBody?.messages[0] as Record<string, unknown>
        : undefined;
      expect(message?.chat_type).toBe('t2t');
      expect(message?.sub_chat_type).toBe('t2t');
      expect((message?.feature_config as Record<string, unknown>)?.auto_search).toBe(true);
      expect((message?.files as unknown[] | undefined)?.length).toBe(1);
      expect((response as any).choices?.[0]?.message?.content).toBe('ok');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
