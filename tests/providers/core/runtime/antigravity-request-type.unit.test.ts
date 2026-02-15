import { resolveAntigravityRequestTypeFromPayload } from '../../../../src/providers/core/runtime/antigravity-request-type.js';

describe('resolveAntigravityRequestTypeFromPayload', () => {
  test('keeps explicit requestType when provided', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        requestType: 'web_search',
        model: 'gemini-3-pro-high'
      } as any)
    ).toBe('web_search');
  });

  test('classifies image model as image_gen', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-image-4k'
      } as any)
    ).toBe('image_gen');
  });

  test('classifies -online suffix model as web_search', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high-online'
      } as any)
    ).toBe('web_search');
  });

  test('classifies networking tools as web_search', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high',
        tools: [{ function: { name: 'web_search' } }]
      } as any)
    ).toBe('web_search');

    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high',
        tools: [{ googleSearch: {} }]
      } as any)
    ).toBe('web_search');

    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high',
        request: {
          tools: [{ functionDeclarations: [{ name: 'google_search' }] }]
        }
      } as any)
    ).toBe('web_search');
  });

  test('keeps metadata hasImageAttachment fallback as image_gen', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high',
        metadata: { hasImageAttachment: true }
      } as any)
    ).toBe('image_gen');
  });

  test('defaults to agent when no signal exists', () => {
    expect(
      resolveAntigravityRequestTypeFromPayload({
        model: 'gemini-3-pro-high'
      } as any)
    ).toBe('agent');
  });
});
