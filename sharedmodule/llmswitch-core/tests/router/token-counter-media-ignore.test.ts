import { describe, expect, test } from '@jest/globals';

import { countRequestTokens } from '../../src/router/virtual-router/token-counter.js';

describe('token counter media payload handling', () => {
  test('does not count large input_image payload in content parts', () => {
    const baseRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Describe this image' }]
        }
      ],
      tools: []
    } as any;

    const withImage = {
      ...baseRequest,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this image' },
            { type: 'input_image', image_url: { url: `data:image/png;base64,${'A'.repeat(200000)}` } }
          ]
        }
      ]
    } as any;

    const base = countRequestTokens(baseRequest);
    const actual = countRequestTokens(withImage);
    expect(actual).toBeLessThanOrEqual(base + 8);
  });

  test('does not count large input_video payload in content parts', () => {
    const baseRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Summarize this clip' }]
        }
      ],
      tools: []
    } as any;

    const withVideo = {
      ...baseRequest,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Summarize this clip' },
            { type: 'input_video', video_url: `data:video/mp4;base64,${'B'.repeat(200000)}` }
          ]
        }
      ]
    } as any;

    const base = countRequestTokens(baseRequest);
    const actual = countRequestTokens(withVideo);
    expect(actual).toBeLessThanOrEqual(base + 8);
  });

  test('ignores media payload when content is a stringified structured block', () => {
    const baseRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Summarize this clip' }],
      tools: []
    } as any;

    const structuredStringRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: JSON.stringify([
            { type: 'input_text', text: 'Summarize this clip' },
            { type: 'input_video', video_url: `data:video/mp4;base64,${'C'.repeat(200000)}` }
          ])
        }
      ],
      tools: []
    } as any;

    const base = countRequestTokens(baseRequest);
    const actual = countRequestTokens(structuredStringRequest);
    expect(actual).toBeLessThanOrEqual(base + 12);
  });

  test('does not count internal metadata payloads', () => {
    const baseRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      parameters: {}
    } as any;

    const withLargeMetadata = {
      ...baseRequest,
      metadata: {
        requestId: 'req_meta',
        capturedContext: { dump: 'X'.repeat(120000) }
      },
      messages: [
        {
          role: 'user',
          content: 'ping',
          metadata: {
            toolRuns: [{ output: 'Y'.repeat(120000) }]
          }
        }
      ]
    } as any;

    const base = countRequestTokens(baseRequest);
    const actual = countRequestTokens(withLargeMetadata);
    expect(actual).toBeLessThanOrEqual(base + 8);
  });

  test('does not count large media payload inside responses context input', () => {
    const baseRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'assistant', content: 'ok' }],
      tools: [],
      parameters: {},
      semantics: {
        responses: {
          context: {
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Describe this image' }]
              }
            ]
          }
        }
      }
    } as any;

    const withImageInResponsesContext = {
      ...baseRequest,
      semantics: {
        responses: {
          context: {
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'Describe this image' },
                  { type: 'input_image', image_url: { url: `data:image/png;base64,${'Z'.repeat(200000)}` } }
                ]
              }
            ]
          }
        }
      }
    } as any;

    const base = countRequestTokens(baseRequest);
    const actual = countRequestTokens(withImageInResponsesContext);
    expect(actual).toBeLessThanOrEqual(base + 16);
  });
});
