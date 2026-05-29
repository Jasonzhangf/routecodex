import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf context tests'); },
}));

const TEST_STORE_DIR = path.join(os.tmpdir(), 'rcc-windsurf-test-' + Date.now());
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, 'accounts.json');

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('Windsurf context continuity — sticky session + delta growth', () => {
  let WindsurfChatProvider: any;
  let attachProviderRuntimeMetadata: any;
  const createdProviders: any[] = [];

  beforeAll(async () => {
    process.env.ROUTECODEX_WINDSURF_ACCOUNT_STORE_PATH = TEST_STORE_PATH;
    await fs.mkdir(TEST_STORE_DIR, { recursive: true });
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
    ({ attachProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.ts'));
  });

  afterAll(async () => {
    delete process.env.ROUTECODEX_WINDSURF_ACCOUNT_STORE_PATH;
    await fs.rm(TEST_STORE_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await Promise.allSettled(createdProviders.map(async (p: any) => {
      if (p && typeof p.dispose === 'function') await p.dispose();
    }));
    createdProviders.length = 0;
    jest.clearAllMocks();
    jest.useRealTimers();
    // Reset store between tests
    await fs.writeFile(TEST_STORE_PATH, JSON.stringify({ version: 1, accounts: [] }), 'utf8').catch(() => {});
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

  test('RED: previous_response_id must not replace stable Windsurf session key', () => {
    const provider = createProvider();
    const request = {
      body: { previous_response_id: 'resp_prev_001' },
    } as Record<string, unknown>;
    attachProviderRuntimeMetadata(request, {
      metadata: { sessionId: 'codex-session-stable' },
    });

    expect((provider as any).resolveWindsurfSessionStateKeyFromRequest(request)).toBe('codex-session-stable');
  });

  test('RED: changing previous_response_id under one session reuses one cascade and offset', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$previous-id-delta' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions')
      .mockResolvedValue({ lsPort: 42101, csrfToken: 'csrf-session', sessionId: 'configured-session' } as never);
    const startSpy = jest.spyOn(provider, 'sendStartCascade')
      .mockResolvedValue('cascade-session-prev-stable' as never);
    jest.spyOn(provider, 'sendCascadeMessage').mockResolvedValue(undefined as never);
    const pollSpy = jest.spyOn(provider, 'pollCascadeTrajectorySteps')
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: 'first' },
        usage: { inputTokens: 4, outputTokens: 1 },
        stepOffset: 4,
      } as never)
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: 'second' },
        usage: { inputTokens: 6, outputTokens: 1 },
        stepOffset: 7,
      } as never);

    const round1 = {
      body: { model: 'gpt-5.4-medium', previous_response_id: 'resp_first', messages: [{ role: 'user', content: 'first turn' }] },
    } as Record<string, unknown>;
    attachProviderRuntimeMetadata(round1, { metadata: { sessionId: 'codex-session-stable' } });
    const round2 = {
      body: { model: 'gpt-5.4-medium', previous_response_id: 'resp_second', messages: [{ role: 'user', content: 'second turn' }] },
    } as Record<string, unknown>;
    attachProviderRuntimeMetadata(round2, { metadata: { sessionId: 'codex-session-stable' } });

    await provider.sendRequestInternal(round1);
    await provider.sendRequestInternal(round2);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(pollSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ cascadeId: 'cascade-session-prev-stable', stepOffset: 0 }));
    expect(pollSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ cascadeId: 'cascade-session-prev-stable', stepOffset: 4 }));
  });

  test('session: same request session reuses one cascade and advances trajectory offset', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$session' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions')
      .mockResolvedValue({ lsPort: 42101, csrfToken: 'csrf-session', sessionId: 'configured-session' } as never);
    const startSpy = jest.spyOn(provider, 'sendStartCascade')
      .mockResolvedValue('cascade-session-1' as never);
    const sendCalls: Array<Record<string, unknown>> = [];
    jest.spyOn(provider, 'sendCascadeMessage')
      .mockImplementation(async (args: unknown) => {
        sendCalls.push(args as Record<string, unknown>);
      });
    const pollSpy = jest.spyOn(provider, 'pollCascadeTrajectorySteps')
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: 'first' },
        usage: { inputTokens: 4, outputTokens: 1 },
        stepOffset: 3,
      } as never)
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: 'second' },
        usage: { inputTokens: 6, outputTokens: 1 },
        stepOffset: 5,
      } as never);

    await provider.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', session_id: 'ws-session-1', messages: [{ role: 'user', content: 'first turn' }] },
    });
    await provider.sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        session_id: 'ws-session-1',
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first' },
          { role: 'user', content: 'second turn' },
        ],
      },
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]).toMatchObject({ cascadeId: 'cascade-session-1', sessionId: expect.any(String) });
    expect(sendCalls[1]).toMatchObject({ cascadeId: 'cascade-session-1', sessionId: sendCalls[0].sessionId });
    expect(pollSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ cascadeId: 'cascade-session-1', stepOffset: 0 }));
    expect(pollSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ cascadeId: 'cascade-session-1', stepOffset: 3 }));
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

    const managed = await provider.readManagedWindsurfAuthConfig();
    expect(managed).not.toBeNull();
    expect(managed.cfg.entries).toHaveLength(2);

    // First selection picks ws-primary (first entry, equal ranking)
    const first = await provider.selectWindsurfAccount(managed);
    expect(first.accountAlias).toBe('ws-primary');

    // Second call — sticky binding keeps same account
    const sticky = await provider.selectWindsurfAccount(managed);
    expect(sticky.accountAlias).toBe('ws-primary');

    // After clearing credential, ws-primary is marked auth-invalid in pool
    expect(provider.windsurfSessionCredential?.accountAlias).toBe('ws-primary');
    provider.clearManagedWindsurfSessionCredential();
    expect(provider.windsurfSessionCredential).toBeNull();

    // Third call — pool skips ws-primary (auth-invalid) and picks ws-backup
    const rotated = await provider.selectWindsurfAccount(managed);
    expect(rotated.accountAlias).toBe('ws-backup');

    // Fourth call — sticky binding keeps ws-backup
    const stillBackup = await provider.selectWindsurfAccount(managed);
    expect(stillBackup.accountAlias).toBe('ws-backup');
  });

  test('account selection ranks by extra quota, skips auth-invalid, and follows sticky binding', async () => {
    const provider = createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-normal', apiKey: 'devin-session-token$normal' },
        { alias: 'ws-extra', apiKey: 'devin-session-token$extra', extra: true },
        { alias: 'ws-backup', apiKey: 'devin-session-token$backup' },
      ],
    });

    const managed = await provider.readManagedWindsurfAuthConfig();
    expect(managed).not.toBeNull();
    expect(managed.cfg.entries).toHaveLength(3);

    // First selection picks ws-extra (extra=true ranks higher)
    const first = await provider.selectWindsurfAccount(managed);
    expect(first.accountAlias).toBe('ws-extra');

    // Second call — sticky, same account
    const sticky = await provider.selectWindsurfAccount(managed);
    expect(sticky.accountAlias).toBe('ws-extra');

    // Mark ws-extra as auth-invalid → pool skips it
    provider.clearManagedWindsurfSessionCredential();
    expect(provider.windsurfSessionCredential).toBeNull();

    // Third call — pool skips ws-extra (auth-invalid), picks next available in order
    const rotated = await provider.selectWindsurfAccount(managed);
    expect(rotated.accountAlias).toBe('ws-normal');

    // Fourth call — sticky on ws-normal
    const stillNormal = await provider.selectWindsurfAccount(managed);
    expect(stillNormal.accountAlias).toBe('ws-normal');
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
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
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
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
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
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
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

  test('RED: resumed cascade sends only latest delta text, not full replay history', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$resume-delta' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions')
      .mockResolvedValue({ lsPort: 42103, csrfToken: 'csrf-test' } as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-resume-delta', cascadeId: 'cascade-resume-delta', stepOffset: 4 } as never);

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
      .mockResolvedValue({
        candidate: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 5, outputTokens: 1 },
        stepOffset: 5,
      } as never);

    await provider.sendRequestInternal({
      body: {
        model: 'kimi-k2-6',
        messages: [
          { role: 'user', content: 'old user request with very large context' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '/Users/fanzhang/Documents/github/routecodex' },
          { role: 'user', content: 'continue from tool result' },
        ],
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      },
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].additionalSteps).toHaveLength(1);
    expect(sendCalls[0].text).toContain('continue from tool result');
    expect(sendCalls[0].text).not.toContain('Cascade native tool name mapping');
    expect(sendCalls[0].text).not.toContain('exec_command');
    expect(sendCalls[0].text).not.toContain('Tool result for');
    expect(sendCalls[0].text).not.toContain('/Users/fanzhang/Documents/github/routecodex');
    expect(sendCalls[0].text).not.toContain('The following is a multi-turn conversation');
    expect(sendCalls[0].text).not.toContain('old user request with very large context');
    expect(sendCalls[0].text).not.toContain('<assistant>');
  });

  test('RED: fresh cascade send also uses latest delta text, not full replay history', async () => {
    const provider = createProvider();

    jest.spyOn(provider, 'resolveCascadeApiKey')
      .mockResolvedValue('devin-session-token$fresh-delta' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions')
      .mockResolvedValue({ lsPort: 42104, csrfToken: 'csrf-test' } as never);
    jest.spyOn(provider, 'selectUsablePinnedGrpcRuntime')
      .mockResolvedValue({ sessionId: 'session-fresh-delta', cascadeId: 'cascade-fresh-delta', stepOffset: 0 } as never);

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
      .mockResolvedValue({
        candidate: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 5, outputTokens: 1 },
        stepOffset: 6,
      } as never);

    await provider.sendRequestInternal({
      body: {
        model: 'kimi-k2-6',
        messages: [
          { role: 'system', content: 'The assistant is a coding tool. '.repeat(500) },
          { role: 'user', content: 'old user request with huge AGENTS context' },
          { role: 'assistant', content: 'old assistant response that must not replay' },
          { role: 'user', content: 'continue only this latest user delta' },
        ],
      },
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toBe('continue only this latest user delta');
    expect(sendCalls[0].additionalSteps).toHaveLength(0);
    expect(sendCalls[0].text).not.toContain('The assistant is a coding tool');
    expect(sendCalls[0].text).not.toContain('old user request');
    expect(sendCalls[0].text).not.toContain('old assistant response');
    expect(sendCalls[0].text).not.toContain('The following is a multi-turn conversation');
  });

  test('delta: materialized resume delta input is appended to the latest user prompt without replaying full prior output', () => {
    const provider = createProvider();
    const body = {
      input: [{ type: 'input_text', text: 'latest user asks for summary' }],
      semantics: {
        responses: {
          resume: {
            materialized: true,
            deltaInput: [
              { type: 'function_call_output', call_id: 'call_delta', output: 'delta tool result only' },
            ],
          },
        },
      },
    };
    const messages = [
      { role: 'user', content: 'latest user asks for summary' },
    ];
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(messages);
    const text = (provider as any).buildCascadePromptText(
      messages,
      semantic,
      'gpt-5-5-low',
      [],
      (provider as any).readDeltaSeedParts(body),
    );

    expect(text).toContain('latest user asks for summary');
    expect(text).toContain('Tool result for call_delta:\ndelta tool result only');
    expect(text).not.toContain('prior assistant full output that should not be replayed');
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
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
        usage: { inputTokens: 5, outputTokens: 1 },
      } as never)
      .mockResolvedValueOnce({
        candidate: { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'exec_command', arguments: '{"command":"ls"}' } }] },
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
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
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
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file content: data' },
          { role: 'user', content: 'list directory' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'exec_command', arguments: '{"command":"ls"}' } }] },
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
