import { beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

describe('Windsurf MCP-only protocol', () => {
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

  test('preprocess maps non-native tools to neutral windsurf_mcp_tools field', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'patch file' }],
        tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
      },
    });
    expect(mapped.body.windsurf_mcp_tools.map((t: any) => t.function.name)).toEqual(['apply_patch']);
    expect(mapped.body.windsurf_text_tool_protocol).toBeUndefined();
  });

  test('preprocess fully covers native-mappable tool conversion and keeps MCP tools separate', async () => {
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
    expect(mapped.body.windsurf_mcp_tools.map((t: any) => t.function.name)).toEqual(['custom_mcp_tool']);
  });

  test('grpc body forwards single mcp_compat payload via SendUserCascadeMessageRequest field 10', async () => {
    const provider = createProvider();
    const request = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-mcp-single',
      text: 'continue',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-4-medium',
      mcpCompat: [{ server: 's1', tool: 'apply_patch' }],
    });
    const fields = (provider as any).parseProtoFields(request);
    expect((provider as any).getAllProtoFields(fields, 10, 2)).toHaveLength(1);
  });

  test('grpc body forwards multiple mcp_compat payloads for multi-function MCP alignment', async () => {
    const provider = createProvider();
    const request = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-mcp-multi',
      text: 'continue',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-4-medium',
      mcpCompat: [
        { server: 's1', tool: 'apply_patch', fn: 'apply_patch' },
        { server: 's1', tool: 'write_stdin', fn: 'write_stdin' },
      ],
    });
    const fields = (provider as any).parseProtoFields(request);
    expect((provider as any).getAllProtoFields(fields, 10, 2)).toHaveLength(2);
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

  test('outbound cascade text never injects RCC guidance markers even when MCP tools exist', async () => {
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
    const text = (provider as any).buildCascadePromptText(mapped.body.messages, semantic, 'gpt-5-4-medium', mapped.body.windsurf_mcp_tools);
    expect(text.includes('<|RCC|')).toBe(false);
  });
});
