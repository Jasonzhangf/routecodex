import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

let WindsurfChatProvider: any;

describe('WindsurfChatProvider', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  beforeEach(() => {
  });

  test('preprocessRequest converts tools into tools_preamble', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-high',
        auth: { type: 'apikey', apiKey: 'test-key' },
      },
    } as any, deps);

    const processed = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-high',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
            },
          },
        ],
      },
    });

    expect(processed.body.tools).toBeUndefined();
    expect(processed.body.tools_preamble).toContain('[Available tools]');
    expect(processed.body.tools_preamble).toContain('exec_command');
  });

  test('windsurf-account resolves session token via login chain and caches it', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-auth-login-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$abc123', accountId: 'account-123' }),
    } as any);
    global.fetch = fetchMock as any;
    try {
      const provider = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-high',
          auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: '2094423@qq.com', password: 'welcome4zcam#', tokenFile },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { userExists: true, hasPassword: true } } as any)
        .mockResolvedValueOnce({ data: { token: 'auth1-token-123' } } as any);

      const first = await (provider as any).ensureWindsurfSessionCredential();
      const second = await (provider as any).ensureWindsurfSessionCredential();
      expect(first).toEqual({
        apiKey: 'devin-session-token$abc123',
        sessionToken: 'devin-session-token$abc123',
        auth1Token: 'auth1-token-123',
        accountId: 'account-123',
      });
      expect(second).toBe(first);
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((provider as any).readApiKey()).toBe('devin-session-token$abc123');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: persisted tokenFile session should be loaded without login', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-auth-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    await fs.writeFile(tokenFile, JSON.stringify({
      apiKey: 'devin-session-token$persisted-token',
      sessionToken: 'devin-session-token$persisted-token',
      auth1Token: 'persisted-auth1',
      accountId: 'account-persisted'
    }), 'utf8');

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: {
          type: 'apikey',
          apiKey: '',
          rawType: 'windsurf-account',
          account: 'persisted@example.com',
          password: 'secret',
          tokenFile,
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    const credential = await (provider as any).ensureWindsurfSessionCredential();

    expect(credential).toEqual({
      apiKey: 'devin-session-token$persisted-token',
      sessionToken: 'devin-session-token$persisted-token',
      auth1Token: 'persisted-auth1',
      accountId: 'account-persisted',
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('RED: login session should persist to tokenFile after postAuth', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-auth-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$persist-write', accountId: 'account-write' }),
    } as any);
    global.fetch = fetchMock as any;
    try {
      const provider = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-medium',
          auth: {
            type: 'apikey',
            apiKey: '',
            rawType: 'windsurf-account',
            account: 'persist@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { userExists: true, hasPassword: true } } as any)
        .mockResolvedValueOnce({ data: { token: 'auth1-token-write' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$persist-write',
        sessionToken: 'devin-session-token$persist-write',
        auth1Token: 'auth1-token-write',
        accountId: 'account-write',
      });
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$persist-write',
        sessionToken: 'devin-session-token$persist-write',
        auth1Token: 'auth1-token-write',
        accountId: 'account-write',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: direct devin session token auth must bypass password login and be used as final apiKey', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$direct-final-token', rawType: 'windsurf-account' },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    const credential = await (provider as any).ensureWindsurfSessionCredential();
    const apiKey = await (provider as any).resolveCascadeApiKey();

    expect(credential).toEqual({
      apiKey: 'devin-session-token$direct-final-token',
      sessionToken: 'devin-session-token$direct-final-token',
      auth1Token: '',
    });
    expect(apiKey).toBe('devin-session-token$direct-final-token');
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('RED: parseCascadeAssistantTurnSync parses assistant tool call candidate into openai tool_calls', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'tool_call', call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_read_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        },
      ],
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts upstream output_text blocks as assistant text', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'OK' },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: 'OK',
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts plain string assistant content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: 'OK',
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: 'OK',
    });
  });

  test('RED: parseCascadeAssistantTurnSync preserves mixed output_text + tool_call candidate blocks', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        { type: 'output_text', text: '我先读取文件。' },
        { type: 'tool_call', call_id: 'call_mix_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '我先读取文件。',
      tool_calls: [
        {
          id: 'call_mix_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        },
      ],
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts function_call candidate blocks into openai tool_calls', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        {
          type: 'function_call',
          call_id: 'call_fc_1',
          name: 'read',
          arguments: JSON.stringify({ filePath: '/tmp/fc.txt' }),
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_fc_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/fc.txt' }) },
        },
      ],
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts custom_tool_call candidate blocks into openai tool_calls', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        {
          type: 'custom_tool_call',
          call_id: 'call_custom_1',
          name: 'exec_command',
          input: 'pwd',
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_custom_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
        },
      ],
    });
  });

  test('RED: parseCascadeSemanticRoundtripSync restores tool_result history into function_call_output continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_read_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: 'A_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_read_1', name: 'read', output: 'A_CONTENT' },
    ]);
  });


  test('RED: parseCascadeSemanticRoundtripSync accepts assistant content[].type=tool_call history and preserves tool continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            call_id: 'call_hist_tool_call_1',
            name: 'read',
            arguments: { filePath: '/tmp/a.txt' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_tool_call_1', name: 'read', content: 'A_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_tool_call_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_tool_call_1', name: 'read', output: 'A_CONTENT' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts assistant content[].type=function_call history and preserves tool continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: 'A_CONTENT' },
      { role: 'user', content: '再读一遍' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_read_1', name: 'read', output: 'A_CONTENT' },
      { type: 'user', text: '再读一遍' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts assistant function_call history fallback id when call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/id-fallback.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            id: 'call_hist_id_only_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/id-fallback.txt' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_id_only_1', name: 'read', content: 'ID_ONLY_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/id-fallback.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_id_only_1', name: 'read', arguments: { filePath: '/tmp/id-fallback.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_id_only_1', name: 'read', output: 'ID_ONLY_CONTENT' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts assistant custom_tool_call history fallback id when call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '执行 pwd' },
      {
        role: 'assistant',
        content: [
          {
            type: 'custom_tool_call',
            id: 'call_hist_custom_id_only_1',
            name: 'exec_command',
            input: 'pwd',
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_custom_id_only_1', name: 'exec_command', content: '/tmp/project' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '执行 pwd' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_custom_id_only_1', name: 'exec_command', arguments: { input: 'pwd' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_custom_id_only_1', name: 'exec_command', output: '/tmp/project' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync preserves responses-style user content[] text blocks into cascade history', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '第一段。' },
          { type: 'text', text: '第二段。' },
          { type: 'output_text', text: '第三段。' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: '收到' }],
      },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '第一段。第二段。第三段。' },
      { type: 'assistant', text: '收到' },
    ]);
  });

  test('RED: sendRequestInternal preserves responses-style user content[] when building cascade conversation', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      },
    } as any);

    await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: '读取 ' },
              { type: 'text', text: '/tmp/a.txt' },
            ],
          },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: '读取 /tmp/a.txt' },
      ],
    });
  });


  test('RED: parseCascadeSemanticRoundtripSync preserves assistant output_text when chat tool_calls and content[] coexist in same turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          { type: 'output_text', text: '先读取文件。' },
        ],
        tool_calls: [{
          id: 'call_read_chat_and_blocks_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read_chat_and_blocks_1', name: 'read', content: 'A_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      {
        type: 'assistant',
        text: '先读取文件。',
        tool_calls: [{ call_id: 'call_read_chat_and_blocks_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_read_chat_and_blocks_1', name: 'read', output: 'A_CONTENT' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync preserves assistant content[].type=output_text alongside function_call history', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '先读文件再总结' },
      {
        role: 'assistant',
        content: [
          { type: 'output_text', text: '我先读取文件。' },
          {
            type: 'function_call',
            call_id: 'call_read_2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/b.txt' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_2', name: 'read', content: 'B_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '先读文件再总结' },
      {
        type: 'assistant',
        text: '我先读取文件。',
        tool_calls: [{ call_id: 'call_read_2', name: 'read', arguments: { filePath: '/tmp/b.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_read_2', name: 'read', output: 'B_CONTENT' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts assistant content[].type=custom_tool_call history and preserves tool continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '执行一段 shell' },
      {
        role: 'assistant',
        content: [
          {
            type: 'custom_tool_call',
            call_id: 'call_exec_1',
            name: 'exec_command',
            input: 'echo hello',
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_exec_1', name: 'exec_command', content: 'hello' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '执行一段 shell' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_exec_1', name: 'exec_command', arguments: { input: 'echo hello' } }],
      },
      { type: 'function_call_output', call_id: 'call_exec_1', name: 'exec_command', output: 'hello' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast on orphan tool result before matching assistant tool call', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: 'A_CONTENT' },
    ])).toThrow('[windsurf] orphan tool_result without matching assistant tool call');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast on repeated prior tool call after tool_result', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: 'A_CONTENT' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_read_1_b', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
      },
    ])).toThrow('[windsurf] upstream repeated prior tool call after tool_result');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast on duplicate tool_result for the same call after completion', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_read_dup', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
      },
      { role: 'tool', tool_call_id: 'call_read_dup', name: 'read', content: 'A_CONTENT' },
      { role: 'tool', tool_call_id: 'call_read_dup', name: 'read', content: 'A_CONTENT_AGAIN' },
    ])).toThrow('[windsurf] duplicate tool_result for completed tool call');
  });

  test('RED: parseCascadeToolResultTurnSync converts tool role message into function_call_output', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_read_1',
      name: 'read',
      content: 'A_CONTENT',
    }, new Map([['call_read_1', { name: 'read', signature: 'read:{"filePath":"/tmp/a.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_read_1',
      name: 'read',
      output: 'A_CONTENT',
    });
  });



  test('RED: parseCascadeToolResultTurnSync unwraps nested function_call_output block content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_tool_nested_fc_output_1',
      name: 'read',
      content: [
        { type: 'function_call_output', call_id: 'call_tool_nested_fc_output_1', output: 'BLOCK_DONE' },
      ],
    }, new Map([['call_tool_nested_fc_output_1', { name: 'read', signature: 'read:{"filePath":"/tmp/nested-fc-output.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_tool_nested_fc_output_1',
      name: 'read',
      output: 'BLOCK_DONE',
    });
  });


  test('RED: parseCascadeToolResultTurnSync unwraps nested tool_result block object content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_tool_nested_tool_result_obj_1',
      name: 'read',
      content: [
        { type: 'tool_result', tool_call_id: 'call_tool_nested_tool_result_obj_1', content: { ok: 1 } },
      ],
    }, new Map([['call_tool_nested_tool_result_obj_1', { name: 'read', signature: 'read:{"filePath":"/tmp/nested-tool-result-obj.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_tool_nested_tool_result_obj_1',
      name: 'read',
      output: JSON.stringify({ ok: 1 }),
    });
  });

  test('RED: sendRequestInternal preserves nested tool_result object-content history when building cascade conversation', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      },
    } as any);

    await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_read_nested_tool_result_obj_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
          {
            role: 'tool',
            tool_call_id: 'call_read_nested_tool_result_obj_1',
            name: 'read',
            content: [
              { type: 'tool_result', tool_call_id: 'call_read_nested_tool_result_obj_1', content: { ok: 1 } },
            ],
          },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: 'read /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_nested_tool_result_obj_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_nested_tool_result_obj_1', name: 'read', output: JSON.stringify({ ok: 1 }) },
      ],
    });
  });

  test('RED: parseCascadeToolResultTurnSync unwraps nested tool_result block content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_tool_nested_tool_result_1',
      name: 'read',
      content: [
        { type: 'tool_result', tool_call_id: 'call_tool_nested_tool_result_1', output: 'TOOL_BLOCK_OK' },
      ],
    }, new Map([['call_tool_nested_tool_result_1', { name: 'read', signature: 'read:{"filePath":"/tmp/nested-tool-result.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_tool_nested_tool_result_1',
      name: 'read',
      output: 'TOOL_BLOCK_OK',
    });
  });

  test('RED: sendRequestInternal preserves nested function_call_output block tool history when building cascade conversation', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      },
    } as any);

    await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_read_nested_fc_output_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
          {
            role: 'tool',
            tool_call_id: 'call_read_nested_fc_output_1',
            name: 'read',
            content: [
              { type: 'function_call_output', call_id: 'call_read_nested_fc_output_1', output: 'NESTED_DONE' },
            ],
          },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: 'read /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_nested_fc_output_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_nested_fc_output_1', name: 'read', output: 'NESTED_DONE' },
      ],
    });
  });

  test('RED: parseCascadeToolResultTurnSync normalizes tool text-block array content into plain output text', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_tool_blocks_1',
      name: 'read',
      content: [
        { type: 'text', text: 'LINE_A' },
        { type: 'output_text', text: 'LINE_B' },
      ],
    }, new Map([['call_tool_blocks_1', { name: 'read', signature: 'read:{"filePath":"/tmp/blocks.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_tool_blocks_1',
      name: 'read',
      output: 'LINE_ALINE_B',
    });
  });

  test('RED: sendRequestInternal preserves tool text-block array history when building cascade conversation', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      },
    } as any);

    await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_read_block_result_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
          {
            role: 'tool',
            tool_call_id: 'call_read_block_result_1',
            name: 'read',
            content: [
              { type: 'text', text: 'A_' },
              { type: 'output_text', text: 'CONTENT' },
            ],
          },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: 'read /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_block_result_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_block_result_1', name: 'read', output: 'A_CONTENT' },
      ],
    });
  });

  test('RED: parseCascadeToolResultTurnSync falls back to stringifying object tool content from real history variants', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      tool_call_id: 'call_read_2',
      name: 'read',
      content: { stdout: 'B_CONTENT', exit_code: 0 },
    }, new Map([['call_read_2', { name: 'read', signature: 'read:{"filePath":"/tmp/b.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_read_2',
      name: 'read',
      output: JSON.stringify({ stdout: 'B_CONTENT', exit_code: 0 }),
    });
  });


  test('RED: parseCascadeToolResultTurnSync falls back to nested function_call_output call_id when outer tool message id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      content: [
        { type: 'function_call_output', call_id: 'call_nested_result_id_1', output: 'NESTED_ID_OK' },
      ],
    }, new Map([['call_nested_result_id_1', { name: 'read', signature: 'read:{"filePath":"/tmp/nested-id.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_nested_result_id_1',
      name: 'read',
      output: 'NESTED_ID_OK',
    });
  });

  test('RED: parseCascadeToolResultTurnSync falls back to nested tool_result tool_use_id when outer tool message id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      content: [
        { type: 'tool_result', tool_use_id: 'call_nested_tool_use_id_1', content: 'TOOL_USE_ID_OK' },
      ],
    }, new Map([['call_nested_tool_use_id_1', { name: 'read', signature: 'read:{"filePath":"/tmp/nested-tool-use-id.txt"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_nested_tool_use_id_1',
      name: 'read',
      output: 'TOOL_USE_ID_OK',
    });
  });

  test('RED: sendRequestInternal preserves nested tool_result id fallback history when outer tool message id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{ role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
      },
    } as any);

    await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_nested_tool_use_id_send_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', tool_use_id: 'call_nested_tool_use_id_send_1', content: 'SEND_TOOL_USE_ID_OK' },
            ],
          },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: 'read /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_nested_tool_use_id_send_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_nested_tool_use_id_send_1', name: 'read', output: 'SEND_TOOL_USE_ID_OK' },
      ],
    });
  });

  test('RED: parseCascadeToolResultTurnSync accepts id fallback when tool_call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeToolResultTurnSync({
      role: 'tool',
      id: 'call_tool_id_fallback_1',
      name: 'read',
      content: 'ID_FALLBACK_CONTENT',
    }, new Map([['call_tool_id_fallback_1', { name: 'read', signature: 'read:{\"filePath\":\"/tmp/id-fallback.txt\"}' }]]));

    expect(parsed).toEqual({
      type: 'function_call_output',
      call_id: 'call_tool_id_fallback_1',
      name: 'read',
      output: 'ID_FALLBACK_CONTENT',
    });
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts type=custom_tool_call_output history as function_call_output continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '执行命令并返回结果' },
      {
        role: 'assistant',
        content: [
          {
            type: 'custom_tool_call',
            call_id: 'call_exec_2',
            name: 'exec_command',
            input: 'pwd',
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_exec_2',
        name: 'exec_command',
        content: { type: 'custom_tool_call_output', output: '/tmp/project' },
      },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '执行命令并返回结果' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_exec_2', name: 'exec_command', arguments: { input: 'pwd' } }],
      },
      {
        type: 'function_call_output',
        call_id: 'call_exec_2',
        name: 'exec_command',
        output: JSON.stringify({ type: 'custom_tool_call_output', output: '/tmp/project' }),
      },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync accepts tool result history fallback id when tool_call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/id-result.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            id: 'call_hist_result_id_only_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/id-result.txt' }),
          },
        ],
      },
      { role: 'tool', id: 'call_hist_result_id_only_1', name: 'read', content: 'RESULT_BY_ID' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/id-result.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_result_id_only_1', name: 'read', arguments: { filePath: '/tmp/id-result.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_result_id_only_1', name: 'read', output: 'RESULT_BY_ID' },
    ]);
  });

  test('RED: parseCascadeAssistantTurnSync fails fast on empty assistant completion', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeAssistantTurnSync({ role: 'assistant', content: [] }))
      .toThrow('[windsurf] empty assistant completion');
  });

  test('RED: parseCascadeAssistantTurnSync fails fast on tool call missing name', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [{ type: 'tool_call', call_id: 'call_1', arguments: { filePath: '/tmp/a.txt' } }],
    })).toThrow('[windsurf] assistant tool call missing name');
  });

  test('RED: parseCascadeAssistantTurnSync fails fast on tool call missing call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [{ type: 'tool_call', name: 'read', arguments: { filePath: '/tmp/a.txt' } }],
    })).toThrow('[windsurf] assistant tool call missing call_id');
  });

  test('RED: parseCascadeAssistantTurnSync fails fast when upstream tool_call arguments is not an object', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [{ type: 'tool_call', call_id: 'call_1', name: 'read', arguments: 'bad-shape' }],
    })).toThrow('[windsurf] assistant tool call arguments must be object');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast on malformed assistant function_call arguments json', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_bad_json',
            name: 'read',
            arguments: '{"filePath":"/tmp/a.txt"', // missing closing brace
          },
        ],
      },
    ])).toThrow('[windsurf] assistant tool call arguments must be valid json object');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant function_call arguments json is not an object', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_bad_shape',
            name: 'read',
            arguments: '["/tmp/a.txt"]',
          },
        ],
      },
    ])).toThrow('[windsurf] assistant tool call arguments must be valid json object');
  });


  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant chat tool_calls history repeats call_id in same turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'do tools' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_dup_id_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          },
          {
            id: 'call_hist_dup_id_1',
            type: 'function',
            function: { name: 'list_directory', arguments: JSON.stringify({ path: '/tmp' }) },
          },
        ],
      },
    ])).toThrow('[windsurf] duplicate assistant tool call id in history');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant chat tool_calls history repeats same signature with different call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'do tools' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_sig_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          },
          {
            id: 'call_hist_sig_2',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          },
        ],
      },
    ])).toThrow('[windsurf] duplicate assistant tool call signature in history');
  });


  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant history mixes chat tool_calls with duplicate content function_call call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'do tools' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_hist_mixed_dup_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        }],
        content: [
          { type: 'output_text', text: '先读文件。' },
          {
            type: 'function_call',
            call_id: 'call_hist_mixed_dup_1',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    ])).toThrow('[windsurf] duplicate assistant tool call id in history');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant history mixes chat tool_calls with extra content function_call signature', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'do tools' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_hist_mixed_base_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        }],
        content: [
          { type: 'output_text', text: '先读文件。' },
          {
            type: 'function_call',
            call_id: 'call_hist_mixed_extra_2',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    ])).toThrow('[windsurf] assistant history mixed chat tool_calls with content tool call');
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant responses content history repeats call_id in same turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'do tools' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_hist_block_dup_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_hist_block_dup_1',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    ])).toThrow('[windsurf] duplicate assistant tool call id in history');
  });

  test('RED: parseCascadeSemanticRoundtripSync preserves multiple assistant tool calls in one turn and matching tool results', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '先读文件再列目录' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_multi',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_ls_multi',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_multi', name: 'read', content: 'A_CONTENT' },
      { role: 'tool', tool_call_id: 'call_ls_multi', name: 'list_directory', content: 'a.txt' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '先读文件再列目录' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [
          { call_id: 'call_read_multi', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
          { call_id: 'call_ls_multi', name: 'list_directory', arguments: { path: '/tmp' } },
        ],
      },
      { type: 'function_call_output', call_id: 'call_read_multi', name: 'read', output: 'A_CONTENT' },
      { type: 'function_call_output', call_id: 'call_ls_multi', name: 'list_directory', output: 'a.txt' },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync fails fast when upstream repeats the same multi-tool signature set after tool results', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '先读文件再列目录' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_repeat_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_ls_repeat_1',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_repeat_1', name: 'read', content: 'A_CONTENT' },
      { role: 'tool', tool_call_id: 'call_ls_repeat_1', name: 'list_directory', content: 'a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_repeat_2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_ls_repeat_2',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    ])).toThrow('[windsurf] upstream repeated prior tool call after tool_result');
  });

  test('RED: parseCascadeSemanticRoundtripSync allows repeating same tool signature after a new user turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '读一下 /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_round1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_round1', name: 'read', content: 'A_CONTENT' },
      { role: 'assistant', content: '第一次读取完成。' },
      { role: 'user', content: '再读一次 /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_round2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: '读一下 /tmp/a.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [
          { call_id: 'call_read_round1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
      { type: 'function_call_output', call_id: 'call_read_round1', name: 'read', output: 'A_CONTENT' },
      { type: 'assistant', text: '第一次读取完成。' },
      { type: 'user', text: '再读一次 /tmp/a.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [
          { call_id: 'call_read_round2', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
    ]);
  });

  test('RED: parseCascadeSemanticRoundtripSync still fails fast when same tool signature repeats after assistant text but before any new user turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: '读一下 /tmp/a.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_repeat_text_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_repeat_text_1', name: 'read', content: 'A_CONTENT' },
      { role: 'assistant', content: '我先解释一下刚才的结果。' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_read_repeat_text_2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
    ])).toThrow('[windsurf] upstream repeated prior tool call after tool_result');
  });

  test('RED: buildChatCompletionFromCascadeResponse builds final chat completion from assistant tool candidate', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const out = (provider as any).buildChatCompletionFromCascadeResponse({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_call', call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 3 },
      },
    });
  });

  test('RED: buildChatCompletionFromCascadeResponse preserves assistant text when candidate contains output_text + tool_call', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const out = (provider as any).buildChatCompletionFromCascadeResponse({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: [
          { type: 'output_text', text: '我先读取文件。' },
          { type: 'tool_call', call_id: 'call_read_mix_2', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '我先读取文件。',
          tool_calls: [{
            id: 'call_read_mix_2',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: buildChatCompletionFromCascadeResponse fails fast on empty candidate payload', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).buildChatCompletionFromCascadeResponse({ model: 'gpt-5.4-medium', candidate: null }))
      .toThrow('[windsurf] empty cascade candidate payload');
  });

  test('RED: buildChatCompletionFromCascadeResponse fails fast on assistant candidate with invalid tool call payload', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).buildChatCompletionFromCascadeResponse({
      model: 'gpt-5.4-medium',
      candidate: { role: 'assistant', content: [{ type: 'tool_call', call_id: 'call_read_1', arguments: { filePath: '/tmp/a.txt' } }] },
    })).toThrow('[windsurf] assistant tool call missing name');
  });

  test('RED: sendRequestInternal uses cloud loadCodeAssist path and semantic conversation body', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_call', call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
          ],
        }],
        usageMetadata: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 },
      },
    } as any);

    const out = await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
          { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: 'A_CONTENT' },
          { role: 'user', content: '再读一遍' },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[0]).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: 'read /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_1', name: 'read', output: 'A_CONTENT' },
        { type: 'user', text: '再读一遍' },
      ],
    });
    expect(postSpy.mock.calls[0]?.[1]?.messages).toBeUndefined();
    expect(postSpy.mock.calls[0]?.[1]?.modelInfo).toBeUndefined();
    expect(postSpy.mock.calls[0]?.[2]?.Authorization).toBe('Bearer test-bearer-token');
    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{ finish_reason: 'tool_calls' }],
    });
  });

  test('RED: sendRequestInternal preserves multi-round same-tool replay after assistant text and new user turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            { type: 'tool_call', call_id: 'call_read_round2_send', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
          ],
        }],
      },
    } as any);

    const out = await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: '读一下 /tmp/a.txt' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_read_round1_send', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
          },
          { role: 'tool', tool_call_id: 'call_read_round1_send', name: 'read', content: 'A_CONTENT' },
          { role: 'assistant', content: '第一次读取完成。' },
          { role: 'user', content: '再读一次 /tmp/a.txt' },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: '读一下 /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_round1_send', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_round1_send', name: 'read', output: 'A_CONTENT' },
        { type: 'assistant', text: '第一次读取完成。' },
        { type: 'user', text: '再读一次 /tmp/a.txt' },
      ],
    });
    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_read_round2_send',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal fails fast when same tool signature repeats after assistant text without any new user turn', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            { type: 'tool_call', call_id: 'call_read_repeat_send_2', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
          ],
        }],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: '读一下 /tmp/a.txt' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_read_repeat_send_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
          },
          { role: 'tool', tool_call_id: 'call_read_repeat_send_1', name: 'read', content: 'A_CONTENT' },
          { role: 'assistant', content: '我先解释一下刚才读取到的内容。' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_read_repeat_send_2', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
          },
        ],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] upstream repeated prior tool call after tool_result',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal prefers output tool continuation over stale candidate text in multi-round flow', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [
          {
            role: 'assistant',
            content: 'STALE_TEXT_SHOULD_NOT_WIN',
          },
        ],
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '我继续处理。' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_read_output_continue_2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/b.txt' }),
          },
        ],
      },
    } as any);

    const out = await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: '先读 /tmp/a.txt' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_read_output_continue_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
          },
          { role: 'tool', tool_call_id: 'call_read_output_continue_1', name: 'read', content: 'A_CONTENT' },
          { role: 'assistant', content: '第一次读取完成。' },
          { role: 'user', content: '继续读 /tmp/b.txt' },
        ],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      conversation: [
        { type: 'user', text: '先读 /tmp/a.txt' },
        { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_output_continue_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
        { type: 'function_call_output', call_id: 'call_read_output_continue_1', name: 'read', output: 'A_CONTENT' },
        { type: 'assistant', text: '第一次读取完成。' },
        { type: 'user', text: '继续读 /tmp/b.txt' },
      ],
    });
    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '我继续处理。',
          tool_calls: [{
            id: 'call_read_output_continue_2',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/b.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal prefers output text-only completion over stale candidate tool_call', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
        extensions: {
          windsurf: {
            apiBaseUrl: 'https://daily-cloudcode-pa.googleapis.com',
          },
        },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [
          {
            role: 'assistant',
            content: [
              {
                type: 'function_call',
                call_id: 'call_stale_candidate_tool_1',
                name: 'read',
                arguments: JSON.stringify({ filePath: '/tmp/stale.txt' }),
              },
            ],
          },
        ],
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'TEXT_ONLY_TRUE_SOURCE' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'TEXT_ONLY_TRUE_SOURCE',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal fails fast when upstream returns empty candidates', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: { candidates: [] },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] empty cascade candidate payload',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when upstream candidate has no text and no tool_call', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'unknown_block', value: 'noop' }],
        }],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] empty assistant completion',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal accepts upstream candidate with plain string assistant content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: 'OK',
        }],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'OK',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal accepts upstream function_call candidate blocks', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            {
              type: 'function_call',
              call_id: 'call_fc_send_1',
              name: 'read',
              arguments: JSON.stringify({ filePath: '/tmp/fc-send.txt' }),
            },
          ],
        }],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_fc_send_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/fc-send.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal accepts responses-style output[message] payload and snake_case usage', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'OK' },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'OK',
        },
        finish_reason: 'stop',
      }],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
      },
    });
  });

  test('RED: sendRequestInternal accepts responses-style output[message] string content payload', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: 'STRING_OK',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'STRING_OK',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal accepts responses-style output function_call item without wrapping message', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_output_fc_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/out-fc.txt' }),
            status: 'completed',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_output_fc_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/out-fc.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal accepts responses-style output custom_tool_call item without wrapping message', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'custom_tool_call',
            call_id: 'call_output_custom_1',
            name: 'exec_command',
            input: 'pwd',
            status: 'completed',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_output_custom_1',
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal accepts responses-style output tool_call item without wrapping message', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'tool_call',
            id: 'call_output_tool_1',
            name: 'read',
            arguments: { filePath: '/tmp/out-tool.txt' },
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_output_tool_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/out-tool.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal preserves responses-style output[] mixed message + function_call items in order', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '我先读取文件。' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_output_mix_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/out-mix.txt' }),
            status: 'completed',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '我先读取文件。',
          tool_calls: [{
            id: 'call_output_mix_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/out-mix.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal preserves responses-style output[] mixed string-message + function_call items in order', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: '先解释一下。',
          },
          {
            type: 'function_call',
            call_id: 'call_output_fc_string_mix_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/string-mix.txt' }),
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '先解释一下。',
          tool_calls: [{
            id: 'call_output_fc_string_mix_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/string-mix.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal preserves responses-style output[] mixed message + custom_tool_call items in order', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '我先执行命令。' },
            ],
          },
          {
            type: 'custom_tool_call',
            call_id: 'call_output_mix_custom_1',
            name: 'exec_command',
            input: 'pwd',
            status: 'completed',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '我先执行命令。',
          tool_calls: [{
            id: 'call_output_mix_custom_1',
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal reads nested responses usage.input_tokens_details.cached_tokens', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'OK' },
            ],
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 25,
          input_tokens_details: {
            cached_tokens: 11,
          },
        },
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        input_tokens_details: {
          cached_tokens: 11,
        },
      },
    });
  });

  test('RED: sendRequestInternal reads nested camelCase usageMetadata.inputTokensDetails.cachedTokens', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'OK' },
          ],
        }],
        usageMetadata: {
          inputTokens: 30,
          outputTokens: 7,
          inputTokensDetails: {
            cachedTokens: 13,
          },
        },
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      usage: {
        input_tokens: 30,
        output_tokens: 7,
        total_tokens: 37,
        input_tokens_details: {
          cached_tokens: 13,
        },
      },
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output contains function_call_output item', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'function_call_output',
            call_id: 'call_out_1',
            output: 'A_CONTENT',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] response output contains tool result without assistant tool call',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output contains custom_tool_call_output item', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'custom_tool_call_output',
            call_id: 'call_out_custom_1',
            output: 'pwd',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] response output contains tool result without assistant tool call',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output mixes message with function_call_output item', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '我先读文件。' }],
          },
          {
            type: 'function_call_output',
            call_id: 'call_out_mix_1',
            output: 'A_CONTENT',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] response output mixed assistant content with tool result item',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output mixes custom_tool_call with custom_tool_call_output item', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'custom_tool_call',
            call_id: 'call_out_mix_custom_1',
            name: 'exec_command',
            input: 'pwd',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_out_mix_custom_1',
            output: '/tmp/project',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] response output mixed assistant content with tool result item',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal preserves responses-style output[] multiple message items as one assistant text stream', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '第一段。' },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '第二段。' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '第一段。第二段。',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal preserves multiple top-level responses-style output function_call items', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_top_fc_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_top_fc_2',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_top_fc_1',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
            },
            {
              id: 'call_top_fc_2',
              type: 'function',
              function: { name: 'list_directory', arguments: JSON.stringify({ path: '/tmp' }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal preserves multiple top-level responses-style output tool_call items', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'tool_call',
            id: 'call_top_tool_1',
            name: 'read',
            arguments: { filePath: '/tmp/a.txt' },
          },
          {
            type: 'tool_call',
            id: 'call_top_tool_2',
            name: 'list_directory',
            arguments: { path: '/tmp' },
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_top_tool_1',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
            },
            {
              id: 'call_top_tool_2',
              type: 'function',
              function: { name: 'list_directory', arguments: JSON.stringify({ path: '/tmp' }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal prefers valid responses-style output message when candidates[0] is empty object', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{}],
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'OUTPUT_TRUE_SOURCE_OK' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'OUTPUT_TRUE_SOURCE_OK',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal scans later candidates when candidates[0] is invalid but candidates[1] is valid', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [
          {},
          {
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'SECOND_CANDIDATE_OK' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'SECOND_CANDIDATE_OK',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal skips semantically-empty candidate blocks and uses later valid candidate', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [
          {
            role: 'assistant',
            content: [
              { type: 'unknown_block', value: 'noop' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'LATE_VALID_CANDIDATE_OK' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'LATE_VALID_CANDIDATE_OK',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: sendRequestInternal prefers responses-style output over stale candidate when both are present', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [
          {
            role: 'assistant',
            content: 'STALE_CANDIDATE_TEXT',
          },
        ],
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'OUTPUT_TEXT_TRUE_SOURCE' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_output_true_source_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/true-source.txt' }),
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'OUTPUT_TEXT_TRUE_SOURCE',
          tool_calls: [{
            id: 'call_output_true_source_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/true-source.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output message role is not assistant', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'output_text', text: '这不该出现在 assistant output 里' },
            ],
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] response output message role must be assistant',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output repeats function_call_output id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          { type: 'function_call_output', id: 'call_result_dup_1', output: 'A_CONTENT' },
          { type: 'function_call_output', id: 'call_result_dup_1', output: 'A_CONTENT_AGAIN' },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] duplicate tool result id in response output',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output repeats custom_tool_call_output call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          { type: 'custom_tool_call_output', call_id: 'call_result_dup_custom_1', output: 'pwd' },
          { type: 'custom_tool_call_output', call_id: 'call_result_dup_custom_1', output: 'pwd-again' },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] duplicate tool result id in response output',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output repeats function_call call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_dup_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_dup_1',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '/tmp' }),
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] duplicate assistant tool call id in response output',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output repeats same function_call signature with different call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_sig_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
          {
            type: 'function_call',
            call_id: 'call_sig_2',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] duplicate assistant tool call signature in response output',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: sendRequestInternal fails fast when responses-style output repeats same custom_tool_call signature with different call_id', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        output: [
          {
            type: 'custom_tool_call',
            call_id: 'call_custom_sig_1',
            name: 'exec_command',
            input: 'pwd',
          },
          {
            type: 'custom_tool_call',
            call_id: 'call_custom_sig_2',
            name: 'exec_command',
            input: 'pwd',
          },
        ],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).rejects.toMatchObject({
      message: '[windsurf] duplicate assistant tool call signature in response output',
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts function_call candidate fallback id when call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        {
          type: 'function_call',
          id: 'fc_item_only_id_1',
          name: 'read',
          arguments: JSON.stringify({ filePath: '/tmp/id-only.txt' }),
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'fc_item_only_id_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/id-only.txt' }) },
        },
      ],
    });
  });

  test('RED: parseCascadeAssistantTurnSync accepts custom_tool_call candidate fallback id when call_id is absent', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        {
          type: 'custom_tool_call',
          id: 'custom_item_only_id_1',
          name: 'exec_command',
          input: 'pwd',
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'custom_item_only_id_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
        },
      ],
    });
  });


  test('RED: managed devin session token directly uses cloud chat mainline', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$abc123', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'DEVIN_TOKEN_OK' },
          ],
        }],
      },
    } as any);

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'DEVIN_TOKEN_OK',
        },
        finish_reason: 'stop',
      }],
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[2]).toMatchObject({
      Authorization: 'Bearer devin-session-token$abc123',
    });
  });


  test('RED: upstream 401 from generic cloud bearer must still normalize to WINDSURF_AUTH_FAILED', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'generic-cloud-bearer' },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post').mockRejectedValue(Object.assign(
      new Error('HTTP 401: invalid authentication credentials'),
      { status: 401, response: { data: { error: { code: 401, status: 'UNAUTHENTICATED' } } } },
    ));

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'Say only OK' }],
      },
    })).rejects.toMatchObject({
      code: 'WINDSURF_AUTH_FAILED',
      status: 401,
    });
  });

  test('RED: generic bearer transport path stays unit-testable for parser/body coverage', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'test-bearer-token' },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValue({
      data: {
        candidates: [{
          role: 'assistant',
          content: [{ type: 'text', text: 'OK' }],
        }],
      },
    } as any);

    const out = await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[2]?.Authorization).toBe('Bearer test-bearer-token');
    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    });
  });
});
