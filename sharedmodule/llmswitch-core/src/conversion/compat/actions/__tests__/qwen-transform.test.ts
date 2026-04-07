import { applyQwenRequestTransform, applyQwenResponseTransform } from '../qwen-transform.js';

describe('qwen-transform native wrapper', () => {
  test('maps model and normalizes messages into qwen input', () => {
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
        content: [{ type: 'text', text: 'hello qwen' }]
      }
    ]);
    expect((result as any).input).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello qwen' }]
      }
    ]);
  });

  test('keeps native reasoning defaults and low-effort override behavior', () => {
    const defaultReasoning = applyQwenRequestTransform(
      {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hi' }]
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    const lowEffort = applyQwenRequestTransform(
      {
        model: 'qwen3.5-plus',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'low' }
      } as any,
      {
        compatibilityProfile: 'chat:qwen',
        providerProtocol: 'openai-chat'
      } as any
    );

    expect((defaultReasoning as any).parameters.reasoning).toBe(true);
    expect((lowEffort as any).parameters?.reasoning).toBeUndefined();
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
    expect((result as any).input[0].content[0]).toEqual({ type: 'text', text: 'alpha' });
    expect((result as any).input[0].content[1]).toEqual({ meta: 1 });
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_text"');
    expect(JSON.stringify((result as any).input)).not.toContain('"input_text"');
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

    const inputParts = (result as any).input[0].content;
    expect(inputParts[0]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
    expect(inputParts[1]).toEqual({ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } });
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_image"');
    expect(JSON.stringify((result as any).messages)).not.toContain('"input_video"');
  });
});
