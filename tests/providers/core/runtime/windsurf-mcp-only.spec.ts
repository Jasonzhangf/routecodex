import { beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('Windsurf custom tools protocol (Cascade MCP)', () => {
  let WindsurfChatProvider: any;

  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  const createProvider = () => new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: 'http://localhost:3003',
      model: 'gpt-5.4-medium',
      auth: { type: 'apikey', apiKey: 'test-key' },
    },
  } as any, deps);

  test('RED: preprocess keeps Windsurf custom tool partition private from Hub Pipeline', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'patch file' }],
        tools: [
          { type: 'function', function: { name: 'node_repl', parameters: { type: 'object' }, mcp_compat: { server: 'node', fn: 'js' } } },
        ],
      },
    });
    expect(Object.keys(mapped.body)).not.toEqual(expect.arrayContaining([
      'windsurf_custom_tools',
      'windsurf_declared_native_tools',
      'windsurf_native_allowlist',
      'windsurf_native_mode',
      'windsurf_tool_choice',
    ]));
    expect(JSON.stringify(mapped.body)).not.toContain('mcp_compat');
    expect(JSON.stringify(mapped.body)).not.toContain('node_repl');
    expect(mapped.body.tools).toBeUndefined();
    expect(mapped.body.windsurf_text_tool_protocol).toBeUndefined();
  });

  test('preprocess fully covers native-mappable tool conversion and keeps custom tools separate', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'run tool suite' }],
        tools: [
          { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'list_directory', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'grep_search_v2', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'find', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'custom_mcp_tool', parameters: { type: 'object' }, mcp_compat: { server: 's1', fn: 'custom_mcp_tool' } } },
        ],
      },
    });
    expect(mapped.body.windsurf_native_mode).toBe(true);
    expect(mapped.body.windsurf_native_allowlist).toEqual(
      expect.arrayContaining(['view_file', 'run_command', 'list_directory', 'grep_search_v2', 'find']),
    );
    expect(mapped.body.windsurf_custom_tools.map((t: any) => t.function.name)).toEqual(['custom_mcp_tool']);
  });

  test('RED: repeated provider preprocess preserves private Windsurf native tool fields', async () => {
    const provider = createProvider();
    const first = await (provider as any).preprocessRequest({
      model: 'kimi-k2-6',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [{ type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', name: 'shell_command' },
    });
    expect(first.windsurf_native_mode).toBe(true);

    const second = await (provider as any).preprocessRequest(first);
    expect(second.windsurf_native_mode).toBe(true);
    expect(second.windsurf_native_allowlist).toContain('run_command');
    expect(second.windsurf_declared_native_tools.map((tool: any) => tool.function.name)).toEqual(['shell_command']);
    expect(Object.keys(second)).not.toEqual(expect.arrayContaining([
      'windsurf_declared_native_tools',
      'windsurf_native_allowlist',
      'windsurf_native_mode',
      'windsurf_tool_choice',
    ]));
  });

  test('RED: native standard tool names are explained as Cascade native aliases for tool_choice requests', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'call shell_command pwd' }],
        tools: [{ type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'shell_command' } },
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const text = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_custom_tools,
      [],
      mapped.body.windsurf_declared_native_tools,
      mapped.body.windsurf_tool_choice,
    );
    expect(text).toContain('Client tool `shell_command` is available in Cascade as native tool `run_command`');
    expect(text).toContain('satisfy that by calling native tool `run_command`');
    expect(text).toContain('call run_command pwd');
    expect(text).not.toContain('<|RCC|tool_calls>');
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toContain('function_call');
  });

  test('RED: custom tools must enable Cascade MCP config and must not use SendUserCascadeMessage field 10', async () => {
    const provider = createProvider();
    const request = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-mcp-single',
      text: 'continue',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-4-medium',
      nativeMode: true,
      nativeAllowlist: [],
      mcpMode: true,
    });
    const fields = (provider as any).parseProtoFields(request);
    expect((provider as any).getAllProtoFields(fields, 10, 2)).toHaveLength(0);
    const cascadeConfig = (provider as any).getProtoField(fields, 5, 2);
    const cascadeFields = (provider as any).parseProtoFields(cascadeConfig.value);
    const plannerConfig = (provider as any).getProtoField(cascadeFields, 1, 2);
    const plannerFields = (provider as any).parseProtoFields(plannerConfig.value);
    const toolConfig = (provider as any).getProtoField(plannerFields, 13, 2);
    const toolFields = (provider as any).parseProtoFields(toolConfig.value);
    expect((provider as any).getProtoField(toolFields, 16, 2)).toBeTruthy();
  });

  test('sendRequestInternal forwards function.mcp_compat from custom tools', async () => {
    const provider = createProvider();
    jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$mcp' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions').mockResolvedValue({ lsPort: 42101, csrfToken: 'csrf-mcp', sessionId: 'configured-session' } as never);
    jest.spyOn(provider, 'sendStartCascade').mockResolvedValue('cascade-mcp-1' as never);
    let sent: Record<string, unknown> | null = null;
    jest.spyOn(provider, 'sendCascadeMessage').mockImplementation(async (args: unknown) => {
      sent = args as Record<string, unknown>;
    });
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'done' },
      usage: { inputTokens: 1, outputTokens: 1 },
      stepOffset: 1,
    } as never);

    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'continue' }],
        tools: [
          { type: 'function', function: { name: 'custom_mcp_tool', parameters: { type: 'object' }, mcp_compat: { server: 's1', fn: 'custom_mcp_tool' } } },
        ],
      },
    });
    await provider.sendRequestInternal(mapped);

    expect(sent).toMatchObject({
      nativeMode: true,
      mcpMode: true,
    });
    expect(sent).not.toHaveProperty('mcpCompat');
  });

  test('RED: native Windsurf tool calls are returned as the original standard chat tool name', async () => {
    const provider = createProvider();
    jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$native' as never);
    jest.spyOn(provider, 'resolveManagedRuntimeOptions').mockResolvedValue({ lsPort: 42101, csrfToken: 'csrf-native', sessionId: 'configured-session' } as never);
    jest.spyOn(provider, 'sendStartCascade').mockResolvedValue('cascade-native-1' as never);
    jest.spyOn(provider, 'sendCascadeMessage').mockResolvedValue(undefined as never);
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_native_1', type: 'function', function: { name: 'run_command', arguments: '{"command_line":"pwd","cwd":"/tmp"}' } }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      stepOffset: 1,
    } as never);

    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [
          { type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } },
        ],
      },
    });
    const result = await provider.sendRequestInternal(mapped) as any;
    const toolCall = result.choices[0].message.tool_calls[0];

    expect(toolCall.function.name).toBe('shell_command');
    expect(JSON.parse(toolCall.function.arguments)).toMatchObject({ command: 'pwd', cwd: '/tmp' });
  });

  test('RED: standard non-native tools become MCP compact tool definitions without requiring mcp_compat metadata', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'patch and stdin' }],
        tools: [
          { type: 'function', function: { name: 'apply_patch', description: 'patch files', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'write_stdin', description: 'write stdin', parameters: { type: 'object' } } },
        ],
      },
    });
    expect(mapped.body.windsurf_custom_tools.map((tool: any) => tool.function.name)).toEqual(['apply_patch', 'write_stdin']);
    expect(mapped.body.windsurf_mcp_mode).toBe(true);
    expect(mapped.body.windsurf_custom_tools.every((tool: any) => tool.function.mcp_compat === undefined)).toBe(true);
  });

  test('assistant text containing RCC tool tag is rejected (MCP-only)', () => {
    const provider = createProvider();
    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: '<|RCC|tool_calls><|RCC|invoke name="x"></|RCC|invoke></|RCC|tool_calls>',
    }, [])).toThrow(expect.objectContaining({
      code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
      status: 400,
    }));
  });

  test('outbound cascade text never injects RCC guidance markers even when custom tools exist', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'run shell then continue' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell_command', arguments: '{"command":"pwd"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project' },
          { role: 'user', content: 'continue' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'custom_mcp_tool', parameters: { type: 'object' }, mcp_compat: { server: 's1', fn: 'custom_mcp_tool' } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const text = (provider as any).buildCascadePromptText(mapped.body.messages, semantic, 'gpt-5-4-medium', mapped.body.windsurf_custom_tools);
    expect(text.includes('<|RCC|')).toBe(false);
  });
});
