import { applyQwenRequestTransform, applyQwenResponseTransform } from '../qwen-transform.js';

describe('qwen-transform native wrapper', () => {
  test('keeps qwen request openai-chat shape and only normalizes incompatible content parts', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello qwen' }]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((result as any).model).toBe('qwen3-coder-plus');
    expect((result as any).messages).toEqual([
      {
        role: 'user',
        content: 'hello qwen'
      }
    ]);
    expect((result as any).input).toBeUndefined();
  });

  test('preserves reasoning and top-level chat fields', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'low' },
        max_tokens: 2048,
        stop: ['END']
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((result as any).reasoning).toEqual({ effort: 'low' });
    expect((result as any).max_tokens).toBe(2048);
    expect((result as any).stop).toEqual(['END']);
  });

  test('preserves metadata and response-side finish_reason/tool_calls/usage mapping', () => {
    const request = applyQwenRequestTransform(
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'inspect metadata' }],
        metadata: { requestLabel: 'keep' }
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    const response = applyQwenResponseTransform(
      {
        data: {
          id: 'qwen_resp_1',
          model: 'qwen-plus',
          created: 123,
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'done',
                reasoning_content: 'thinking...',
                tool_calls: [
                  {
                    id: 'call_1',
                    function: {
                      name: 'exec_command',
                      arguments: { cmd: 'pwd' }
                    }
                  }
                ]
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 6,
            total_tokens: 16
          }
        }
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((request as any).metadata).toEqual({ requestLabel: 'keep' });
    expect((response as any).choices[0].finish_reason).toBe('tool_calls');
    expect((response as any).choices[0].message.tool_calls[0].function.arguments).toBe('{"cmd":"pwd"}');
    expect((response as any).choices[0].message.reasoning_content).toBe('thinking...');
    expect((response as any).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 6,
      total_tokens: 16
    });
  });

  test('maps non-string content into qwen input text chunks', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'alpha' }, { meta: 1 }]
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((result as any).messages[0].content[0]).toEqual({ type: 'text', text: 'alpha' });
    expect((result as any).messages[0].content[1]).toEqual({ meta: 1 });
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_text"');
    expect((result as any).input).toBeUndefined();
  });

  test('normalizes input_image/input_video into qwen media content types', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: { url: 'https://example.com/a.png' } },
              { type: 'input_video', video_url: 'https://example.com/a.mp4' }
            ]
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    const inputParts = (result as any).messages[0].content;
    expect(inputParts[0]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
    expect(inputParts[1]).toEqual({ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } });
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_image"');
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_video"');
  });

  test('preserves assistant tool history and tool results', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'run pwd' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'exec_command',
            content: 'ok'
          }
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'exec_command', description: 'run shell', parameters: { type: 'object' } },
            extra: true
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((result as any).messages[1].tool_calls[0].id).toBe('call_1');
    expect((result as any).messages[2].tool_call_id).toBe('call_1');
    expect((result as any).messages[2].name).toBe('exec_command');
    expect((result as any).tools[0].extra).toBe(true);
  });

  test('preserves historical assistant reasoning_content for qwen chat requests', () => {
    const result = applyQwenRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'run pwd' },
          {
            role: 'assistant',
            content: '',
            reasoning_content: '先确认当前工作目录，再继续执行工具调用。',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'exec_command',
            content: 'ok'
          }
        ]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((result as any).messages[1].reasoning_content).toBe('先确认当前工作目录，再继续执行工具调用。');
    expect((result as any).messages[1].tool_calls[0].id).toBe('call_1');
  });
});
