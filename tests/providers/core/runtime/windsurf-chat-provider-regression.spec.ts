import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider regression tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('WindsurfChatProvider regression matrix', () => {
  const createdProviders: any[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdProviders.map(async (provider) => {
      if (provider && typeof provider.dispose === 'function') {
        await provider.dispose();
      }
    }));
    createdProviders.length = 0;
    jest.clearAllMocks();
  });

  async function loadProvider() {
    const mod = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts');
    return mod.WindsurfChatProvider;
  }

  async function createProvider(auth: Record<string, unknown> = { type: 'apikey', apiKey: 'devin-session-token$test', rawType: 'windsurf-devin-token' }) {
    const WindsurfChatProvider = await loadProvider();
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth,
      },
    } as any, deps) as any;
    createdProviders.push(provider);
    return provider;
  }

  test('dispatches request into cascade provider mainline with selected key and trajectory', async () => {
    const provider = await createProvider({ type: 'apikey', apiKey: 'devin-session-token$dispatch', rawType: 'windsurf-devin-token' });
    const fetchSpy = jest.spyOn(provider, 'fetchWithTimeout');
    const sendSpy = jest.spyOn(provider, 'sendCascadeMessage').mockResolvedValue(undefined as never);
    jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$dispatch' as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 'session-dispatch', cascadeId: 'cascade-dispatch' } as never);
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'dispatch-ok' },
      usage: { inputTokens: 11, outputTokens: 3 },
    } as never);
    const completion = await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'say hi' }],
      },
    });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'devin-session-token$dispatch',
      cascadeId: 'cascade-dispatch',
      sessionId: 'session-dispatch',
      modelUid: 'gpt-5-4-medium',
      text: 'say hi',
    }));
    expect(completion).toMatchObject({
      choices: [{ message: { role: 'assistant', content: 'dispatch-ok' }, finish_reason: 'stop' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('transient cascade retry must keep the same selected Windsurf account for one request', async () => {
    const provider = await createProvider({ type: 'apikey', apiKey: 'devin-session-token$pinned', rawType: 'windsurf-devin-token' });
    const resolveSpy = jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$pinned' as never);
    const sendSpy = jest.spyOn(provider, 'sendCascadeMessage')
      .mockRejectedValueOnce(Object.assign(new Error('temporary upstream reset'), {
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      }) as never)
      .mockResolvedValueOnce(undefined as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-pinned', cascadeId: 'cascade-pinned' } as never);
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'retry-ok' },
      usage: { inputTokens: 11, outputTokens: 3 },
    } as never);

    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'retry once' }],
      },
    });

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: 'devin-session-token$pinned' }));
    expect(sendSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: 'devin-session-token$pinned' }));
  });



  test('RED: materialized responses continuation without explicit session ids must not reset windsurf trajectory as new session', async () => {
    const provider = await createProvider({ type: 'apikey', apiKey: 'devin-session-token$cont', rawType: 'windsurf-devin-token' });
    (provider as any).windsurfPinnedCascade = { runtime: { lsPort: 42101 }, sessionId: 'session-pinned', cascadeId: 'cascade-pinned' };
    const resetSpy = jest.spyOn(provider as any, 'resetWindsurfCascadeTransportState');
    const sendSpy = jest.spyOn(provider, 'sendCascadeMessage').mockResolvedValue(undefined as never);
    jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$cont' as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-pinned', cascadeId: 'cascade-pinned' } as never);
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'continuation-ok' },
      usage: { inputTokens: 10, outputTokens: 2 },
    } as never);
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: '继续，不带 previous_response_id' }],
        semantics: {
          responses: {
            resume: {
              materialized: true,
              previousRequestId: 'req_prev_materialized_1',
              restoredFromResponseId: 'resp_prev_materialized_1',
            },
          },
        },
      },
    });

    expect(resetSpy).not.toHaveBeenCalledWith('new-session-without-key-trajectory-reset');
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      cascadeId: 'cascade-pinned',
      sessionId: 'session-pinned',
    }));
  });

  test('maps cascade tool-call candidate into provider response contract', async () => {
    const provider = await createProvider();
    const completion = provider.buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_response_1',
          type: 'function',
          function: { name: 'test_echo', arguments: '{"text":"ok"}' },
        }],
      },
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
    });

    expect(completion).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_response_1',
            type: 'function',
            function: { name: 'test_echo', arguments: '{"text":"ok"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
  });

  test('selects Windsurf auth entries internally and rotates after account failure', async () => {
    const provider = await createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-a', apiKey: 'devin-session-token$a' },
        { alias: 'ws-b', apiKey: 'devin-session-token$b' },
      ],
    });
    jest.spyOn(provider, 'fetchWindsurfUserStatusForHealth').mockResolvedValue(null as never);
    const managed = await provider.readManagedWindsurfAuthConfigDetailed();

    const first = await provider.selectWindsurfAccount(managed);
    const sticky = await provider.selectWindsurfAccount(managed);
    provider.clearManagedWindsurfSessionCredential();
    const second = await provider.selectWindsurfAccount(managed);

    expect(first.accountAlias).toBe('ws-a');
    expect(sticky.accountAlias).toBe('ws-a');
    expect(second.accountAlias).toBe('ws-b');
    expect(provider.windsurfUnavailableAccounts.has('ws-a')).toBe(true);
  });
});
