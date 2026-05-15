import { buildAnthropicRequestFromOpenAIChat } from '../../sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-request.js';

describe('anthropic image mapping invariants', () => {
  it('maps data-url image to anthropic embedded base64 source', () => {
    const result = buildAnthropicRequestFromOpenAIChat({
      model: 'claude-3-7-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            {
              type: 'input_image',
              image_url: { url: 'data:image/png;base64,QUJDRA==' }
            }
          ]
        }
      ]
    } as any);

    expect((result as any).messages[0].content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'QUJDRA=='
        }
      },
      { type: 'text', text: 'look' }
    ]);
  });

  it('maps url image to anthropic url source', () => {
    const result = buildAnthropicRequestFromOpenAIChat({
      model: 'claude-3-7-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: { url: 'https://example.com/a.png' }
            }
          ]
        }
      ]
    } as any);

    expect((result as any).messages[0].content).toEqual([
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://example.com/a.png'
        }
      }
    ]);
  });

  it('fails fast on malformed data-url image', () => {
    expect(() =>
      buildAnthropicRequestFromOpenAIChat({
        model: 'claude-3-7-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: { url: 'data:image/png;base64' }
              }
            ]
          }
        ]
      } as any)
    ).toThrow('malformed data URL image payload');
  });
});
