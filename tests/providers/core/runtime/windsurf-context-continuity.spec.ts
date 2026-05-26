import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf context tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('Windsurf context continuity — sticky session + delta growth', () => {
  let WindsurfChatProvider: any;
  const createdProviders: any[] = [];

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

  function createProvider(auth?: Record<string, unknown>) {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: auth ?? { type: 'apikey', apiKey: 'devin-session-token$sticky', rawType: 'windsurf-devin-token' },
      },
    } as any, deps) as any;
    createdProviders.push(provider);
    return provider;
  }

  // --- Test 1: Sticky session ---

  test('sticky: consecutive sendRequestInternal calls use same account key and cascadeId across rounds', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$sticky' as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-sticky-1', cascadeId: 'cascade-sticky-1' } as never);

    const sendCalls: Array<Record<string, unknown>> = [];
    jest.spyOn(provider, 'sendCascadeMessage')
      .mockImplementation(async (args: unknown) => {
        sendCalls.push(args as Record<string, unknown>);
      });

    jest.spyOn(provider, 'pollCascadeTrajectorySteps')
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.txt"}' } }] },
        usage: { inputTokens: 10, outputTokens: 2 },
      } as never)
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: 'file content: hello world' },
        usage: { inputTokens: 20, outputTokens: 5 },
      } as never);

    const round1 = await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'read test.txt' }],
      },
    });

    const round2 = await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read test.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: hello' },
          { role: 'user', content: 'what is the content' },
        ],
      },
    });

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0].apiKey).toBe('devin-session-token$sticky');
    expect(sendCalls[1].apiKey).toBe('devin-session-token$sticky');
    expect(sendCalls[0].cascadeId).toBe('cascade-sticky-1');
    expect(sendCalls[1].cascadeId).toBe('cascade-sticky-1');

    expect(round1).toMatchObject({
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_1' }] }, finish_reason: 'tool_calls' }],
    });
    expect(round2).toMatchObject({
      choices: [{ message: { role: 'assistant', content: 'file content: hello world' }, finish_reason: 'stop' }],
    });
  });

  // --- Test 2: Account rotation ---

  test('sticky: account rotates after clearManagedWindsurfSessionCredential', async () => {
    const provider = createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-primary', apiKey: 'devin-session-token$primary' },
        { alias: 'ws-backup', apiKey: 'devin-session-token$backup' },
      ],
    });

    const managed = provider.readManagedWindsurfAuthConfigDetailed();
    expect(managed).not.toBeNull();

    const first = await provider.selectWindsurfAccount(managed);
    expect(first.accountAlias).toBe('ws-primary');

    const sticky = await provider.selectWindsurfAccount(managed);
    expect(sticky.accountAlias).toBe('ws-primary');

    provider.clearManagedWindsurfSessionCredential();
    expect(provider.windsurfUnavailableAccounts.has('ws-primary')).toBe(true);

    const rotated = await provider.selectWindsurfAccount(managed);
    expect(rotated.accountAlias).toBe('ws-backup');

    const stillBackup = await provider.selectWindsurfAccount(managed);
    expect(stillBackup.accountAlias).toBe('ws-backup');
  });

  // --- Test 3: Delta context growth (single tool, text-only followup) ---

  test('delta: context grows incrementally across round-trips', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$delta' as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-delta', cascadeId: 'cascade-delta' } as never);

    const sendCalls: Array<{ text: string; additionalSteps: unknown[] }> = [];
    jest.spyOn(provider, 'sendCascadeMessage')
      .mockImplementation(async (args: unknown) => {
        const a = args as Record<string, unknown>;
        sendCalls.push({
          text: a.text as string,
          additionalSteps: a.additionalSteps as unknown[],
        });
      });

    jest.spyOn(provider, 'pollCascadeTrajectorySteps')
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
        usage: { inputTokens: 5, outputTokens: 1 },
      } as never)
      .mockResolvedValue({
        candidate: { role: 'assistant', content: 'done' },
        usage: { inputTokens: 25, outputTokens: 3 },
      } as never);

    // Round 1: first user message → tool_call
    await provider.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'read file.txt' }] },
    });

    // Round 2: tool result + followup → text
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read file.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: hello world' },
          { role: 'user', content: 'summarize the file' },
        ],
      },
    });

    // Round 3: more text continuation (assistant → user)
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read file.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: hello world' },
          { role: 'user', content: 'summarize the file' },
          { role: 'assistant', content: 'The file says hello' },
          { role: 'user', content: 'write a poem about it' },
        ],
      },
    });

    expect(sendCalls).toHaveLength(3);

    // Round 1: user text only, no additional steps
    expect(sendCalls[0].text).toMatch(/read file\.txt/);
    expect(sendCalls[0].additionalSteps).toHaveLength(0);

    // Round 2: text grew vs round 1 (added tool result + followup user message)
    expect(sendCalls[1].text.length).toBeGreaterThan(sendCalls[0].text.length);
    expect(sendCalls[1].additionalSteps).toHaveLength(1);

    // Round 3: text grew again vs round 2 (assistant reply + more user text)
    expect(sendCalls[2].text.length).toBeGreaterThan(sendCalls[1].text.length);
    expect(sendCalls[2].additionalSteps).toHaveLength(1);
  });

  // --- Test 4: Multi-round tool accumulation with two different native tools ---

  test('delta: multi-round native tool results accumulate without loss', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$multi' as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-multi', cascadeId: 'cascade-multi' } as never);

    const sendCalls: Array<{ text: string; additionalSteps: unknown[] }> = [];
    jest.spyOn(provider, 'sendCascadeMessage')
      .mockImplementation(async (args: unknown) => {
        const a = args as Record<string, unknown>;
        sendCalls.push({
          text: a.text as string,
          additionalSteps: a.additionalSteps as unknown[],
        });
      });

    // Round 1 → read_file tool, Round 2 → exec_command tool, Round 3 → text
    jest.spyOn(provider, 'pollCascadeTrajectorySteps')
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
        usage: { inputTokens: 5, outputTokens: 1 },
      } as never)
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
        usage: { inputTokens: 15, outputTokens: 2 },
      } as never)
      .mockResolvedValue({
        candidate: { role: 'assistant', content: 'all done' },
        usage: { inputTokens: 35, outputTokens: 5 },
      } as never);

    // Round 1: user → read_file
    await provider.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'read file.txt' }] },
    });

    // Round 2: read_file result → user → exec_command
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read file.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: data' },
          { role: 'user', content: 'list directory' },
        ],
      },
    });

    // Round 3: exec_command result → text
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read file.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_file', arguments: '{"path":"file.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: data' },
          { role: 'user', content: 'list directory' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
          { role: 'tool', tool_call_id: 'call_2', content: 'file1.txt\nfile2.txt' },
          { role: 'user', content: 'finish' },
        ],
      },
    });

    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[0].additionalSteps).toHaveLength(0);

    // Round 2: 1 additional step for call_1 (read_file)
    expect(sendCalls[1].additionalSteps).toHaveLength(1);

    // Round 3: 2 additional steps (call_1 read_file + call_2 exec_command)
    expect(sendCalls[2].additionalSteps).toHaveLength(2);

    expect(sendCalls[2].text).toMatch(/finish/);
  });
});
