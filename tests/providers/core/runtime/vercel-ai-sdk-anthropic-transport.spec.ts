import {
  buildAnthropicSdkCallOptions,
  hasRemoteAnthropicImageUrls,
  inlineRemoteAnthropicImageUrls,
  resolveAnthropicRemoteImagePolicy,
  shouldRetryWithInlineRemoteImage
} from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-transport.js';

describe('buildAnthropicSdkCallOptions', () => {
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
