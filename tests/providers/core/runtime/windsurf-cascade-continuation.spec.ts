import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('Windsurf cascade continuation — same session multi-turn alignment', () => {
  const createdProviders: any[] = [];
  let WindsurfChatProvider: any;

  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  afterEach(async () => {
    await Promise.allSettled(createdProviders.map(async (p: any) => {
      if (p && typeof p.dispose === 'function') await p.dispose();
    }));
    createdProviders.length = 0;
    jest.clearAllMocks();
  });

  function createProvider(): any {
    const p = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$test', rawType: 'windsurf-devin-token' },
      },
    } as any, deps) as any;
    createdProviders.push(p);
    return p;
  }

  
function mockTrajectoryStatusProto(status: number): Buffer {
  // Proto field 2, wire type 0 (varint): tag = (2 << 3) | 0 = 16
  const tag = Buffer.from([16]);
  const val = Buffer.from([status]);
  return Buffer.concat([tag, val]);
}

function mockInstantGrpcIdle(p: any): void {
  jest.spyOn(p, "grpcUnaryLocal").mockResolvedValue(mockTrajectoryStatusProto(1));
}


function buildMockTrajectorySteps(lines: string[], toolCalls: any[] = []): Buffer {
  const parts: Buffer[] = [];
  for (const text of lines) {
    const tag = Buffer.from([(2 << 3) | 2]);
    const val = Buffer.from(text, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(val.length, 0);
    parts.push(Buffer.concat([tag, len, val]));
  }
  for (const tc of toolCalls) {
    const funcCall = JSON.stringify(tc.function || tc);
    const innerTag = Buffer.from([(1 << 3) | 2]);
    const innerVal = Buffer.from(funcCall, 'utf8');
    const innerLen = Buffer.alloc(4);
    innerLen.writeUInt32BE(innerVal.length, 0);
    const innerBuf = Buffer.concat([innerTag, innerLen, innerVal]);
    const outerTag = Buffer.from([(8 << 3) | 2]);
    const outerLen = Buffer.alloc(4);
    outerLen.writeUInt32BE(innerBuf.length, 0);
    parts.push(Buffer.concat([outerTag, outerLen, innerBuf]));
  }
  return Buffer.concat(parts);
}
function mockInstantSleep(provider: any): void {
    jest.spyOn(provider, 'sleepWindsurfCascadeBusyRetry').mockResolvedValue(undefined);
  }

  function busyError(): Error {
    return Object.assign(new Error('executor is not idle: CASCADE_RUN_STATUS_RUNNING'), {
      code: 'WINDSURF_CASCADE_BUSY',
      status: 429,
      retryable: true,
    });
  }

  test('same-session-reuses-cascade', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });
    jest.spyOn(p, 'sendCascadeMessage').mockResolvedValue(undefined);
    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'hello' }] },
    });
    await p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'bye' }] },
    });

    expect(p.sendCascadeMessage).toHaveBeenCalledTimes(2);
    expect(p.sendCascadeMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ cascadeId: 'c1' }));
    expect(p.sendCascadeMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ cascadeId: 'c1' }));
  });

  test('running-error-triggers-bounded-retry', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });

    const sendSpy = jest.spyOn(p, 'sendCascadeMessage')
      .mockRejectedValueOnce(busyError())
      .mockResolvedValue(undefined);

    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);

    await p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'retry me' }] },
    });

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  test('retry-uses-same-cascade-id', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });

    const sendArgs: any[] = [];
    jest.spyOn(p, 'sendCascadeMessage')
      .mockRejectedValueOnce(busyError())
      .mockImplementation(async (...args: any[]) => { sendArgs.push(args[0]); return undefined; });
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);

    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'stay on c1' }] },
    });

    expect(sendArgs[0].cascadeId).toBe('c1');
  });

  test('retry-success-preserves-stepOffset', async () => {
    const p = createProvider();
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 3 });

    jest.spyOn(p, 'sendCascadeMessage')
      .mockRejectedValueOnce(busyError())
      .mockResolvedValue(undefined);

    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'step offset check' }] },
    });

    expect(p.pollCascadeTrajectorySteps).toHaveBeenCalledWith(expect.objectContaining({ cascadeId: 'c1', stepOffset: 3 }));
    expect(result).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
  });

  test('retry-timeout-returns-explicit-busy', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });

    jest.spyOn(p, 'sendCascadeMessage').mockRejectedValue(busyError());
    mockInstantSleep(p);

    await expect(p.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'timeout test' }] },
    })).rejects.toMatchObject({ code: 'WINDSURF_CASCADE_BUSY', status: 429 });
  });

  test('busy-does-not-call-account-failure', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });
    jest.spyOn(p, 'sendCascadeMessage').mockRejectedValue(busyError());
    mockInstantSleep(p);

    const pool = { markQuotaExhausted: jest.fn(), markAuthInvalid: jest.fn(), markRuntimeFailure: jest.fn() };
    (p as any).windsurfAccountPool = pool;

    try {
      await p.sendRequestInternal({
        body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'no account fail' }] },
      });
    } catch {}

    expect(pool.markQuotaExhausted).not.toHaveBeenCalled();
    expect(pool.markAuthInvalid).not.toHaveBeenCalled();
    expect(pool.markRuntimeFailure).not.toHaveBeenCalled();
  });



  test('running-does-not-trigger-rebuild', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1' });
    jest.spyOn(p, 'sendCascadeMessage').mockRejectedValue(busyError());
    mockInstantSleep(p);

    const startSpy = jest.spyOn(p, 'sendStartCascade');

    try {
      await p.sendRequestInternal({
        body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'no rebuild' }] },
      });
    } catch {}

    expect(startSpy).not.toHaveBeenCalled();
  });
});
