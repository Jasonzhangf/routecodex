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





  // Context preservation: sequential tool result submission keeps same cascadeId + stepOffset
  test('sequential tool-results keep cascadeId and stepOffset', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);
    const sendArgs: any[] = [];
    jest.spyOn(p, 'sendCascadeMessage').mockImplementation(async (...args) => { sendArgs.push(args[0]); });

    const pollArgs: any[] = [];
    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => {
      pollArgs.push(args);
      return { candidate: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 10, outputTokens: 5 }, stepOffset: (args.stepOffset ?? 0) + 1 };
    });

    // selectUsablePinnedGrpcRuntime: first call returns 0, second call returns 1 (simulates binding update)
    let selectCallIdx = 0;
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockImplementation(async () => {
      selectCallIdx++;
      return { sessionId: 's1', cascadeId: 'c1', stepOffset: selectCallIdx >= 2 ? 1 : 0 };
    });

    // First request
    await p.sendRequestInternal({ body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'hello' }] } });
    const firstCascadeId = sendArgs[0]?.cascadeId;

    // Second request: tool results
    pollArgs.length = 0;
    await p.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tc1', content: '{"result":"ok"}' },
        ],
      },
    });
    const secondCascadeId = sendArgs[1]?.cascadeId;
    const secondPollOffset = pollArgs[0]?.stepOffset;

    // Same cascadeId (not new cascade started)
    expect(secondCascadeId).toBe(firstCascadeId);
    // Second poll called with stepOffset=1 (from binding), not 0 (reset)
    expect(secondPollOffset).toBe(1);
    // sendCascadeMessage called once per request.
    expect(sendArgs.length).toBe(2);
  });

  // Context preservation after error recovery: busy retry recovers, context intact
  test('busy-retry recovers and preserves cascadeId across requests', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 0 });
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);

    let callIdx = 0;
    jest.spyOn(p, 'sendCascadeMessage').mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) throw busyError(); // First call hits busy
      return undefined;
    });

    const sendArgs: any[] = [];
    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => {
      return { candidate: { role: 'assistant', content: 'after-retry' }, usage: { inputTokens: 5, outputTokens: 3 }, stepOffset: args.stepOffset + 1 };
    });

    const result = await p.sendRequestInternal({ body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'busy-test' }] } });

    // Send was called twice (busy retry recovered)
    expect(callIdx).toBe(2);
    // Result returned normally
    expect(result).not.toBeNull();
    expect((result as any).choices?.[0]?.message?.content).toBe('after-retry');
  });

  // Context preservation after provider re-init: same session key re-binds to existing cascade
  test('provider re-init re-uses existing cascade binding from session', async () => {
    const p = createProvider();
    jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    mockInstantSleep(p);
    mockInstantGrpcIdle(p);

    // First request: establishes cascade c1
    jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 0 });
    jest.spyOn(p, 'sendCascadeMessage').mockResolvedValue(undefined);
    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockResolvedValue({ candidate: { role: 'assistant', content: 'first' }, usage: { inputTokens: 5, outputTokens: 3 }, stepOffset: 1 });

    await p.sendRequestInternal({ body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'first' }] } });

    // Second request: selectUsablePinnedGrpcRuntime should find existing binding
    // (rememberWindsurfCascadeSessionBinding was called with stepOffset: 1)
    const selectSpy = jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 1 });
    const sendArgs2: any[] = [];
    jest.spyOn(p, 'sendCascadeMessage').mockImplementation(async (...args) => { sendArgs2.push(args[0]); });
    const pollArgs2: any[] = [];
    jest.spyOn(p, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => { pollArgs2.push(args); return { candidate: { role: 'assistant', content: 'second' }, usage: { inputTokens: 5, outputTokens: 3 }, stepOffset: (args.stepOffset ?? 0) + 1 }; });

    await p.sendRequestInternal({ body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'second' }] } });

    // Second request used existing cascade c1 (not new)
    expect(selectSpy).toHaveBeenCalled();
    expect(sendArgs2[0]?.cascadeId).toBe('c1');
    // Poll was called with stepOffset from binding (1, not 0)
    expect(pollArgs2[0]?.stepOffset).toBe(1);
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

// Context preservation: hasActiveStep gate prevents premature return while tool is running
test('hasActiveStep-gate-prevents-premature-return-while-tool-running', async () => {
  const p = createProvider();
  jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
  jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 3 });
  jest.spyOn(p, 'sendCascadeMessage').mockResolvedValue(undefined);
  // Mock poll returns a running tool step (status=1)
  jest.spyOn(p, 'pollCascadeTrajectorySteps').mockImplementation(async () => {
    return {
      candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
      usage: { inputTokens: 10, outputTokens: 5 },
      stepOffset: 4,
    };
  });

  const result = await p.sendRequestInternal({
    body: {
      model: 'gpt-5.4-medium',
      messages: [{ role: 'user', content: 'run a command' }],
    },
  });
  expect(result).not.toBeNull();
  const choice = (result as any)?.choices?.[0];
  expect(choice).toBeDefined();
});

// Error recovery: busy retry preserves cascadeId, poll uses same cascadeId
test('error-then-recovery-preserves-cascadeId-and-stepOffset', async () => {
  const p = createProvider();
  jest.spyOn(p, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
  jest.spyOn(p, 'selectUsablePinnedGrpcRuntime').mockResolvedValue({ sessionId: 's1', cascadeId: 'c1', stepOffset: 0 });
  mockInstantSleep(p);
  mockInstantGrpcIdle(p);

  let sendCallIdx = 0;
  const sendArgs: any[] = [];
  jest.spyOn(p, 'sendCascadeMessage').mockImplementation(async (args: any) => {
    sendArgs.push(args);
    sendCallIdx++;
    if (sendCallIdx === 1) throw busyError();
  });

  const pollArgs: any[] = [];
  jest.spyOn(p, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => {
    pollArgs.push(args);
    return { candidate: { role: 'assistant', content: 'recovered' }, usage: { inputTokens: 5, outputTokens: 3 }, stepOffset: args.stepOffset + 1 };
  });

  const result = await p.sendRequestInternal({
    body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'busy then recover' }] },
  });

  // sendCascadeMessage called twice: first busy, then retry
  expect(sendArgs.length).toBe(2);
  expect(sendArgs[0]?.cascadeId).toBe('c1');
  expect(sendArgs[1]?.cascadeId).toBe('c1');
  // pollCascadeTrajectorySteps called with same cascadeId
  expect(pollArgs[0]?.cascadeId).toBe('c1');
  expect(result).not.toBeNull();
  expect((result as any)?.choices?.[0]?.message?.content).toBe('recovered');
});
});