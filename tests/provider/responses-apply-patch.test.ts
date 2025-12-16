const ensureApplyPatchMock = jest.fn();

jest.mock('../../src/modules/llmswitch/bridge.ts', () => ({
  buildResponsesRequestFromChat: async (body: any) => ({
    request: {
      model: body?.model || 'gpt-test',
      input: [
        { type: 'function_call', name: 'apply_patch', arguments: '{"patch":"original"}' }
      ]
    }
  }),
  ensureResponsesApplyPatchArguments: ensureApplyPatchMock
}), { virtual: true });

const importResponsesProvider = async () =>
  (await import('../../src/providers/core/runtime/responses-http-provider.ts')).ResponsesHttpProvider as any;

describe.skip('Responses provider apply_patch normalization (requires ESM loader)', () => {
  const deps: any = {
    logger: { logModule: () => {}, logProviderRequest: () => {} },
    errorHandlingCenter: { handleError: async () => {} }
  };

  beforeEach(() => {
    ensureApplyPatchMock.mockReset();
    ensureApplyPatchMock.mockImplementation(async (input?: unknown[]) => {
      if (Array.isArray(input) && input[0] && typeof input[0] === 'object') {
        (input[0] as any).arguments = JSON.stringify({ patch: 'demo', input: 'demo' });
      }
    });
  });

  test('calls ensureResponsesApplyPatchArguments for responses-shaped payloads', async () => {
    const ResponsesHttpProvider = await importResponsesProvider();
    const provider = new ResponsesHttpProvider({
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        baseUrl: 'https://api.test.local/v1',
        model: 'gpt-test',
        auth: { type: 'apikey', apiKey: 'test' }
      }
    }, deps);
    await provider.initialize();

    const body = {
      input: [
        { type: 'function_call', name: 'apply_patch', arguments: '{}' }
      ]
    };

    await (provider as any).maybeConvertChatPayload(body);

    expect(ensureApplyPatchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(body.input)).toBe(true);
    const first = (body.input as any[])[0];
    expect(() => JSON.parse(first.arguments)).not.toThrow();
    expect(JSON.parse(first.arguments).patch).toBe('demo');
    expect(JSON.parse(first.arguments).input).toBe('demo');
  });

  test('ensures apply_patch after chat-to-responses conversion as well', async () => {
    const ResponsesHttpProvider = await importResponsesProvider();
    const provider = new ResponsesHttpProvider({
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        baseUrl: 'https://api.test.local/v1',
        model: 'gpt-test',
        auth: { type: 'apikey', apiKey: 'test' }
      }
    }, deps);
    await provider.initialize();

    const body = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_apply_patch',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{}' }
            }
          ]
        }
      ]
    };

    await (provider as any).maybeConvertChatPayload(body);

    expect(ensureApplyPatchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(body.input)).toBe(true);
    const first = (body.input as any[])[0];
    expect(() => JSON.parse(first.arguments)).not.toThrow();
    expect(JSON.parse(first.arguments).input).toBe('demo');
  });

  test('propagates errors when ensureResponsesApplyPatchArguments rejects', async () => {
    ensureApplyPatchMock.mockImplementationOnce(() => {
      throw new Error('apply_patch arguments missing patch/input');
    });
    const ResponsesHttpProvider = await importResponsesProvider();
    const provider = new ResponsesHttpProvider({
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        baseUrl: 'https://api.test.local/v1',
        model: 'gpt-test',
        auth: { type: 'apikey', apiKey: 'test' }
      }
    }, deps);
    await provider.initialize();

    const body = {
      input: [
        { type: 'function_call', name: 'apply_patch', arguments: '{}' }
      ]
    };

    await expect((provider as any).maybeConvertChatPayload(body)).rejects.toThrow(/apply_patch arguments missing/i);
  });
});
