import { applyGeminiWebSearchCompat } from '../gemini-web-search.js';

describe('gemini-web-search native wrapper', () => {
  test('normalizes web-search route tools into Gemini-compatible search tools', () => {
    const payload: any = {
      requestId: 'gemini_req_1',
      web_search: { enabled: true },
      tools: [
        {
          functionDeclarations: [
            { name: 'web_search', description: 'search web' },
            { name: 'exec_command', description: 'run shell' },
          ],
        },
        {
          googleSearch: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC' } },
        },
      ],
    };

    const result = applyGeminiWebSearchCompat(payload, {
      compatibilityProfile: 'chat:gemini',
      providerProtocol: 'gemini-chat',
      routeId: 'search-primary',
      requestId: 'req_gemini_1',
    } as any) as any;

    expect(result.web_search).toBeUndefined();
    expect(result.tools[0].functionDeclarations).toEqual([
      { name: 'web_search', description: 'search web' },
    ]);
    expect(result.tools[1].googleSearch.dynamicRetrievalConfig.mode).toBe(
      'MODE_DYNAMIC',
    );
  });

  test('keeps semantics unchanged when route context is missing', () => {
    const payload: any = {
      requestId: 'gemini_req_2',
      web_search: { enabled: true },
      tools: [
        {
          functionDeclarations: [{ name: 'exec_command', description: 'run shell' }],
        },
      ],
    };

    const result = applyGeminiWebSearchCompat(payload) as any;

    expect(result).toEqual(payload);
  });

  test('does not pollute unrelated fields while injecting default googleSearch tool', () => {
    const payload: any = {
      model: 'gemini-2.5-pro',
      requestId: 'gemini_req_3',
      metadata: { trace: 'keep' },
      web_search: { enabled: true },
    };

    const result = applyGeminiWebSearchCompat(payload, {
      compatibilityProfile: 'chat:gemini',
      providerProtocol: 'gemini-chat',
      routeId: 'web_search-main',
      requestId: 'req_gemini_3',
    } as any) as any;

    expect(result.model).toBe('gemini-2.5-pro');
    expect(result.metadata).toEqual({ trace: 'keep' });
    expect(result.tools).toEqual([{ googleSearch: {} }]);
    expect(result.web_search).toBeUndefined();
  });
});
