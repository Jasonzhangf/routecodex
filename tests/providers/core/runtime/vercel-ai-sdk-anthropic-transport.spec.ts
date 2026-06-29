import {
  hasRemoteAnthropicImageUrls,
  inlineRemoteAnthropicImageUrls,
  resolveAnthropicRemoteImagePolicy,
  shouldRetryWithInlineRemoteImage
} from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-transport.js';
import { executeAnthropicRequestWithBody } from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-request-exec.js';

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

  it('accepts context metadata override as highest priority', () => {
    process.env.ROUTECODEX_REMOTE_IMAGE_POLICY = 'direct';
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan', metadata: { remoteImagePolicy: 'direct_then_inline' } } as any,
      { model: 'kimi-k2.5' }
    )).toBe('direct_then_inline');
  });

  it('does not read remote image policy from request body metadata', () => {
    process.env.ROUTECODEX_REMOTE_IMAGE_POLICY = 'direct';
    expect(resolveAnthropicRemoteImagePolicy(
      { providerId: 'ali-coding-plan' } as any,
      { model: 'kimi-k2.5', metadata: { remoteImagePolicy: 'direct_then_inline' } }
    )).toBe('direct');
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
  it('strips internal session headers without coalescing historical user turns before upstream send', async () => {
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
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'r1' }] },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'r2' }] },
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
      expect(roles).toEqual(['user', 'user', 'user', 'assistant', 'assistant', 'user']);
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[0]?.content).toBe('u1');
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[1]?.content).toBe('u2');
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[2]?.content).toBe('u3');
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[3]).toEqual({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'r1' }]
      });
      expect((capturedBody?.messages as Array<Record<string, unknown>>)[4]).toEqual({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'r2' }]
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('preserves tool_result before following image-placeholder user turn in outbound body', async () => {
    const originalFetch = global.fetch;
    let capturedBody: Record<string, unknown> | undefined;

    global.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    try {
      await executeAnthropicRequestWithBody(
        {
          model: 'MiniMax-M3',
          stream: true,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call_inline_image_history',
                  name: 'exec_command',
                  input: { cmd: 'tail -n 60 note.md' }
                }
              ]
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_inline_image_history',
                  content: 'Total output lines: 141\n[Image omitted]'
                }
              ]
            },
            {
              role: 'user',
              content: [{ type: 'text', text: '[Image omitted]' }]
            }
          ]
        } as any,
        {
          endpoint: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code',
            'x-api-key': 'test-key'
          },
          targetUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages',
          body: {},
          wantsSse: true
        } as any
      );

      const messages = (capturedBody?.messages as Array<Record<string, unknown>>) || [];
      expect(messages.map((entry) => entry.role)).toEqual(['assistant', 'user', 'user']);
      expect(messages[0]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_inline_image_history',
            name: 'exec_command',
            input: { cmd: 'tail -n 60 note.md' }
          }
        ]
      });
      expect(messages[1]?.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'call_inline_image_history',
          content: 'Total output lines: 141\n[Image omitted]'
        }
      ]);
      expect(messages[2]?.content).toEqual([{ type: 'text', text: '[Image omitted]' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('executeAnthropicRequestWithBody', () => {
  it('fails fast when internal metadata reaches Anthropic provider wire body', async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ init });
      return new Response(JSON.stringify({ id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    try {
      await expect(
        executeAnthropicRequestWithBody(
          {
            model: 'mimo-v2.5-pro',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
            metadata: { user_id: 'must-not-leak', routeHint: 'internal' }
          } as any,
          {
            endpoint: '/v1/messages',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01'
            },
            targetUrl: 'https://example.com/anthropic/v1/messages',
            body: {},
            wantsSse: false
          } as any
        )
      ).rejects.toThrow('provider-runtime-error: anthropic provider wire body contains internal metadata');

      expect(calls).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

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

  it('fails fast when internal metadata center mirror reaches Anthropic provider wire body', async () => {
    await expect(
      executeAnthropicRequestWithBody(
        {
          model: 'mimo-v2.5-pro',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
          __metadataCenter: {
            runtimeControl: {
              providerProtocol: 'anthropic-messages'
            }
          }
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
    ).rejects.toThrow('provider-runtime-error: anthropic provider wire body contains internal metadata');
  });
});
