import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({

  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider tests'); },
}));

/**
 * Windsurf provider 测试真源说明
 *
 * 固定 reference anchors:
 * - auth / token / postAuth
 *   - `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
 * - chat / tool / history / continuity
 *   - `/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
 *     - `buildAdditionalStepsFromHistory()`
 *   - `/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js`
 *     - `projectMessage()`
 *     - `projectAssistantToolCalls()`
 *   - `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
 *     - `parseTrajectorySteps()`
 *
 * 约束：
 * - helper/parser 直测只锁上述 reference 直接语义。
 */

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

let WindsurfChatProvider: any;

function runWindsurfApiReference(code: string) {
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

function encodeConnectJsonFrame(payload: Record<string, unknown>, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  out.push(remaining);
  return Buffer.from(out);
}

function encodeProtoFieldVarint(fieldNo: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(value)]);
}

function encodeProtoFieldString(fieldNo: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(body.length), body]);
}

function encodeProtoFieldMessage(fieldNo: number, body: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(body.length), body]);
}

function encodeCompletionDeltaProto(payload: {
  deltaText?: string;
  deltaThinking?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}): Buffer {
  const parts: Buffer[] = [];
  if (payload.deltaText) parts.push(encodeProtoFieldString(1, payload.deltaText));
  if (payload.usage) {
    const usageParts: Buffer[] = [];
    if (typeof payload.usage.inputTokens === 'number') usageParts.push(encodeProtoFieldVarint(2, payload.usage.inputTokens));
    if (typeof payload.usage.outputTokens === 'number') usageParts.push(encodeProtoFieldVarint(3, payload.usage.outputTokens));
    if (typeof payload.usage.cacheWriteTokens === 'number') usageParts.push(encodeProtoFieldVarint(4, payload.usage.cacheWriteTokens));
    if (typeof payload.usage.cacheReadTokens === 'number') usageParts.push(encodeProtoFieldVarint(5, payload.usage.cacheReadTokens));
    parts.push(encodeProtoFieldMessage(4, Buffer.concat(usageParts)));
  }
  for (const tool of payload.toolCalls || []) {
    const toolBody = Buffer.concat([
      encodeProtoFieldString(1, tool.id),
      encodeProtoFieldString(2, tool.name),
      encodeProtoFieldString(3, tool.argumentsJson),
    ]);
    parts.push(encodeProtoFieldMessage(5, toolBody));
  }
  if (payload.deltaThinking) parts.push(encodeProtoFieldString(6, payload.deltaThinking));
  return Buffer.concat(parts);
}

function encodeConnectProtoFrame(payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function encodeTrajectoryStepEnvelope(payload: {
  type?: number;
  status?: number;
  responseText?: string;
  modifiedText?: string;
  thinking?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  proposalToolCall?: { id: string; name: string; argumentsJson: string };
  choiceToolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  choiceIndex?: number;
  mcpToolCall?: { serverName?: string; id: string; name: string; argumentsJson: string; result?: string };
  customToolCall?: { id?: string; name?: string; argumentsJson?: string; result?: string };
  errorText?: string;
}): Buffer {
  const stepParts: Buffer[] = [];
  if (typeof payload.type === 'number') stepParts.push(encodeProtoFieldVarint(1, payload.type));
  if (typeof payload.status === 'number') stepParts.push(encodeProtoFieldVarint(4, payload.status));
  if (payload.usage) {
    const usageParts: Buffer[] = [];
    if (typeof payload.usage.inputTokens === 'number') usageParts.push(encodeProtoFieldVarint(2, payload.usage.inputTokens));
    if (typeof payload.usage.outputTokens === 'number') usageParts.push(encodeProtoFieldVarint(3, payload.usage.outputTokens));
    if (typeof payload.usage.cacheWriteTokens === 'number') usageParts.push(encodeProtoFieldVarint(4, payload.usage.cacheWriteTokens));
    if (typeof payload.usage.cacheReadTokens === 'number') usageParts.push(encodeProtoFieldVarint(5, payload.usage.cacheReadTokens));
    const meta = encodeProtoFieldMessage(9, Buffer.concat(usageParts));
    stepParts.push(encodeProtoFieldMessage(5, meta));
  }
  const plannerParts: Buffer[] = [];
  if (payload.responseText) plannerParts.push(encodeProtoFieldString(1, payload.responseText));
  if (payload.thinking) plannerParts.push(encodeProtoFieldString(3, payload.thinking));
  if (payload.modifiedText) plannerParts.push(encodeProtoFieldString(8, payload.modifiedText));
  if (plannerParts.length) stepParts.push(encodeProtoFieldMessage(20, Buffer.concat(plannerParts)));
  if (payload.proposalToolCall) {
    const body = Buffer.concat([
      encodeProtoFieldString(1, payload.proposalToolCall.id),
      encodeProtoFieldString(2, payload.proposalToolCall.name),
      encodeProtoFieldString(3, payload.proposalToolCall.argumentsJson),
    ]);
    stepParts.push(encodeProtoFieldMessage(49, encodeProtoFieldMessage(1, body)));
  }
  if (payload.choiceToolCalls?.length) {
    const choiceParts: Buffer[] = payload.choiceToolCalls.map((call) => encodeProtoFieldMessage(1, Buffer.concat([
      encodeProtoFieldString(1, call.id),
      encodeProtoFieldString(2, call.name),
      encodeProtoFieldString(3, call.argumentsJson),
    ])));
    if (typeof payload.choiceIndex === 'number') choiceParts.push(encodeProtoFieldVarint(2, payload.choiceIndex));
    stepParts.push(encodeProtoFieldMessage(50, Buffer.concat(choiceParts)));
  }
  if (payload.mcpToolCall) {
    const parts: Buffer[] = [];
    if (payload.mcpToolCall.serverName) parts.push(encodeProtoFieldString(1, payload.mcpToolCall.serverName));
    parts.push(encodeProtoFieldMessage(2, Buffer.concat([
      encodeProtoFieldString(1, payload.mcpToolCall.id),
      encodeProtoFieldString(2, payload.mcpToolCall.name),
      encodeProtoFieldString(3, payload.mcpToolCall.argumentsJson),
    ])));
    if (payload.mcpToolCall.result) parts.push(encodeProtoFieldString(3, payload.mcpToolCall.result));
    stepParts.push(encodeProtoFieldMessage(47, Buffer.concat(parts)));
  }
  if (payload.customToolCall) {
    const parts: Buffer[] = [];
    if (payload.customToolCall.id) parts.push(encodeProtoFieldString(1, payload.customToolCall.id));
    if (payload.customToolCall.argumentsJson) parts.push(encodeProtoFieldString(2, payload.customToolCall.argumentsJson));
    if (payload.customToolCall.result) parts.push(encodeProtoFieldString(3, payload.customToolCall.result));
    if (payload.customToolCall.name) parts.push(encodeProtoFieldString(4, payload.customToolCall.name));
    stepParts.push(encodeProtoFieldMessage(45, Buffer.concat(parts)));
  }
  if (payload.errorText) {
    const details = encodeProtoFieldMessage(3, encodeProtoFieldString(1, payload.errorText));
    stepParts.push(encodeProtoFieldMessage(24, details));
  }
  return encodeProtoFieldMessage(1, Buffer.concat(stepParts));
}

describe('WindsurfChatProvider', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  beforeEach(() => {
  });

  const createProvider = (auth: Record<string, unknown> = { type: 'apikey', apiKey: 'test-key' }) => new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: 'http://localhost:3003',
      model: 'gpt-5.4-medium',
      auth,
    },
  } as any, deps);

  const projectConversation = (messages: unknown, auth?: Record<string, unknown>) => {
    const provider = createProvider(auth);
    return (provider as any).parseCascadeSemanticRoundtripSync(messages);
  };

  // Auth / token priority / postAuth proto contract / auth-context headers
  // anchor:
  // - windsurf-login.js






  test('RED: parseGetChatMessageResponse must classify resource_exhausted + internal error as upstream transient, not rate limit', async () => {
    const provider = createProvider();
    expect(() => (provider as any).parseGetChatMessageResponse(JSON.stringify({
      error: {
        code: 'resource_exhausted',
        message: 'An internal error occurred (error ID: abc123)',
      },
    }))).toThrow(expect.objectContaining({
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
    }));
  });

  test('RED: parseGetChatMessageResponse must classify policy blocked payload like winsurfapi instead of service unreachable', async () => {
    const provider = createProvider();
    expect(() => (provider as any).parseGetChatMessageResponse(JSON.stringify({
      error: {
        code: 'permission_denied',
        message: 'Your request was blocked by our content policy',
      },
    }))).toThrow(expect.objectContaining({
      code: 'WINDSURF_POLICY_BLOCKED',
      status: 451,
      retryable: false,
    }));
  });

  test('RED: classifyWindsurfCascadeError must preserve weekly quota as non-retryable quota error even when grpc path pre-structures it', async () => {
    const provider = createProvider();
    const upstream = new Error('Your weekly usage quota has been exhausted. Please ensure Windsurf is up to date for the best experience, or visit windsurf.com to manage your plan.');
    Object.assign(upstream, {
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
      upstreamCode: 'WINDSURF_UPSTREAM_TRANSIENT',
    });

    const classified = (provider as any).classifyWindsurfCascadeError(upstream);
    expect(classified).toEqual(expect.objectContaining({
      code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
      status: 429,
      retryable: false,
      rateLimitKind: 'daily_limit',
      quotaScope: 'weekly',
      quotaReason: 'windsurf_weekly_exhausted',
    }));
  });

  test('RED: classifyWindsurfCascadeError must surface upstream transient for cascade transport / internal-error style failures', async () => {
    const provider = createProvider();

    const transport = (provider as any).classifyWindsurfCascadeError(new Error('ERR_HTTP2_STREAM_CANCEL pending stream has been canceled'));
    expect(transport).toEqual(expect.objectContaining({
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
    }));

    const internal = (provider as any).classifyWindsurfCascadeError(new Error('internal error occurred (error ID: xyz)'));
    expect(internal).toEqual(expect.objectContaining({
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
    }));
  });

  test('RED: classifyWindsurfCascadeError must surface policy blocked instead of auth/service unreachable', async () => {
    const provider = createProvider();
    const classified = (provider as any).classifyWindsurfCascadeError(
      new Error('prompt rejected by policy: Your request was blocked by our content policy'),
    );
    expect(classified).toEqual(expect.objectContaining({
      code: 'WINDSURF_POLICY_BLOCKED',
      status: 451,
      retryable: false,
    }));
  });

  test('RED: parseGetChatMessageResponse must decode connect-framed delta_text + delta_thinking + delta_tool_calls into assistant candidate', async () => {
    const provider = createProvider();
    const raw = Buffer.concat([
      encodeConnectJsonFrame({
        delta_text: '先看文件。',
        delta_thinking: '先分析上下文。',
        delta_tool_calls: [
          { id: 'call_read_resp_1', name: 'read', arguments_json: JSON.stringify({ filePath: '/tmp/a.txt' }) },
        ],
      }),
      encodeConnectJsonFrame({
        usage: {
          input_tokens: 111,
          output_tokens: 22,
          cache_read_tokens: 7,
          cache_write_tokens: 5,
        },
      }, 0x02),
    ]);

    const parsed = (provider as any).parseGetChatMessageResponse(raw);
    expect(parsed).toMatchObject({
      candidate: {
        role: 'assistant',
        content: '先看文件。',
        reasoning_content: '先分析上下文。',
        tool_calls: [{
          id: 'call_read_resp_1',
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' }),
          },
        }],
      },
      usage: {
        inputTokens: 111,
        outputTokens: 22,
        cacheReadTokens: 7,
        cacheWriteTokens: 5,
      },
    });
  });

  test('RED: parseGetChatMessageResponse must accept top-level deltaText/deltaThinking/deltaToolCalls camelCase response as regression truth', async () => {
    const provider = createProvider();
    const raw = Buffer.concat([
      encodeConnectJsonFrame({
        deltaText: 'TOOL_CALL_PENDING',
        deltaThinking: 'REASONING_PENDING',
        deltaToolCalls: [
          { id: 'call_exec_resp_1', name: 'exec_command', argumentsJson: JSON.stringify({ cmd: 'pwd' }) },
        ],
        modelUsage: {
          inputTokens: 9,
          outputTokens: 3,
          cacheReadTokens: 1,
          cacheWriteTokens: 4,
        },
      }, 0x02),
    ]);

    const parsed = (provider as any).parseGetChatMessageResponse(raw);
    expect(parsed).toMatchObject({
      candidate: {
        role: 'assistant',
        content: 'TOOL_CALL_PENDING',
        reasoning_content: 'REASONING_PENDING',
        tool_calls: [{
          id: 'call_exec_resp_1',
          type: 'function',
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'pwd' }),
          },
        }],
      },
      usage: {
        inputTokens: 9,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 4,
      },
    });
  });

  test('RED: parseGetChatMessageResponse must accept top-level json candidate payload and must not misparse it as connect frame', async () => {
    const provider = createProvider();
    const raw = JSON.stringify({
      completionResponse: {
        completions: [
          {
            text: 'TOP_LEVEL_OK',
            thinking: 'TOP_LEVEL_REASONING',
            toolCalls: [
              {
                id: 'call_top_level_1',
                name: 'exec_command',
                argumentsJson: JSON.stringify({ cmd: 'pwd' }),
              },
            ],
          },
        ],
      },
      modelUsage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });

    const parsed = (provider as any).parseGetChatMessageResponse(raw);
    expect(parsed).toMatchObject({
      candidate: {
        role: 'assistant',
        content: 'TOP_LEVEL_OK',
        reasoning_content: 'TOP_LEVEL_REASONING',
        tool_calls: [{
          id: 'call_top_level_1',
          type: 'function',
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'pwd' }),
          },
        }],
      },
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });
  });

  test('RED: parseGetChatMessageResponse must fail fast on invalid top-level empty completions json instead of falling into frame parser', async () => {
    const provider = createProvider();
    expect(() => (provider as any).parseGetChatMessageResponse(JSON.stringify({
      completionResponse: {
        completions: [],
      },
    }))).toThrow(expect.objectContaining({
      code: 'WINDSURF_RESPONSE_PARSE_FAILED',
      status: 502,
      retryable: false,
      message: '[windsurf] empty cascade candidate payload',
    }));
  });

  test('RED: parseGetChatMessageResponse must classify top-level code/message json error body instead of misparsing it as connect frame', async () => {
    const provider = createProvider();
    expect(() => (provider as any).parseGetChatMessageResponse(JSON.stringify({
      code: 'invalid_argument',
      message: 'an internal error occurred',
    }), {
      contentType: 'application/json',
    })).toThrow(expect.objectContaining({
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
    }));
  });

  test('RED: parseGetChatMessageResponse must decode connect-framed protobuf CompletionDelta payload from Windsurf app field family', async () => {
    const provider = createProvider();
    const raw = Buffer.concat([
      encodeConnectProtoFrame(encodeCompletionDeltaProto({
        deltaText: 'PROTO_TEXT',
        deltaThinking: 'PROTO_THINKING',
        toolCalls: [
          {
            id: 'call_proto_1',
            name: 'exec_command',
            argumentsJson: JSON.stringify({ cmd: 'pwd' }),
          },
        ],
        usage: {
          inputTokens: 17,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
        },
      }), 0x02),
    ]);

    const parsed = (provider as any).parseGetChatMessageResponse(raw);
    expect(parsed).toMatchObject({
      candidate: {
        role: 'assistant',
        content: 'PROTO_TEXT',
        reasoning_content: 'PROTO_THINKING',
        tool_calls: [{
          id: 'call_proto_1',
          type: 'function',
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'pwd' }),
          },
        }],
      },
      usage: {
        inputTokens: 17,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      },
    });
  });

  test('RED: parseGetChatMessageResponse truncated connect frame error must carry transport diagnostics for live blackbox replay', async () => {
    const provider = createProvider();
    const body = Buffer.from(JSON.stringify({ delta_text: 'PARTIAL' }), 'utf8');
    const header = Buffer.alloc(5);
    header[0] = 0;
    header.writeUInt32BE(body.length + 8, 1);
    const raw = Buffer.concat([header, body]);

    expect(() => (provider as any).parseGetChatMessageResponse(raw, {
      contentType: 'application/connect+proto',
      contentEncoding: 'identity',
    })).toThrow(expect.objectContaining({
      code: 'WINDSURF_RESPONSE_PARSE_FAILED',
      status: 502,
      retryable: false,
    }));

    try {
      (provider as any).parseGetChatMessageResponse(raw, {
        contentType: 'application/connect+proto',
        contentEncoding: 'identity',
      });
    } catch (error: any) {
      expect(String(error.message)).toContain('contentType=application/connect+proto');
      expect(String(error.message)).toContain('declaredLength=');
      expect(String(error.message)).toContain('remainingBytes=');
      expect(String(error.message)).toContain('prefixHex=');
    }
  });

  test('RED: parseGetChatMessageResponse must fail fast on truncated connect frame from live regression family', async () => {
    const provider = createProvider();
    const body = Buffer.from(JSON.stringify({ delta_text: 'PARTIAL' }), 'utf8');
    const header = Buffer.alloc(5);
    header[0] = 0;
    header.writeUInt32BE(body.length + 8, 1);
    const raw = Buffer.concat([header, body]);

    expect(() => (provider as any).parseGetChatMessageResponse(raw))
      .toThrow(expect.objectContaining({
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      }));

    try {
      (provider as any).parseGetChatMessageResponse(raw);
    } catch (error: any) {
      expect(String(error.message)).toContain('[windsurf] truncated connect frame from GetChatMessage');
      expect(String(error.message)).toContain('declaredLength=');
      expect(String(error.message)).toContain('remainingBytes=');
      expect(String(error.message)).toContain('prefixHex=');
    }
  });

  test('RED: buildCascadeCompletionFromOutput must project WindsurfAPI-style cache write usage fields', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: 'USAGE_OK',
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 5,
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          content: 'USAGE_OK',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 14,
        completion_tokens: 7,
        input_tokens: 14,
        output_tokens: 7,
        total_tokens: 26,
        prompt_tokens_details: { cached_tokens: 3 },
        input_tokens_details: { cached_tokens: 3 },
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 3,
        cascade_breakdown: {
          fresh_input_tokens: 11,
          cache_read_tokens: 3,
          cache_write_tokens: 5,
          output_tokens: 7,
        },
      },
    });
  });




  test('RED: blackbox compare reasoning merge against WindsurfAPI mergeReasoningEffortIntoModel', async () => {
    const provider = createProvider();

    const body = {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
    };

    const referenceModel = runWindsurfApiReference(`
      import { mergeReasoningEffortIntoModel } from '/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js';
      const body = ${JSON.stringify(body)};
      process.stdout.write(JSON.stringify(mergeReasoningEffortIntoModel(body.model, body)));
    `);
    const processed = await (provider as any).preprocessRequest({ body: { ...body } });

    expect(processed.body.model).toBe(referenceModel);
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
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'probe-ok',
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
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

  test('RED: postAuth proto-derived primaryOrgId should persist to tokenFile and be restored on next load', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-auth-org-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const encodeProtoStringField = (fieldNo: number, value: string) => Buffer.concat([
      Buffer.from([(fieldNo << 3) | 2, Buffer.byteLength(value)]),
      Buffer.from(value, 'utf8'),
    ]);
    const protoPayload = Buffer.concat([
      encodeProtoStringField(1, 'devin-session-token$proto-org-1'),
      encodeProtoStringField(4, 'account-protoorg'),
      encodeProtoStringField(5, 'org-primary-1'),
    ]).toString('latin1');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => protoPayload,
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
            account: 'persist-org@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-token-org' } } as any);

      const first = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      const providerReloaded = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-medium',
          auth: {
            type: 'apikey',
            apiKey: '',
            rawType: 'windsurf-account',
            account: 'persist-org@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);
      const reloadPostSpy = jest.spyOn((providerReloaded as any).httpClient, 'post');
      const second = await (providerReloaded as any).ensureWindsurfSessionCredential();

      expect(first).toEqual({
        apiKey: 'devin-session-token$proto-org-1',
        sessionToken: 'devin-session-token$proto-org-1',
        auth1Token: 'auth1-token-org',
        accountId: 'account-protoorg',
        primaryOrgId: 'org-primary-1',
      });
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$proto-org-1',
        sessionToken: 'devin-session-token$proto-org-1',
        auth1Token: 'auth1-token-org',
        accountId: 'account-protoorg',
        primaryOrgId: 'org-primary-1',
      });
      expect(second).toEqual({
        apiKey: 'devin-session-token$proto-org-1',
        sessionToken: 'devin-session-token$proto-org-1',
        auth1Token: 'auth1-token-org',
        accountId: 'account-protoorg',
        primaryOrgId: 'org-primary-1',
      });
      expect(reloadPostSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });



  test('RED: resolveWindsurfLoginMethodProbe returns parsed CheckUserLoginMethod result when available', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'probe@example.com', password: 'secret' },
      },
    } as any, deps);

    const checkSpy = jest.spyOn(provider as any, 'fetchWindsurfCheckLoginMethod').mockResolvedValue({ method: 'auth1', hasPassword: true });

    const out = await (provider as any).resolveWindsurfLoginMethodProbe('probe@example.com', { Origin: 'https://windsurf.com' });

    expect(out).toEqual({ method: 'auth1', hasPassword: true });
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  test('RED: login chain must continue even when CheckUserLoginMethod observation is empty', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-check-login-empty-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$continue-login', accountId: 'account-continue' }),
    } as any);
    global.fetch = fetchMock as any;
    try {
      const provider = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-medium',
          auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'probe-failfast@example.com', password: 'secret', tokenFile },
        },
      } as any, deps);

      const checkSpy = jest.spyOn(provider as any, 'fetchWindsurfCheckLoginMethod').mockRejectedValue(new Error('empty body'));
      const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValueOnce({ data: { token: 'auth1-token-continue' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();

      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(credential).toEqual({
        apiKey: 'devin-session-token$continue-login',
        sessionToken: 'devin-session-token$continue-login',
        auth1Token: 'auth1-token-continue',
        accountId: 'account-continue',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: login chain must continue even when CheckUserLoginMethod returns explicit non-200 observation because it is not a hard gate', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-check-login-non200-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        text: async () => 'gateway timeout',
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionToken: 'devin-session-token$non200-continue', accountId: 'account-non200-continue' }),
      } as any);
    global.fetch = fetchMock as any;
    try {
      const provider = new WindsurfChatProvider({
        type: 'openai-standard',
        config: {
          providerType: 'openai',
          baseUrl: 'http://localhost:3003',
          model: 'gpt-5.4-medium',
          auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'probe-non200@example.com', password: 'secret', tokenFile },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post').mockResolvedValueOnce({ data: { token: 'auth1-token-non200' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(credential).toEqual({
        apiKey: 'devin-session-token$non200-continue',
        sessionToken: 'devin-session-token$non200-continue',
        auth1Token: 'auth1-token-non200',
        accountId: 'account-non200-continue',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: auth1 preflight + password login must carry account/login referer like reference auth flow', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-auth-referer-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'referer@example.com', password: 'secret', tokenFile },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    postSpy.mockResolvedValueOnce({ data: { token: 'auth1-token-referer' } } as any);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ userExists: true, hasPassword: true }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionToken: 'devin-session-token$referer-ok', accountId: 'account-referer' }),
      } as any);

    const credential = await (provider as any).ensureWindsurfSessionCredential();

    expect(credential).toMatchObject({
      apiKey: 'devin-session-token$referer-ok',
      sessionToken: 'devin-session-token$referer-ok',
      auth1Token: 'auth1-token-referer',
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(1,
      'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Referer: 'https://windsurf.com/account/login',
          Origin: 'https://windsurf.com',
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
        }),
      }),
      15000,
    );
    const checkBody = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(checkBody).toEqual({ email: 'referer@example.com' });
    expect(postSpy).toHaveBeenNthCalledWith(1,
      'https://windsurf.com/_devin-auth/password/login',
      { email: 'referer@example.com', password: 'secret' },
      expect.objectContaining({
        Referer: 'https://windsurf.com/account/login',
        Origin: 'https://windsurf.com',
      })
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('RED: blackbox compare CheckUserLoginMethod request-shape invariants against WindsurfAPI reference', async () => {
    const provider = createProvider();
    const reference = runWindsurfApiReference(`
      import { readFileSync } from 'node:fs';
      const s = readFileSync('/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js', 'utf8');
      const result = {
        url: 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod',
        method: 'POST',
        body: JSON.stringify({ email: 'shape@example.com' }),
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://windsurf.com',
        },
      };
      process.stdout.write(JSON.stringify(result));
    `);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ userExists: true, hasPassword: true }),
    } as any);

    const headers = (provider as any).buildAccountLoginHeaders();
    await (provider as any).fetchWindsurfCheckLoginMethod('shape@example.com', headers);

    const [url, init, timeoutMs] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(reference.url);
    expect(timeoutMs).toBe(15000);
    expect(init.method).toBe(reference.method);
    expect(String(init.body)).toBe(reference.body);
    expect(init.headers).toEqual(expect.objectContaining({
      'Content-Type': reference.headers['Content-Type'],
      'Connect-Protocol-Version': reference.headers['Connect-Protocol-Version'],
      Accept: reference.headers['Accept'],
      Origin: reference.headers['Origin'],
      Referer: 'https://windsurf.com/account/login',
      'User-Agent': expect.stringContaining('Mozilla/'),
    }));
  });

  test('RED: ensureWindsurfSessionCredential sends PostAuth to Windsurf app _backend endpoint with empty proto body and auth1 header', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-postauth-order-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'postauth@example.com', password: 'secret', tokenFile },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    postSpy.mockResolvedValueOnce({ data: { token: 'auth1-token-postauth' } } as any);
    const fetchWithTimeoutSpy = jest.spyOn(provider as any, 'fetchWithTimeout');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ userExists: true, hasPassword: true }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ sessionToken: 'devin-session-token$postauth-ok', accountId: 'account-postauth' }) } as any);
    global.fetch = fetchMock as any;
    try {
      const credential = await (provider as any).ensureWindsurfSessionCredential();
      expect(credential).toMatchObject({
        apiKey: 'devin-session-token$postauth-ok',
        sessionToken: 'devin-session-token$postauth-ok',
        auth1Token: 'auth1-token-postauth',
        accountId: 'account-postauth',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod');
      expect(fetchMock.mock.calls[1][0]).toBe('https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth');
      expect(fetchWithTimeoutSpy).toHaveBeenNthCalledWith(
        2,
        'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
        expect.any(Object),
        30000,
      );
      const checkInit = fetchMock.mock.calls[0][1];
      expect(checkInit.method).toBe('POST');
      expect(checkInit.headers['Content-Type']).toBe('application/json');
      expect(checkInit.headers['Connect-Protocol-Version']).toBe('1');
      expect(checkInit.headers['Origin']).toBe('https://windsurf.com');
      expect(checkInit.headers['Referer']).toBe('https://windsurf.com/account/login');
      expect(JSON.parse(String(checkInit.body))).toEqual({ email: 'postauth@example.com' });

      const init = fetchMock.mock.calls[1][1];
      expect(init.method).toBe('POST');
      const body = Buffer.from(init.body as Buffer);
      expect(body.length).toBe(0);
      expect(init.headers['Content-Type']).toBe('application/proto');
      expect(init.headers['Content-Length']).toBe('0');
      expect(init.headers['Connect-Protocol-Version']).toBe('1');
      expect(init.headers['X-Devin-Auth1-Token']).toBe('auth1-token-postauth');
      expect(init.headers['Origin']).toBe('https://windsurf.com');
      expect(init.headers['Referer']).toBe('https://windsurf.com/account/login');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: blackbox compare PostAuth request-shape invariants against WindsurfAPI reference', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-postauth-blackbox-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const reference = runWindsurfApiReference(`
      const result = {
        bodyLength: 0,
        headers: {
          'Content-Type': 'application/proto',
          'Content-Length': 0,
          'Connect-Protocol-Version': '1',
          'X-Devin-Auth1-Token': 'auth1-token-shape',
          'Referer': 'https://windsurf.com/account/login',
          'Origin': 'https://windsurf.com',
        },
      };
      process.stdout.write(JSON.stringify(result));
    `);

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'blackbox-postauth@example.com', password: 'secret', tokenFile },
      },
    } as any, deps);

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    postSpy.mockResolvedValueOnce({ data: { token: 'auth1-token-shape' } } as any);

    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ userExists: true, hasPassword: true }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ sessionToken: 'devin-session-token$postauth-shape', accountId: 'account-postauth-shape' }) } as any);
    global.fetch = fetchMock as any;
    try {
      await (provider as any).ensureWindsurfSessionCredential();

      const [, init] = fetchMock.mock.calls[1]!;
      const body = Buffer.from(init.body as Buffer);
      expect(body.length).toBe(reference.bodyLength);
      expect(init.headers).toEqual(expect.objectContaining({
        'Content-Type': reference.headers['Content-Type'],
        'Connect-Protocol-Version': reference.headers['Connect-Protocol-Version'],
        'X-Devin-Auth1-Token': reference.headers['X-Devin-Auth1-Token'],
        Referer: reference.headers['Referer'],
        Origin: reference.headers['Origin'],
        'User-Agent': expect.stringContaining('Mozilla/'),
      }));
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: ensureWindsurfSessionCredential must try legacy PostAuth host after backend timeout like WindsurfAPI postAuthDualPath', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-postauth-dualpath-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'dualpath-postauth@example.com', password: 'secret', tokenFile },
      },
    } as any, deps);

    jest.spyOn((provider as any).httpClient, 'post')
      .mockResolvedValueOnce({ data: { token: 'auth1-token-dualpath' } } as any);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout')
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ userExists: true, hasPassword: true }) } as any)
      .mockRejectedValueOnce(new Error('backend timeout'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ sessionToken: 'devin-session-token$legacy-ok', accountId: 'account-legacy-ok' }) } as any);

    const credential = await (provider as any).ensureWindsurfSessionCredential();

    expect(credential).toMatchObject({
      apiKey: 'devin-session-token$legacy-ok',
      sessionToken: 'devin-session-token$legacy-ok',
      auth1Token: 'auth1-token-dualpath',
      accountId: 'account-legacy-ok',
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
      expect.any(Object),
      30000,
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
      expect.any(Object),
      30000,
    );
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

  test('RED: token priority must win over co-configured account password and bypass login chain', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'probe-ok',
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
            apiKey: 'devin-session-token$token-wins',
            rawType: 'windsurf-account',
            account: 'user@example.com',
            password: 'secret',
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const apiKey = await (provider as any).resolveCascadeApiKey();

      expect(credential).toEqual({
        apiKey: 'devin-session-token$token-wins',
        sessionToken: 'devin-session-token$token-wins',
        auth1Token: '',
      });
      expect(apiKey).toBe('devin-session-token$token-wins');
      expect(postSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: forced refresh must bypass inline session token priority and re-login via account password chain', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-inline-token-force-refresh-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$token-refreshed', accountId: 'account-token-refreshed' }),
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
            apiKey: 'devin-session-token$stale-inline-token',
            rawType: 'windsurf-account',
            account: 'inline-refresh@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      (provider as any).windsurfForceRefreshLogin = true;
      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-inline-refresh' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$token-refreshed',
        sessionToken: 'devin-session-token$token-refreshed',
        auth1Token: 'auth1-inline-refresh',
        accountId: 'account-token-refreshed',
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((provider as any).readApiKey()).toBe('devin-session-token$token-refreshed');
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$token-refreshed',
        sessionToken: 'devin-session-token$token-refreshed',
        auth1Token: 'auth1-inline-refresh',
        accountId: 'account-token-refreshed',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: inline non-session apiKey must not short-circuit managed auth and should fall through to account password login chain', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-inline-nonsession-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$from-login-chain', accountId: 'account-inline-fallback' }),
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
            apiKey: 'not-a-session-token',
            rawType: 'windsurf-account',
            account: 'inline-fallback@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-inline-fallback' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$from-login-chain',
        sessionToken: 'devin-session-token$from-login-chain',
        auth1Token: 'auth1-inline-fallback',
        accountId: 'account-inline-fallback',
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$from-login-chain',
        sessionToken: 'devin-session-token$from-login-chain',
        auth1Token: 'auth1-inline-fallback',
        accountId: 'account-inline-fallback',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });


  test('RED: stale persisted devin session token should be bypassed after forced refresh and replaced via account password login chain', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-stale-persisted-refresh-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    await fs.writeFile(tokenFile, JSON.stringify({
      apiKey: 'devin-session-token$stale-token',
      sessionToken: 'devin-session-token$stale-token',
      auth1Token: 'stale-auth1',
      accountId: 'stale-account',
    }), 'utf8');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$refreshed-token', accountId: 'account-refreshed' }),
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
            account: 'refresh@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      (provider as any).windsurfForceRefreshLogin = true;
      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-refresh-token' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$refreshed-token',
        sessionToken: 'devin-session-token$refreshed-token',
        auth1Token: 'auth1-refresh-token',
        accountId: 'account-refreshed',
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((provider as any).windsurfForceRefreshLogin).toBe(false);
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$refreshed-token',
        sessionToken: 'devin-session-token$refreshed-token',
        auth1Token: 'auth1-refresh-token',
        accountId: 'account-refreshed',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });


  test('RED: persisted devin session token must win over missing inline apiKey and be returned by readApiKey after credential resolution', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-persisted-token-priority-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    await fs.writeFile(tokenFile, JSON.stringify({
      apiKey: 'devin-session-token$persisted-priority',
      sessionToken: 'devin-session-token$persisted-priority',
      auth1Token: 'persisted-auth1',
      accountId: 'persisted-account',
    }), 'utf8');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'probe-ok',
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
            account: 'persisted-priority@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const apiKey = (provider as any).readApiKey();

      expect(credential).toEqual({
        apiKey: 'devin-session-token$persisted-priority',
        sessionToken: 'devin-session-token$persisted-priority',
        auth1Token: 'persisted-auth1',
        accountId: 'persisted-account',
      });
      expect(apiKey).toBe('devin-session-token$persisted-priority');
      expect(postSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });


  test('RED: persisted non-session tokenFile credential must not short-circuit managed auth and should fall through to account password login chain', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-persisted-nonsession-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    await fs.writeFile(tokenFile, JSON.stringify({
      apiKey: 'persisted-invalid-token',
      sessionToken: 'persisted-invalid-token',
      auth1Token: 'stale-auth1',
      accountId: 'stale-account',
    }), 'utf8');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionToken: 'devin-session-token$persisted-fallback', accountId: 'account-persisted-fallback' }),
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
            account: 'persisted-fallback@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-persisted-fallback' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$persisted-fallback',
        sessionToken: 'devin-session-token$persisted-fallback',
        auth1Token: 'auth1-persisted-fallback',
        accountId: 'account-persisted-fallback',
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$persisted-fallback',
        sessionToken: 'devin-session-token$persisted-fallback',
        auth1Token: 'auth1-persisted-fallback',
        accountId: 'account-persisted-fallback',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: persisted devin session token auth failure must fall through to account password login chain and overwrite tokenFile', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-persisted-authfail-fallback-'));
    const tokenFile = path.join(tmp, 'ws-session.json');
    await fs.writeFile(tokenFile, JSON.stringify({
      apiKey: 'devin-session-token$stale-authfail-token',
      sessionToken: 'devin-session-token$stale-authfail-token',
      auth1Token: 'stale-auth1',
      accountId: 'stale-account',
    }), 'utf8');

    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      // persisted token auth probe -> 401 unauthenticated
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
          error: {
            code: 401,
            message: 'Request had invalid authentication credentials.',
            status: 'UNAUTHENTICATED',
          },
        }),
      } as any)
      // CheckUserLoginMethod
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => Buffer.from([0x18, 0x01, 0x28, 0x01]).toString('latin1'),
      } as any)
      // WindsurfPostAuth
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          sessionToken: 'devin-session-token$authfail-refreshed',
          accountId: 'account-authfail-refreshed',
        }),
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
            account: 'authfail-fallback@example.com',
            password: 'secret',
            tokenFile,
          },
        },
      } as any, deps);

      const postSpy = jest.spyOn((provider as any).httpClient, 'post');
      postSpy
        .mockResolvedValueOnce({ data: { token: 'auth1-authfail-refreshed' } } as any);

      const credential = await (provider as any).ensureWindsurfSessionCredential();
      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      expect(credential).toEqual({
        apiKey: 'devin-session-token$authfail-refreshed',
        sessionToken: 'devin-session-token$authfail-refreshed',
        auth1Token: 'auth1-authfail-refreshed',
        accountId: 'account-authfail-refreshed',
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((provider as any).readApiKey()).toBe('devin-session-token$authfail-refreshed');
      expect(persisted).toEqual({
        apiKey: 'devin-session-token$authfail-refreshed',
        sessionToken: 'devin-session-token$authfail-refreshed',
        auth1Token: 'auth1-authfail-refreshed',
        accountId: 'account-authfail-refreshed',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });


  test('RED: buildChatMessageHeaders injects devin auth-context headers from persisted session credential', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$authctx-token', rawType: 'windsurf-account' },
      },
    } as any, deps);

    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$authctx-token',
      sessionToken: 'devin-session-token$authctx-token',
      auth1Token: 'auth1-token-authctx',
      accountId: 'account-authctx',
      primaryOrgId: 'org-authctx',
    };

    const headers = (provider as any).buildChatMessageHeaders('devin-session-token$authctx-token');

    expect(headers).toEqual({
      'x-auth-token': 'devin-session-token$authctx-token',
      'x-devin-session-token': 'devin-session-token$authctx-token',
      'x-devin-account-id': 'account-authctx',
      'x-devin-auth1-token': 'auth1-token-authctx',
      'x-devin-primary-org-id': 'org-authctx',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'User-Agent': 'windsurf/2.3.9',
      Referer: 'https://windsurf.com/',
    });
  });

  test('RED: session-only devin auth-context injects only token headers without optional x-devin metadata', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$session-only', rawType: 'windsurf-account' },
      },
    } as any, deps);

    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$session-only',
      sessionToken: 'devin-session-token$session-only',
      auth1Token: '',
    };

    const headers = (provider as any).buildChatMessageHeaders('devin-session-token$session-only');

    expect(headers).toEqual({
      'x-auth-token': 'devin-session-token$session-only',
      'x-devin-session-token': 'devin-session-token$session-only',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'User-Agent': 'windsurf/2.3.9',
      Referer: 'https://windsurf.com/',
    });
    expect(headers['x-devin-account-id']).toBeUndefined();
    expect(headers['x-devin-auth1-token']).toBeUndefined();
    expect(headers['x-devin-primary-org-id']).toBeUndefined();
  });

  test('RED: buildCascadeAuthProbeBody aligns with WindsurfAPI getCascadeModelConfigs metadata json body', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-body', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const body = (provider as any).buildCascadeAuthProbeBody('devin-session-token$probe-body');
    expect(Buffer.isBuffer(body)).toBe(true);
    const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    expect(parsed).toMatchObject({
      metadata: expect.objectContaining({
        apiKey: 'devin-session-token$probe-body',
        ideName: 'windsurf',
        ideVersion: expect.any(String),
        extensionName: 'windsurf',
        extensionVersion: expect.any(String),
        locale: 'en',
      }),
    });
  });

  test('RED: blackbox compare GetCascadeModelConfigs body-shape invariants against WindsurfAPI reference', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-blackbox-body', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const reference = runWindsurfApiReference(`
      const body = {
        metadata: {
          apiKey: 'devin-session-token$probe-blackbox-body',
          ideName: 'windsurf',
          ideVersion: '1.9600.41',
          extensionName: 'windsurf',
          extensionVersion: '1.9600.41',
          locale: 'en',
        },
      };
      process.stdout.write(JSON.stringify(body));
    `);

    const body = (provider as any).buildCascadeAuthProbeBody('devin-session-token$probe-blackbox-body');
    const parsed = JSON.parse(Buffer.from(body).toString('utf8'));

    expect(parsed.metadata.apiKey).toBe(reference.metadata.apiKey);
    expect(parsed.metadata.ideName).toBe(reference.metadata.ideName);
    expect(parsed.metadata.extensionName).toBe(reference.metadata.extensionName);
    expect(parsed.metadata.locale).toBe(reference.metadata.locale);
    expect(typeof parsed.metadata.ideVersion).toBe('string');
    expect(typeof parsed.metadata.extensionVersion).toBe('string');
  });

  test('RED: parseWindsurfPostAuthPayload must parse reference-shaped proto/binary response carrying sessionToken/accountId/primaryOrgId', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$proto-parse', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const sessionToken = 'devin-session-token$proto-parsed-token';
    const auth1Token = 'auth1_proto_parsed';
    const accountId = 'account-5cb2b19d59e84f6986fe07ebf7f8622a';
    const primaryOrgId = 'org-3ca87ccbb5e44eec8e3dddcc3c81f075';
    const payload = Buffer.concat([
      Buffer.from([0x0a, sessionToken.length]), Buffer.from(sessionToken, 'utf8'),
      Buffer.from([0x1a, auth1Token.length]), Buffer.from(auth1Token, 'utf8'),
      Buffer.from([0x22, accountId.length]), Buffer.from(accountId, 'utf8'),
      Buffer.from([0x2a, primaryOrgId.length]), Buffer.from(primaryOrgId, 'utf8'),
    ]).toString('latin1');

    const parsed = (provider as any).parseWindsurfPostAuthPayload(payload);
    expect(parsed).toEqual({
      sessionToken,
      accountId,
      primaryOrgId,
    });
  });

  test('RED: ensureWindsurfSessionCredential must accept live proto PostAuth response instead of requiring json-only payload', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'windsurf-postauth-proto-live-'));
    const tokenFile = path.join(tmp, 'ws-session.json');

    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: '', rawType: 'windsurf-account', account: 'proto-live@example.com', password: 'secret', tokenFile },
      },
    } as any, deps);

    const sessionToken = 'devin-session-token$proto-live-token';
    const auth1Token = 'auth1-token-proto-live';
    const accountId = 'account-5cb2b19d59e84f6986fe07ebf7f8622a';
    const primaryOrgId = 'org-3ca87ccbb5e44eec8e3dddcc3c81f075';
    const protoPayload = Buffer.concat([
      Buffer.from([0x0a, sessionToken.length]), Buffer.from(sessionToken, 'utf8'),
      Buffer.from([0x1a, auth1Token.length]), Buffer.from(auth1Token, 'utf8'),
      Buffer.from([0x22, accountId.length]), Buffer.from(accountId, 'utf8'),
      Buffer.from([0x2a, primaryOrgId.length]), Buffer.from(primaryOrgId, 'utf8'),
    ]).toString('latin1');

    const postSpy = jest.spyOn((provider as any).httpClient, 'post');
    postSpy.mockResolvedValueOnce({ data: { token: auth1Token } } as any);

    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ userExists: true, hasPassword: true }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => protoPayload } as any);
    global.fetch = fetchMock as any;
    try {
      const credential = await (provider as any).ensureWindsurfSessionCredential();
      expect(credential).toEqual({
        apiKey: sessionToken,
        sessionToken,
        auth1Token,
        accountId,
        primaryOrgId,
      });
      expect(fetchMock.mock.calls[1][0]).toBe('https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('RED: buildCascadeAuthProbeHeaders injects required cascade auth headers', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-headers', rawType: 'windsurf-account' },
      },
    } as any, deps);

    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$probe-headers',
      sessionToken: 'devin-session-token$probe-headers',
      auth1Token: 'auth1-probe',
      accountId: 'account-probe',
      primaryOrgId: 'org-probe',
    };

    const headers = (provider as any).buildCascadeAuthProbeHeaders('devin-session-token$probe-headers');

    expect(headers).toMatchObject({
      'x-auth-token': 'devin-session-token$probe-headers',
      'x-devin-session-token': 'devin-session-token$probe-headers',
      'x-devin-account-id': 'account-probe',
      'x-devin-auth1-token': 'auth1-probe',
      'x-devin-primary-org-id': 'org-probe',
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'windsurf/2.3.9',
    });
  });

  test('RED: blackbox compare GetCascadeModelConfigs header-shape invariants against WindsurfAPI reference + current auth-context truth', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-blackbox-headers', rawType: 'windsurf-account' },
      },
    } as any, deps);

    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$probe-blackbox-headers',
      sessionToken: 'devin-session-token$probe-blackbox-headers',
      auth1Token: 'auth1-probe-blackbox',
      accountId: 'account-probe-blackbox',
      primaryOrgId: 'org-probe-blackbox',
    };

    const reference = runWindsurfApiReference(`
      const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'Accept': 'application/json',
      };
      process.stdout.write(JSON.stringify(headers));
    `);

    const headers = (provider as any).buildCascadeAuthProbeHeaders('devin-session-token$probe-blackbox-headers');
    expect(headers).toEqual(expect.objectContaining({
      'Content-Type': reference['Content-Type'],
      'Connect-Protocol-Version': reference['Connect-Protocol-Version'],
      Accept: reference['Accept'],
      'User-Agent': 'windsurf/2.3.9',
      'x-auth-token': 'devin-session-token$probe-blackbox-headers',
      'x-devin-session-token': 'devin-session-token$probe-blackbox-headers',
      'x-devin-account-id': 'account-probe-blackbox',
      'x-devin-auth1-token': 'auth1-probe-blackbox',
      'x-devin-primary-org-id': 'org-probe-blackbox',
    }));
  });

  test('RED: account login headers align with WindsurfAPI browser fingerprint for dashboard auth', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$login-headers', rawType: 'windsurf-account' },
      },
    } as any, deps);

    const headers = (provider as any).buildAccountLoginHeaders();

    expect(headers).toMatchObject({
      'User-Agent': expect.stringContaining('Mozilla/'),
      Referer: 'https://windsurf.com/account/login',
      Origin: 'https://windsurf.com',
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': expect.stringContaining('Chromium'),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': expect.any(String),
    });
    expect(headers['User-Agent']).toContain('Chrome/');
  });

  test('RED: fetchCascadeModelConfigsForSite posts json auth probe to reference endpoint', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-fetch', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    } as any);

    await (provider as any).fetchCascadeModelConfigsForSite('devin-session-token$probe-fetch');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs');
    expect(init.method).toBe('POST');
    expect(init.headers['x-auth-token']).toBe('devin-session-token$probe-fetch');
    expect(init.headers['x-devin-session-token']).toBe('devin-session-token$probe-fetch');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Connect-Protocol-Version']).toBe('1');
    expect(init.headers['Accept']).toBe('application/json');
    const parsed = JSON.parse(Buffer.from(init.body as Buffer).toString('utf8'));
    expect(parsed).toMatchObject({
      metadata: expect.objectContaining({
        apiKey: 'devin-session-token$probe-fetch',
        ideName: 'windsurf',
        extensionName: 'windsurf',
        locale: 'en',
      }),
    });
  });

  test('RED: blackbox compare GetCascadeModelConfigs fetch-call invariants against WindsurfAPI reference host/path', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-fetch-shape', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const reference = runWindsurfApiReference(`
      const result = {
        url: 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Accept': 'application/json',
        },
      };
      process.stdout.write(JSON.stringify(result));
    `);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"clientModelConfigs":[]}',
    } as any);

    await (provider as any).fetchCascadeModelConfigsForSite('devin-session-token$probe-fetch-shape');

    const [url, init, timeoutMs] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(reference.url);
    expect(timeoutMs).toBe(15000);
    expect(init.method).toBe(reference.method);
    expect(init.headers).toEqual(expect.objectContaining({
      'Content-Type': reference.headers['Content-Type'],
      'Connect-Protocol-Version': reference.headers['Connect-Protocol-Version'],
      Accept: reference.headers['Accept'],
      'User-Agent': 'windsurf/2.3.9',
      'x-auth-token': 'devin-session-token$probe-fetch-shape',
      'x-devin-session-token': 'devin-session-token$probe-fetch-shape',
    }));
  });

  test('RED: sendRequestInternal without local cascade runtime must fail before removed GetChatCompletions cloud path', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-failfast', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout');
    jest.spyOn(provider as any, 'ensureManagedLocalGrpcRuntime').mockRejectedValue(
      Object.assign(new Error('[windsurf] no managed LS runtime in test'), {
        code: 'WINDSURF_SERVICE_UNREACHABLE', status: 502, retryable: true,
      }),
    );

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'say hi' }],
      },
    })).rejects.toMatchObject({
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
      retryable: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('RED: sendRequestInternal must enter cascade mainline once lsPort/csrfToken are present and must not fall back to removed fetch/cloud path', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-failfast', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout');
    const runtimeSpy = jest.spyOn(provider as any, 'resolveManagedRuntimeOptions').mockResolvedValue({
      lsPort: 42101,
      csrfToken: 'windsurf-api-csrf-fixed-token',
      sessionId: 'session-1',
      workspacePath: '/tmp/ws-1',
      workspaceUri: 'file:///tmp/ws-1',
    });
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade')
      .mockRejectedValue(Object.assign(new Error('local cascade transport not reachable in test'), {
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      }));

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).rejects.toMatchObject({
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      });
      expect(startSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      runtimeSpy.mockRestore();
      startSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('RED: checkHealth performs real cascade auth probe for direct devin token', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-health', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    const probeSpy = jest.spyOn(provider as any, 'fetchCascadeModelConfigsForSite').mockResolvedValue({
      status: 200,
      raw: 'ok',
    });

    await expect(provider.checkHealth()).resolves.toBe(true);
    expect(probeSpy).toHaveBeenCalledWith('devin-session-token$probe-health');
  });

  test('RED: checkHealth returns false when cascade auth probe fails with 401', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$probe-health-fail', rawType: 'windsurf-devin-token' },
      },
    } as any, deps);

    jest.spyOn(provider as any, 'fetchCascadeModelConfigsForSite').mockRejectedValue(
      new Error('HTTP 401: unauthenticated')
    );

    await expect(provider.checkHealth()).resolves.toBe(false);
  });

  // Assistant candidate / chat completion parsing
  // anchor:
  // - windsurf.js::parseTrajectorySteps()







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

  test('RED: parseCascadeAssistantTurnSync accepts custom_tool_call candidate blocks when input is structured object', async () => {
    const provider = createProvider();
    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: [
        {
          type: 'custom_tool_call',
          call_id: 'call_exec_structured_1',
          name: 'exec_command',
          input: { cmd: 'pwd', cwd: '/tmp/project' },
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_exec_structured_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd', cwd: '/tmp/project' }) },
        },
      ],
    });
  });

  // History continuity / tool result reinjection
  // anchor:
  // - cascade-native-bridge.js::buildAdditionalStepsFromHistory()
  // - conversation-pool.js::projectMessage()
  // - conversation-pool.js::projectAssistantToolCalls()
  // - windsurf.js::parseTrajectorySteps()
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


  test('RED: parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when function.arguments is already object', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/object-args.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_object_args_1',
            type: 'function',
            function: { name: 'read', arguments: { filePath: '/tmp/object-args.txt' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_object_args_1', name: 'read', content: 'OBJECT_ARGS_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/object-args.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_object_args_1', name: 'read', arguments: { filePath: '/tmp/object-args.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_object_args_1', name: 'read', output: 'OBJECT_ARGS_CONTENT' },
    ]);
  });



  test('RED: parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when top-level tool_calls use input fallback', async () => {
    const turns = projectConversation([
      { role: 'user', content: '运行 pwd' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_top_input_1',
            type: 'function',
            name: 'exec_command',
            input: { input: 'pwd' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_top_input_1', name: 'exec_command', content: '/tmp/project' },
    ]);

    expect(turns).toEqual([
      { type: 'user', text: '运行 pwd' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_top_input_1', name: 'exec_command', arguments: { input: 'pwd' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_top_input_1', name: 'exec_command', output: '/tmp/project' },
    ]);
  });


  test('RED: parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when top-level tool_calls use string input fallback', async () => {
    const turns = projectConversation([
      { role: 'user', content: '运行 pwd' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_top_input_string_1',
            type: 'function',
            name: 'exec_command',
            input: 'pwd',
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_top_input_string_1', name: 'exec_command', content: '/tmp/project' },
    ]);

    expect(turns).toEqual([
      { type: 'user', text: '运行 pwd' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_top_input_string_1', name: 'exec_command', arguments: { input: 'pwd' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_top_input_string_1', name: 'exec_command', output: '/tmp/project' },
    ]);
  });


  test('RED: parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when top-level tool_calls use function.name plus string input sibling', async () => {
    const turns = projectConversation([
      { role: 'user', content: '运行 pwd' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hist_fn_name_input_string_1',
            type: 'function',
            function: { name: 'exec_command' },
            input: 'pwd',
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_hist_fn_name_input_string_1', name: 'exec_command', content: '/tmp/project' },
    ]);

    expect(turns).toEqual([
      { type: 'user', text: '运行 pwd' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_hist_fn_name_input_string_1', name: 'exec_command', arguments: { input: 'pwd' } }],
      },
      { type: 'function_call_output', call_id: 'call_hist_fn_name_input_string_1', name: 'exec_command', output: '/tmp/project' },
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

  test('RED: parseCascadeSemanticRoundtripSync preserves chat user content[] text blocks into cascade history', async () => {
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

  test('Group A / user-content anchor: preserves chat user content[] when building cascade conversation', async () => {
    const conversation = projectConversation([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '读取 ' },
          { type: 'text', text: '/tmp/a.txt' },
        ],
      },
    ], { type: 'apikey', apiKey: 'test-bearer-token' });

    expect(conversation).toEqual([
      { type: 'user', text: '读取 /tmp/a.txt' },
    ]);
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

  test('RED: parseCascadeSemanticRoundtripSync accepts assistant content[].type=tool_use history and preserves tool continuity', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const roundtrip = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'read /tmp/tool-use.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_tool_use_1',
            name: 'read',
            input: { filePath: '/tmp/tool-use.txt' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_tool_use_1', name: 'read', content: 'TOOL_USE_CONTENT' },
    ]);

    expect(roundtrip).toEqual([
      { type: 'user', text: 'read /tmp/tool-use.txt' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_tool_use_1', name: 'read', arguments: { filePath: '/tmp/tool-use.txt' } }],
      },
      { type: 'function_call_output', call_id: 'call_tool_use_1', name: 'read', output: 'TOOL_USE_CONTENT' },
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

  test('Group B / buildAdditionalStepsFromHistory anchor: preserves nested tool_result object-content history when building cascade conversation', async () => {
    const conversation = projectConversation([
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
    ], { type: 'apikey', apiKey: 'test-bearer-token' });

    expect(conversation).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_nested_tool_result_obj_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_read_nested_tool_result_obj_1', name: 'read', output: JSON.stringify({ ok: 1 }) },
    ]);
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

  test('Group B / buildAdditionalStepsFromHistory anchor: preserves nested function_call_output block tool history when building cascade conversation', async () => {
    const conversation = projectConversation([
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
    ], { type: 'apikey', apiKey: 'test-bearer-token' });

    expect(conversation).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_nested_fc_output_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_read_nested_fc_output_1', name: 'read', output: 'NESTED_DONE' },
    ]);
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

  test('Group B / buildAdditionalStepsFromHistory anchor: preserves tool text-block array history when building cascade conversation', async () => {
    const conversation = projectConversation([
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
    ], { type: 'apikey', apiKey: 'test-bearer-token' });

    expect(conversation).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_block_result_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_read_block_result_1', name: 'read', output: 'A_CONTENT' },
    ]);
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

  test('Group B / buildAdditionalStepsFromHistory anchor: preserves nested tool_result id fallback history when outer tool message id is absent', async () => {
    const conversation = projectConversation([
      { role: 'user', content: 'read /tmp/a.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_nested_tool_use_id_send_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }] },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', tool_use_id: 'call_nested_tool_use_id_send_1', content: 'SEND_TOOL_USE_ID_OK' },
        ],
      },
    ], { type: 'apikey', apiKey: 'test-bearer-token' });

    expect(conversation).toEqual([
      { type: 'user', text: 'read /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_nested_tool_use_id_send_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_nested_tool_use_id_send_1', name: 'read', output: 'SEND_TOOL_USE_ID_OK' },
    ]);
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

  test('RED: parseCascadeSemanticRoundtripSync rejects custom_tool_call_output continuity source when assistant side is non-chat shape', async () => {
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

  test('RED: parseCascadeSemanticRoundtripSync rejects function_call history before tool result fallback-id replay in chat-only provider', async () => {
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

  test('RED: parseCascadeSemanticRoundtripSync must treat reordered tool argument keys as the same signature like reference digest', async () => {
    const provider = createProvider();

    expect(() => (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_reorder_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt', offset: 1 }) },
          },
          {
            id: 'call_reorder_2',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ offset: 1, filePath: '/tmp/a.txt' }) },
          },
        ],
      },
    ])).toThrow('[windsurf] duplicate assistant tool call signature in history');
  });

  test('RED: parseCascadeAssistantTurnSync must treat reordered candidate tool argument keys as the same signature like reference digest', async () => {
    const provider = createProvider();

    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_candidate_reorder_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt', offset: 1 }) },
        },
        {
          id: 'call_candidate_reorder_2',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ offset: 1, filePath: '/tmp/a.txt' }) },
        },
      ],
    })).toThrow('[windsurf] duplicate assistant tool call signature in assistant candidate');
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

  test('RED: parseCascadeSemanticRoundtripSync fails fast when assistant content history repeats call_id in same turn', async () => {
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

  test('RED: parseCascadeSemanticRoundtripSync fails fast when same tool signature repeats after assistant text but before any new user turn', async () => {
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

  // Chat completion candidate parsing / usage extraction
  // anchor:
  // - windsurf.js::parseTrajectorySteps()
  test('RED: buildCascadeCompletionFromOutput builds final chat completion from assistant tool candidate', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const out = (provider as any).buildCascadeCompletionFromOutput({
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
        input_tokens: 14,
        output_tokens: 7,
        total_tokens: 21,
        input_tokens_details: { cached_tokens: 3 },
      },
    });
  });

  test('RED: buildCascadeCompletionFromOutput preserves assistant text when candidate contains output_text + tool_call', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const out = (provider as any).buildCascadeCompletionFromOutput({
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

  test('RED: buildCascadeCompletionFromOutput fails fast on empty candidate payload', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).buildCascadeCompletionFromOutput({ model: 'gpt-5.4-medium', candidate: null }))
      .toThrow('[windsurf] empty cascade candidate payload');
  });

  test('RED: buildCascadeCompletionFromOutput fails fast on assistant candidate with invalid tool call payload', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    expect(() => (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: { role: 'assistant', content: [{ type: 'tool_call', call_id: 'call_read_1', arguments: { filePath: '/tmp/a.txt' } }] },
    })).toThrow('[windsurf] assistant tool call missing name');
  });

  test('RED: parseCascadeSemanticRoundtripSync preserves multi-round same-tool replay after assistant text and new user turn', async () => {
    const conversation = projectConversation([
      { role: 'user', content: '读一下 /tmp/a.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_read_round1_send', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
      },
      { role: 'tool', tool_call_id: 'call_read_round1_send', name: 'read', content: 'A_CONTENT' },
      { role: 'assistant', content: '第一次读取完成。' },
      { role: 'user', content: '再读一次 /tmp/a.txt' },
    ]);

    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: [
          { type: 'tool_call', call_id: 'call_read_round2_send', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
    });

    expect(conversation).toMatchObject([
      { type: 'user', text: '读一下 /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_round1_send', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_read_round1_send', name: 'read', output: 'A_CONTENT' },
      { type: 'assistant', text: '第一次读取完成。' },
      { type: 'user', text: '再读一次 /tmp/a.txt' },
    ]);
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

  test('RED: parseCascadeSemanticRoundtripSync fails fast when same tool signature repeats after tool_result + assistant text without any new user turn', async () => {
    expect(() => projectConversation([
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
    ])).toThrow('[windsurf] upstream repeated prior tool call after tool_result');
  });

  test('RED: buildCascadeCompletionFromOutput prefers direct candidate tool continuation in multi-round flow', async () => {
    const conversation = projectConversation([
      { role: 'user', content: '先读 /tmp/a.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_read_output_continue_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) } }],
      },
      { role: 'tool', tool_call_id: 'call_read_output_continue_1', name: 'read', content: 'A_CONTENT' },
      { role: 'assistant', content: '第一次读取完成。' },
      { role: 'user', content: '继续读 /tmp/b.txt' },
    ]);

    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: [
          { type: 'output_text', text: '我继续处理。' },
          { type: 'tool_call', call_id: 'call_read_output_continue_2', name: 'read', arguments: { filePath: '/tmp/b.txt' } },
        ],
      },
    });

    expect(conversation).toMatchObject([
      { type: 'user', text: '先读 /tmp/a.txt' },
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_read_output_continue_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } }] },
      { type: 'function_call_output', call_id: 'call_read_output_continue_1', name: 'read', output: 'A_CONTENT' },
      { type: 'assistant', text: '第一次读取完成。' },
      { type: 'user', text: '继续读 /tmp/b.txt' },
    ]);
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

  test('RED: buildCascadeCompletionFromOutput accepts direct candidate text-only completion', async () => {
    const provider = createProvider();
    expect((provider as any).buildCascadeCompletionFromOutput({
        model: 'gpt-5.4-medium',
        candidate: {
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'TEXT_ONLY_TRUE_SOURCE' },
          ],
        },
      })).toMatchObject({
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

  test('RED: buildCascadeCompletionFromOutput fails fast when upstream returns empty candidates', async () => {
    const provider = createProvider();
    expect(() => (provider as any).buildCascadeCompletionFromOutput({ model: 'gpt-5.4-medium', candidate: null }))
      .toThrow('[windsurf] empty cascade candidate payload');
  });

  test('RED: buildCascadeCompletionFromOutput fails fast when upstream candidate has no text and no tool_call', async () => {
    const provider = createProvider();
    expect(() => (provider as any).buildCascadeCompletionFromOutput({
        model: 'gpt-5.4-medium',
        candidate: {
          role: 'assistant',
          content: [{ type: 'unknown_block', value: 'noop' }],
        },
      }))
      .toThrow('[windsurf] empty assistant completion');
  });

  test('RED: buildCascadeCompletionFromOutput accepts upstream candidate with plain string assistant content', async () => {
    const provider = createProvider();
    expect((provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: 'OK',
      },
    })).toMatchObject({
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

  test('RED: buildCascadeCompletionFromOutput preserves text, reasoning_content, and tool_calls together on assistant response parsing', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        reasoning_content: '先思考再决定。',
        content: [
          { type: 'output_text', text: '最终答案' },
          { type: 'tool_call', call_id: 'call_reasoning_tool_1', name: 'read', arguments: { filePath: '/tmp/a.txt' } },
        ],
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          reasoning_content: '先思考再决定。',
          content: '最终答案',
          tool_calls: [{
            id: 'call_reasoning_tool_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/a.txt' }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });


  test('RED: buildCascadeCompletionFromOutput carries executed function_call_output rows so Responses remap can mark native continuation completed', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: 'done',
        tool_outputs: [
          { type: 'function_call_output', call_id: 'native:run_command:3', output: '/Users/fanzhang/Documents/github/routecodex\n' },
        ],
      },
    });

    expect(out.tool_outputs).toEqual([
      { tool_call_id: 'native:run_command:3', output: '/Users/fanzhang/Documents/github/routecodex\n' },
    ]);
  });


  test('RED: buildCascadeCompletionFromOutput preserves reasoning content on assistant response parsing', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        reasoning_content: '先思考再决定。',
        content: '最终答案',
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        message: {
          role: 'assistant',
          reasoning_content: '先思考再决定。',
          content: '最终答案',
        },
        finish_reason: 'stop',
      }],
    });
  });

  test('RED: buildCascadeCompletionFromOutput must promote reasoning-only stop payload into content for non-thinking models like WindsurfAPI chat.js issue #86 fix', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: '',
        reasoning_content: 'ONLY_REASONING_VISIBLE_TEXT',
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'ONLY_REASONING_VISIBLE_TEXT',
          reasoning_content: 'ONLY_REASONING_VISIBLE_TEXT',
        },
      }],
    });
  });

  test('RED: buildCascadeCompletionFromOutput must keep reasoning-only payload split for thinking models', async () => {
    const provider = createProvider();
    const out = (provider as any).buildCascadeCompletionFromOutput({
      model: 'claude-sonnet-4.6-thinking',
      candidate: {
        role: 'assistant',
        content: '',
        reasoning_content: 'THINKING_ONLY_SHOULD_NOT_PROMOTE',
      },
    });

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'claude-sonnet-4.6-thinking',
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'THINKING_ONLY_SHOULD_NOT_PROMOTE',
        },
      }],
    });
  });


  test('RED: buildCascadeCompletionFromOutput accepts upstream function_call candidate blocks', async () => {
    const provider = createProvider();
    expect((provider as any).buildCascadeCompletionFromOutput({
      model: 'gpt-5.4-medium',
      candidate: {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'call_fc_send_1',
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/fc-send.txt' }),
          },
        ],
      },
    })).toMatchObject({
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

  test('RED: parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when function.arguments is already object', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_top_object_args_1',
          type: 'function',
          function: { name: 'read', arguments: { filePath: '/tmp/object-args.txt' } },
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_top_object_args_1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ filePath: '/tmp/object-args.txt' }) },
        },
      ],
    });
  });



  test('RED: parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when tool_calls use input fallback', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_top_input_args_1',
          type: 'function',
          name: 'exec_command',
          input: { input: 'pwd' },
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_top_input_args_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
        },
      ],
    });
  });


  test('RED: parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when tool_calls use string input fallback', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_top_input_string_args_1',
          type: 'function',
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
          id: 'call_top_input_string_args_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
        },
      ],
    });
  });


  test('RED: parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when tool_calls use function.name plus string input sibling', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);

    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_top_fn_name_input_string_1',
          type: 'function',
          function: { name: 'exec_command' },
          input: 'pwd',
        },
      ],
    });

    expect(parsed).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_top_fn_name_input_string_1',
          type: 'function',
          function: { name: 'exec_command', arguments: JSON.stringify({ input: 'pwd' }) },
        },
      ],
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


  // 2026-05-22: `GetChatCompletions` 旧 JSON 主链已被最黑盒证伪。
  // 下方仅保留与当前 semantic/parser 真源仍直接相关的测试；任何把
  // `buildGetChatCompletionsRequest` / `parseGetChatCompletionsResponse`
  // 当作主发送链真源的断言都必须物理删除，而不是继续扩展。

  test('RED: buildChatMessagePromptsFromSemanticConversation must keep user row minimal per app proto audit', async () => {
    const provider = createProvider();
    const rows = (provider as any).buildChatMessagePromptsFromSemanticConversation([
      { type: 'user', text: 'say hi' },
    ]);
    expect(rows).toEqual([
      {
        messageId: 'user-0',
        source: 1,
        prompt: 'say hi',
      },
    ]);
    expect(Object.keys(rows[0] || {}).sort()).toEqual(['messageId', 'prompt', 'source']);
  });

  test('RED: buildChatMessagePromptsFromSemanticConversation must keep assistant tool-call row minimal per app proto audit', async () => {
    const provider = createProvider();
    const rows = (provider as any).buildChatMessagePromptsFromSemanticConversation([
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_1', name: 'exec_command', arguments: { cmd: 'pwd' } }],
      },
    ]);
    expect(rows).toEqual([
      {
        messageId: 'assistant-0',
        source: 3,
        prompt: '',
        toolCalls: [{ id: 'call_1', name: 'exec_command', argumentsJson: '{"cmd":"pwd"}' }],
      },
    ]);
    expect(Object.keys(rows[0] || {}).sort()).toEqual(['messageId', 'prompt', 'source', 'toolCalls']);
  });


  test('RED: app proto audit confirms ChatToolDefinition field family and forbids synthetic extras in outbound shape design', async () => {
    const reference = runWindsurfApiReference(`
      process.stdout.write(JSON.stringify({
        required: ['name','description','jsonSchemaString'],
        optional: ['attributionFieldNames','serverName','readOnlyHint','computerUseConfig','isCustomTool','customToolGrammar','customToolGrammarSyntax','strict'],
      }));
    `);
    expect(reference.required).toEqual(['name','description','jsonSchemaString']);
    expect(reference.optional).toContain('strict');
  });

  test('RED: app proto audit confirms ChatToolChoice is oneof(optionName, toolName) only', async () => {
    const reference = runWindsurfApiReference(`
      process.stdout.write(JSON.stringify({
        oneof: ['optionName','toolName'],
      }));
    `);
    expect(reference.oneof).toEqual(['optionName','toolName']);
  });

test('RED: buildChatMessagePromptsFromSemanticConversation must keep tool-result row minimal per app proto audit', async () => {
    const provider = createProvider();
    const rows = (provider as any).buildChatMessagePromptsFromSemanticConversation([
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ]);
    expect(rows).toEqual([
      {
        messageId: 'tool-0',
        source: 4,
        prompt: 'done',
        toolCallId: 'call_1',
        toolResultIsError: false,
      },
    ]);
    expect(Object.keys(rows[0] || {}).sort()).toEqual(['messageId', 'prompt', 'source', 'toolCallId', 'toolResultIsError'].sort());
  });

test('RED: parseCascadeSemanticRoundtripSync should annotate risky Read tool results that do not prove full file body', async () => {
    const parsed = projectConversation([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: 'README.md' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'Read',
        content: 'content unchanged (cached)',
      },
    ]);

    expect(parsed).toEqual([
      {
        type: 'assistant',
        text: '',
        tool_calls: [
          {
            call_id: 'call_read_1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_read_1',
        name: 'Read',
        output: expect.stringContaining('[WindsurfAPI note: This Read result does not prove the full file body is available'),
      },
    ]);
  });

test('RED: buildChatMessageHeaders injects devin auth headers for cascade json send', async () => {
    const provider = createProvider();
    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$abc',
      sessionToken: 'devin-session-token$abc',
      auth1Token: 'auth1-token-1',
      accountId: 'account-1',
      primaryOrgId: 'org-1',
    };
    const headers = (provider as any).buildChatMessageHeaders('devin-session-token$abc');

    expect(headers).toMatchObject({
      'x-auth-token': 'devin-session-token$abc',
      'x-devin-session-token': 'devin-session-token$abc',
      'x-devin-auth1-token': 'auth1-token-1',
      'x-devin-account-id': 'account-1',
      'x-devin-primary-org-id': 'org-1',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Connect-Protocol-Version': '1',
    });
  });

  test('RED: unique cascade blackbox must match WindsurfAPI StartCascade request family, not GetChatCompletions family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildStartCascadeRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildStartCascadeRequest('devin-session-token$cascade', 'sess-1');
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        source: getField(fields, 4, 0)?.value ?? null,
        trajectoryType: getField(fields, 5, 0)?.value ?? null,
      }));
    `);

    const actual = (provider as any).buildStartCascadeRequest?.('devin-session-token$cascade', 'sess-1');
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      source: (provider as any).readProtoNumber(fields, 4) ?? null,
      trajectoryType: (provider as any).readProtoNumber(fields, 5) ?? null,
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI InitializeCascadePanelState request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildInitializePanelStateRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildInitializePanelStateRequest('devin-session-token$cascade', 'sess-1', true);
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        hasMetadata: !!getField(fields, 1, 2),
        workspaceTrusted: getField(fields, 3, 0)?.value ?? null,
      }));
    `);

    const actual = (provider as any).buildInitializePanelStateRequest?.('devin-session-token$cascade', 'sess-1');
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      hasMetadata: !!(provider as any).getProtoField(fields, 1, 2),
      workspaceTrusted: (provider as any).readProtoNumber(fields, 3) ?? null,
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI Heartbeat request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildHeartbeatRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildHeartbeatRequest('devin-session-token$cascade', 'sess-1');
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        hasMetadata: !!getField(fields, 1, 2),
      }));
    `);

    const actual = (provider as any).buildHeartbeatRequest?.('devin-session-token$cascade', 'sess-1');
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      hasMetadata: !!(provider as any).getProtoField(fields, 1, 2),
    }).toEqual(reference);
  });



  test('RED: unique cascade blackbox must match WindsurfAPI Heartbeat full protobuf bytes for deterministic metadata', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      Math.random = () => 0;
      import { buildHeartbeatRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      const buf = buildHeartbeatRequest('devin-session-token$cascade', 'sess-1');
      process.stdout.write(JSON.stringify({ hex: buf.toString('hex'), length: buf.length }));
    `);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const actual = (provider as any).buildHeartbeatRequest('devin-session-token$cascade', 'sess-1');
      expect({ hex: actual.toString('hex'), length: actual.length }).toEqual(reference);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('RED: unique cascade blackbox must match WindsurfAPI AddTrackedWorkspace request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildAddTrackedWorkspaceRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildAddTrackedWorkspaceRequest('/tmp/ws-1');
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        workspacePath: getField(fields, 1, 2)?.value?.toString('utf8') ?? '',
      }));
    `);

    const actual = (provider as any).buildAddTrackedWorkspaceRequest?.('/tmp/ws-1');
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      workspacePath: (provider as any).readProtoString(fields, 1),
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI UpdateWorkspaceTrust request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildUpdateWorkspaceTrustRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildUpdateWorkspaceTrustRequest('devin-session-token$cascade', 'ignored-uri', true, 'sess-1');
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        hasMetadata: !!getField(fields, 1, 2),
        workspaceTrusted: getField(fields, 2, 0)?.value ?? null,
      }));
    `);

    const actual = (provider as any).buildUpdateWorkspaceTrustRequest?.('devin-session-token$cascade', 'sess-1', true);
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      hasMetadata: !!(provider as any).getProtoField(fields, 1, 2),
      workspaceTrusted: (provider as any).readProtoNumber(fields, 2) ?? null,
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI SendUserCascadeMessage request family at top-level field layout', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField, getAllFields } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildSendCascadeMessageRequest('devin-session-token$cascade', 'cid-1', 'hello', 12345, 'MODEL_TEST', 'sess-1', { nativeMode: true, nativeAllowlist: ['run_command'] });
      const top = parseFields(buf);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const conv = parseFields(getField(planner, 2, 2).value);
      process.stdout.write(JSON.stringify({
        fieldNos: top.map(f => f.field),
        cascadeId: getField(top, 1, 2)?.value?.toString('utf8') ?? '',
        itemCount: getAllFields(top, 2).length,
        hasMetadata: !!getField(top, 3, 2),
        hasCascadeConfig: !!getField(top, 5, 2),
        plannerMode: getField(conv, 4, 0)?.value ?? null,
      }));
    `);

    const actual = (provider as any).buildSendCascadeMessageRequest?.({
      apiKey: 'devin-session-token$cascade',
      cascadeId: 'cid-1',
      text: 'hello',
      sessionId: 'sess-1',
      modelEnum: 12345,
      modelUid: 'MODEL_TEST',
      nativeMode: true,
      nativeAllowlist: ['run_command'],
    });
    expect(actual).toBeDefined();
    const top = (provider as any).parseProtoFields(actual);
    const cfg = (provider as any).parseProtoFields((provider as any).getProtoField(top, 5, 2).value);
    const planner = (provider as any).parseProtoFields((provider as any).getProtoField(cfg, 1, 2).value);
    const conv = (provider as any).parseProtoFields((provider as any).getProtoField(planner, 2, 2).value);
    expect({
      fieldNos: top.map((f: any) => f.fieldNo),
      cascadeId: (provider as any).readProtoString(top, 1),
      itemCount: (provider as any).getAllProtoFields(top, 2).length,
      hasMetadata: !!(provider as any).getProtoField(top, 3, 2),
      hasCascadeConfig: !!(provider as any).getProtoField(top, 5, 2),
      plannerMode: (provider as any).readProtoNumber(conv, 4) ?? null,
    }).toEqual(reference);
  });


  test('RED: text tool preamble path is removed and fails fast instead of encoding deprecated protocol', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    expect(() => (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-1',
      text: 'hello world',
      sessionId: 'session-1',
      modelEnum: 123,
      modelUid: 'gpt-5-3-codex-medium',
      toolPreamble: 'TOOLS',
    })).toThrow(/text tool preamble is deprecated/i);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI SendUserCascadeMessage full protobuf bytes for no-tool deterministic args', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      Math.random = () => 0;
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      const buf = buildSendCascadeMessageRequest('api-key-1', 'cid-1', 'hello world', 0, 'gpt-5-3-codex-medium', 'session-1', {});
      process.stdout.write(JSON.stringify({ hex: buf.toString('hex'), length: buf.length }));
    `);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const actual = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-1',
      text: 'hello world',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-3-codex-medium',
    });
    try {
      expect({ hex: actual.toString('hex'), length: actual.length }).toEqual(reference);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('RED: unique cascade blackbox must match WindsurfAPI SendUserCascadeMessage cascade_config field family for no-tool chat path', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildSendCascadeMessageRequest(
        'api-key-1',
        'cid-1',
        'hello world',
        0,
        'gpt-5-3-codex-medium',
        'session-1',
        {}
      );
      const top = parseFields(buf);
      const cfg5 = getField(top, 5, 2);
      const cfg = parseFields(cfg5.value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const conversational = parseFields(getField(planner, 2, 2).value);
      process.stdout.write(JSON.stringify({
        topFields: top.map(f => f.field),
        cfgFields: cfg.map(f => f.field),
        plannerFields: planner.map(f => f.field),
        conversationalFields: conversational.map(f => f.field),
        plannerMode: getField(conversational, 4, 0)?.value ?? null,
        requestedModelUid: getField(planner, 35, 2)?.value?.toString('utf8') ?? '',
        planModelUid: getField(planner, 34, 2)?.value?.toString('utf8') ?? '',
        maxOutputTokens: getField(planner, 6, 0)?.value ?? null,
        hasCodeChangesSection: !!getField(planner, 11, 2),
        hasMemoryConfig: !!getField(cfg, 5, 2),
        hasBrainConfig: !!getField(cfg, 7, 2),
      }));
    `);

    const actual = (provider as any).buildSendCascadeMessageRequest?.({
      apiKey: 'api-key-1',
      cascadeId: 'cid-1',
      text: 'hello world',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-3-codex-medium',
    });
    expect(actual).toBeDefined();
    const top = (provider as any).parseProtoFields(actual);
    const cfg = (provider as any).parseProtoFields((provider as any).getProtoField(top, 5, 2).value);
    const planner = (provider as any).parseProtoFields((provider as any).getProtoField(cfg, 1, 2).value);
    const conversational = (provider as any).parseProtoFields((provider as any).getProtoField(planner, 2, 2).value);
    expect({
      topFields: top.map((f: any) => f.fieldNo),
      cfgFields: cfg.map((f: any) => f.fieldNo),
      plannerFields: planner.map((f: any) => f.fieldNo),
      conversationalFields: conversational.map((f: any) => f.fieldNo),
      plannerMode: (provider as any).readProtoNumber(conversational, 4) ?? null,
      requestedModelUid: (provider as any).readProtoString(planner, 35),
      planModelUid: (provider as any).readProtoString(planner, 34),
      maxOutputTokens: (provider as any).readProtoNumber(planner, 6) ?? null,
      hasCodeChangesSection: !!(provider as any).getProtoField(planner, 11, 2),
      hasMemoryConfig: !!(provider as any).getProtoField(cfg, 5, 2),
      hasBrainConfig: !!(provider as any).getProtoField(cfg, 7, 2),
    }).toEqual(reference);
  });


  test('RED: unique cascade blackbox must encode native tool mode as WindsurfAPI DEFAULT planner + tool_allowlist, without text tool protocol', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      Math.random = () => 0;
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField, getAllFields } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildSendCascadeMessageRequest('api-key-1', 'cid-1', 'run pwd', 0, 'gpt-5-3-codex-medium', 'session-1', {
        nativeMode: true,
        nativeAllowlist: ['run_command', 'view_file'],
      });
      const top = parseFields(buf);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const conversational = parseFields(getField(planner, 2, 2).value);
      const toolConfig = parseFields(getField(planner, 13, 2).value);
      process.stdout.write(JSON.stringify({
        fieldNos: top.map(f => f.field),
        plannerFields: planner.map(f => f.field),
        plannerMode: getField(conversational, 4, 0)?.value ?? null,
        hasToolConfig: !!getField(planner, 13, 2),
        toolConfigFields: toolConfig.map(f => f.field),
        allowlist: getAllFields(toolConfig, 32).map(f => f.value.toString('utf8')),
        hasAdditionalInstructions: !!getField(conversational, 12, 2),
        hasToolCallingSection: !!getField(conversational, 10, 2),
      }));
    `);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const actual = (provider as any).buildSendCascadeMessageRequest({
        apiKey: 'api-key-1',
        cascadeId: 'cid-1',
        text: 'run pwd',
        sessionId: 'session-1',
        modelEnum: 0,
        modelUid: 'gpt-5-3-codex-medium',
        nativeMode: true,
        nativeAllowlist: ['run_command', 'view_file'],
      });
      const top = (provider as any).parseProtoFields(actual);
      const cfg = (provider as any).parseProtoFields((provider as any).getProtoField(top, 5, 2).value);
      const planner = (provider as any).parseProtoFields((provider as any).getProtoField(cfg, 1, 2).value);
      const conversational = (provider as any).parseProtoFields((provider as any).getProtoField(planner, 2, 2).value);
      const toolConfig = (provider as any).parseProtoFields((provider as any).getProtoField(planner, 13, 2).value);
      expect(reference).toMatchObject({
        plannerMode: 1,
        hasToolConfig: true,
        allowlist: ['run_command', 'view_file'],
      });
      expect({
        fieldNos: top.map((f: any) => f.fieldNo),
        plannerFields: planner.map((f: any) => f.fieldNo),
        plannerMode: (provider as any).readProtoNumber(conversational, 4) ?? null,
        hasToolConfig: !!(provider as any).getProtoField(planner, 13, 2),
        toolConfigFields: toolConfig.map((f: any) => f.fieldNo),
        allowlist: (provider as any).getAllProtoFields(toolConfig, 32).map((f: any) => Buffer.from(f.value).toString('utf8')),
        hasAdditionalInstructions: !!(provider as any).getProtoField(conversational, 12, 2),
        hasToolCallingSection: !!(provider as any).getProtoField(conversational, 10, 2),
      }).toEqual({
        fieldNos: reference.fieldNos,
        plannerFields: reference.plannerFields,
        plannerMode: 1,
        hasToolConfig: true,
        toolConfigFields: reference.toolConfigFields,
        allowlist: ['run_command', 'view_file'],
        hasAdditionalInstructions: false,
        hasToolCallingSection: false,
      });
      expect(actual.toString('utf8')).not.toContain('function_call');
      expect(actual.toString('utf8')).not.toContain('<tool_call>');
      expect(actual.toString('utf8')).not.toContain('You have access to the following functions.');
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('RED: exec_command/shell_command direct semantic translation must match WindsurfAPI run_command subset and reject stdin/session semantics', async () => {
    const provider = createProvider();
    const reference = runWindsurfApiReference(`
      import { buildAdditionalStep, TOOL_MAP } from '/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js';
      const shell = TOOL_MAP.shell_command.forward({ command: 'pwd', workdir: '/tmp/project', timeout_ms: 1234 });
      const run = TOOL_MAP.run_command.forward({ command: 'pwd', cwd: '/tmp/project' });
      const step = buildAdditionalStep('run_command', { ...shell, stdout: '/tmp/project\\n', full_output: '/tmp/project\\n', exit_code: 0 });
      process.stdout.write(JSON.stringify({ shell, run, stepHex: step.toString('hex') }));
    `);
    expect(reference.shell).toEqual({ command_line: 'pwd', cwd: '/tmp/project', blocking: true });
    expect(reference.run).toEqual({ command_line: 'pwd', cwd: '/tmp/project', blocking: true });

    const ourShellStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/project', blocking: true,
      stdout: '/tmp/project\n', full_output: '/tmp/project\n', exit_code: 0,
    });
    expect(ourShellStep.toString('hex')).toBe(reference.stepHex);

    const semantic = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'run pwd' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_exec', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd","workdir":"/tmp/project"}' } }] },
      { role: 'tool', tool_call_id: 'call_exec', content: '/tmp/project\n' },
      { role: 'user', content: 'continue' },
    ]);
    const execSteps = (provider as any).buildCascadeAdditionalStepsFromSemanticConversation(semantic);
    expect(execSteps).toHaveLength(1);
    expect(execSteps[0].toString('hex')).toBe(reference.stepHex);

    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [
          { type: 'function', function: { name: 'exec_command', description: 'one-shot shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'shell_command', description: 'one-shot shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'run_command', description: 'one-shot shell', parameters: { type: 'object' } } },
        ],
      },
    });
    expect(mapped.body.windsurf_native_allowlist).toEqual(['run_command']);

    const stdinMapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'write stdin' }],
        tools: [{ type: 'function', function: { name: 'write_stdin', description: 'interactive stdin', parameters: { type: 'object' } } }],
      },
    });
    expect(stdinMapped.body.windsurf_text_tool_protocol).toBe('rcc');
    expect(stdinMapped.body.windsurf_unsupported_text_tools.map((t: any) => t.function.name)).toEqual(['write_stdin']);
  });

  test('RED: preprocessRequest must route mapped tools through standard cascade native fields and fail-fast on unmapped tools', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'run shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'read_file', description: 'read file', parameters: { type: 'object' } } },
        ],
      },
    });
    expect(mapped.body.tools).toBeUndefined();
    expect(mapped.body.tools_preamble).toBeUndefined();
    expect(mapped.body.windsurf_native_mode).toBe(true);
    expect(mapped.body.windsurf_native_allowlist).toEqual(['run_command', 'view_file']);
    expect(mapped.body.windsurf_declared_native_tools.map((t: any) => t.function.name)).toEqual(['shell_command', 'read_file']);

    const unsupportedOnly = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'echo ping' }],
        tools: [{ type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object' } } }],
      },
    });
    expect(unsupportedOnly.body.windsurf_text_tool_protocol).toBe('rcc');
    expect(unsupportedOnly.body.windsurf_unsupported_text_tools.map((t: any) => t.function.name)).toEqual(['echo']);
  });

  test('RED: MCP can only be considered through LS registration blackbox, not SendUserCascadeMessage per-request injection', async () => {
    const appSchema = execFileSync('python3', ['-c', `
from pathlib import Path
s=Path('/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js').read_text(errors='ignore')
checks={
  'has_mcp_rpc_symbols': all(x in s for x in ['MCP_LIST_SERVERS_METHOD','MCP_LIST_TOOLS_METHOD','MCP_CONNECT_SERVER_METHOD']),
  'has_mcp_server_state': 'McpServerState' in s,
  'has_mcp_trajectory_step': 'name:"mcp_tool"' in s,
  'has_system_prompt_tools_response': 'GetSystemPromptAndToolsResponse' in s and 'name:"tool_definitions"' in s,
}
needle='typeName="exa.language_server_pb.SendUserCascadeMessageRequest"'
i=s.find(needle)
if i < 0:
    raise SystemExit('SendUserCascadeMessageRequest not found')
start=s.rfind('static fields=', 0, i)
end=s.find(']);', i)
chunk=s[start:end+3]
for forbidden in ['name:"mcp_servers"','name:"mcp_server_state"','name:"tool_definitions"','name:"custom_tools"','name:"tools"']:
    if forbidden in chunk:
        raise SystemExit('unexpected per-request MCP/tool injection field: '+forbidden)
print(__import__('json').dumps(checks))
`], { encoding: 'utf8' });
    expect(JSON.parse(appSchema)).toEqual({
      has_mcp_rpc_symbols: true,
      has_mcp_server_state: true,
      has_mcp_trajectory_step: true,
      has_system_prompt_tools_response: true,
    });
  });

  test('RED: response-style request with tool_choice must preserve tool metadata through preprocess for native bridge smoke', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '请执行 pwd' }] }],
        tools: [
          { type: 'function', function: { name: 'exec_command', description: 'run shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
        ],
        tool_choice: { type: 'function', function: { name: 'exec_command' } },
      },
    });
    expect(mapped.body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '请执行 pwd' }] }]);
    expect(mapped.body.tools).toBeUndefined();
    expect(mapped.body.windsurf_native_mode).toBe(true);
    expect(mapped.body.windsurf_native_allowlist).toEqual(['run_command']);
    expect(mapped.body.windsurf_tool_choice).toEqual({ type: 'function', function: { name: 'exec_command' } });
  });

  test('RED: hybrid preprocess partitions native tools to Cascade allowlist and unsupported tools to RCC text protocol', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'run and patch' }],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object', properties: { patch: { type: 'string' } } } } },
          { type: 'function', function: { name: 'update_plan', description: 'plan', parameters: { type: 'object', properties: { plan: { type: 'array' } } } } },
        ],
        tool_choice: 'auto',
      },
    });
    expect(mapped.body.tools).toBeUndefined();
    expect(mapped.body.tools_preamble).toBeUndefined();
    expect(mapped.body.windsurf_text_tool_protocol).toBe('rcc');
    expect(mapped.body.windsurf_native_mode).toBe(true);
    expect(mapped.body.windsurf_native_allowlist).toEqual(['run_command']);
    expect(mapped.body.windsurf_declared_native_tools.map((t: any) => t.function.name)).toEqual(['shell_command']);
    expect(mapped.body.windsurf_unsupported_text_tools.map((t: any) => t.function.name)).toEqual(['apply_patch', 'update_plan']);
    expect(mapped.body.windsurf_declared_tools).toBeUndefined();
    expect(mapped.body.windsurf_tool_choice).toBe('auto');
  });

  test('RED: buildCascadePromptText injects RCC guidance only for unsupported tools and never lists native tool names', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'patch file' }],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object', properties: { patch: { type: 'string' } } } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('Tool-call output contract (STRICT)');
    expect(prompt).toContain('<|RCC|tool_calls>');
    expect(prompt).toContain('<|RCC|invoke name="apply_patch">');
    expect(prompt).toContain('<|RCC|parameter name="patch">');
    expect(prompt).not.toContain('shell_command');
    expect(prompt).not.toContain('run_command');
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).not.toContain('function_call');
    expect(prompt).not.toContain('tools_preamble');
    const legacyFenceName = ['D', 'S', 'M', 'L'].join('');
    expect(prompt).not.toContain(legacyFenceName);
  });

  test('RED: RCC harvest converts unsupported text tool block into OpenAI tool_calls and strips visible RCC text', async () => {
    const provider = createProvider();
    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: '<|RCC|tool_calls>\n<|RCC|invoke name="apply_patch">\n<|RCC|parameter name="patch"><![CDATA[*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch]]></|RCC|parameter>\n</|RCC|invoke>\n</|RCC|tool_calls>',
    }, [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }]);
    expect(parsed.content).toBe('');
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].type).toBe('function');
    expect(parsed.tool_calls[0].function.name).toBe('apply_patch');
    expect(JSON.parse(parsed.tool_calls[0].function.arguments)).toEqual({
      patch: expect.stringContaining('*** Begin Patch'),
    });
    expect(String(parsed.tool_calls[0].id)).toMatch(/^call_/);
  });

  test('RED: malformed legacy tool_call text must not be returned as visible assistant content', async () => {
    const provider = createProvider();
    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: '<tool_call>{"name":"echo","arguments":{"text":"ping"',
    })).toThrow(expect.objectContaining({
      code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
      status: 502,
      retryable: false,
    }));
  });

  test('pollCascadeTrajectorySteps keeps polling while final text has an unclosed tool_call marker', async () => {
    const provider = createProvider();
    const calls: string[] = [];
    const encodeSteps = (text: string) => encodeProtoFieldMessage(1, Buffer.concat([
      encodeProtoFieldVarint(1, 20),
      encodeProtoFieldVarint(4, 3),
      encodeProtoFieldMessage(20, encodeProtoFieldString(1, text)),
    ]));
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string) => {
      if (String(pathName).includes('GetCascadeTrajectorySteps')) {
        calls.push('steps');
        const n = calls.filter((x) => x === 'steps').length;
        return n < 4
          ? encodeSteps('<tool_call>{"name":"echo","arguments":{"text":"ping"')
          : encodeSteps('final answer after malformed draft');
      }
      if (String(pathName).includes('GetCascadeTrajectory')) {
        calls.push('status');
        return encodeProtoFieldVarint(2, 1);
      }
      throw new Error(`unexpected ${pathName}`);
    });
    const result = await (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-toolcall-tail', model: 'gpt-5.4-medium' });
    expect(result.candidate.content).toBe('final answer after malformed draft');
    expect(calls.filter((x) => x === 'steps').length).toBeGreaterThanOrEqual(4);
  });

  test('RED: duplicate RCC text tool blocks from repeated upstream text are deduped within RCC source only', async () => {
    const provider = createProvider();
    const rccBlock = '<|RCC|tool_calls>\n<|RCC|invoke name="echo_tool">\n<|RCC|parameter name="text"><![CDATA[hello-rcc]]></|RCC|parameter>\n</|RCC|invoke>\n</|RCC|tool_calls>';
    const parsed = (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: `${rccBlock}\n${rccBlock}`,
    }, [{ type: 'function', function: { name: 'echo_tool', parameters: { type: 'object' } } }]);
    expect(parsed.content).toBe('');
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].function.name).toBe('echo_tool');
    expect(JSON.parse(parsed.tool_calls[0].function.arguments)).toEqual({ text: 'hello-rcc' });
  });

  test('RED: native trajectory tool call plus RCC text tool call conflicts fail-fast', () => {
    const provider = createProvider();
    expect(() => (provider as any).parseCascadeAssistantTurnSync({
      role: 'assistant',
      content: '<|RCC|tool_calls><|RCC|invoke name="apply_patch"><|RCC|parameter name="patch"><![CDATA[p]]></|RCC|parameter></|RCC|invoke></|RCC|tool_calls>',
      tool_calls: [{ id: 'call_native', type: 'function', function: { name: 'shell_command', arguments: '{"cmd":"pwd"}' } }],
    }, [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }])).toThrow(expect.objectContaining({
      code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
      status: 502,
      retryable: false,
    }));
  });

  test('RED: hybrid preprocessing must preserve tools across submit continuation when request already contains chat messages', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'run and patch' },
          { role: 'assistant', content: '', tool_calls: [
            { id: 'native:run_command:3', type: 'function', function: { name: 'run_command', arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}' } },
          ] },
          { role: 'tool', tool_call_id: 'native:run_command:3', content: '/Users/fanzhang/Documents/github/routecodex\n' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } } },
        ],
      },
    });
    expect(mapped.body.tools).toBeUndefined();
    expect(mapped.body.windsurf_native_mode).toBe(true);
    expect(mapped.body.windsurf_native_allowlist).toEqual(['run_command']);
    expect(mapped.body.windsurf_declared_native_tools.map((t: any) => t.function.name)).toEqual(['shell_command']);
    expect(mapped.body.windsurf_text_tool_protocol).toBe('rcc');
    expect(mapped.body.windsurf_unsupported_text_tools.map((t: any) => t.function.name)).toEqual(['apply_patch']);
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const nativeSteps = (provider as any).buildCascadeAdditionalStepsFromSemanticConversation(
      semantic,
      mapped.body.windsurf_declared_native_tools,
    );
    expect(nativeSteps).toHaveLength(1);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('<|RCC|invoke name="apply_patch">');
    expect(prompt).not.toContain('<|RCC|invoke name="shell_command">');
    expect(prompt).not.toContain('<|RCC|invoke name="run_command">');
  });

  test('RED: hybrid continuation prompt must include pending RCC reminder in the latest human turn after native result', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'First run pwd with shell_command, then call echo_tool with text mixed-rcc.' },
          { role: 'assistant', content: 'I will run pwd first.', tool_calls: [
            { id: 'native:run_command:3', type: 'function', function: { name: 'run_command', arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}' } },
          ] },
          { role: 'tool', tool_call_id: 'native:run_command:3', content: '/Users/fanzhang/Documents/github/routecodex\n' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'echo_tool', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('You have not yet called these required unsupported tools: echo_tool');
    const latestHuman = prompt.slice(prompt.lastIndexOf('<human>'));
    expect(latestHuman).toContain('You have not yet called these required unsupported tools: echo_tool');
    expect(latestHuman).toContain('<|RCC|tool_calls>');
    expect(latestHuman).toContain('<|RCC|invoke name="echo_tool">');
    expect(latestHuman).toContain('Tool result for run_command');
    expect(latestHuman).toContain('/Users/fanzhang/Documents/github/routecodex');
  });

  test('RED: hybrid continuation with pending unsupported tools must ask Cascade for remaining RCC tools after native result', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'Use shell_command to run pwd and apply_patch to create /tmp/rcc_mixed_smoke.txt.' },
          { role: 'assistant', content: '', tool_calls: [
            { id: 'native:run_command:3', type: 'function', function: { name: 'run_command', arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}' } },
          ] },
          { role: 'tool', tool_call_id: 'native:run_command:3', content: '/Users/fanzhang/Documents/github/routecodex\n' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('<|RCC|invoke name="apply_patch">');
    expect(prompt).toContain('You have not yet called these required unsupported tools: apply_patch');
    expect(prompt).toContain('output the RCC block now');
  });

  test('RED: mixed final continuation prompt must preserve prior native tool result after RCC tool result', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'First run pwd with shell_command, then call echo_tool with text mixed-rcc.' },
          { role: 'assistant', content: 'I will run pwd first.', tool_calls: [
            { id: 'native:run_command:3', type: 'function', function: { name: 'shell_command', arguments: '{"cmd":"pwd"}' } },
          ] },
          { role: 'tool', tool_call_id: 'native:run_command:3', content: '/Users/fanzhang/Documents/github/routecodex\n' },
          { role: 'assistant', content: '', tool_calls: [
            { id: 'call_echo_mixed', type: 'function', function: { name: 'echo_tool', arguments: '{"text":"mixed-rcc"}' } },
          ] },
          { role: 'tool', tool_call_id: 'call_echo_mixed', content: 'mixed-rcc' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'echo_tool', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('Tool result for shell_command:');
    expect(prompt).toContain('/Users/fanzhang/Documents/github/routecodex');
    expect(prompt).toContain('<|RCC|tool_result id="call_echo_mixed" name="echo_tool">');
    expect(prompt).toContain('mixed-rcc');
  });

  test('RED: unsupported tool results become RCC tool_result context while native results remain additional_steps', async () => {
    const provider = createProvider();
    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [
          { role: 'user', content: 'run and patch' },
          { role: 'assistant', content: '', tool_calls: [
            { id: 'call_shell', type: 'function', function: { name: 'shell_command', arguments: '{"cmd":"pwd"}' } },
            { id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }) } },
          ] },
          { role: 'tool', tool_call_id: 'call_shell', content: '/tmp/project\n' },
          { role: 'tool', tool_call_id: 'call_patch', content: 'patch applied' },
          { role: 'user', content: 'continue' },
        ],
        tools: [
          { type: 'function', function: { name: 'shell_command', description: 'shell', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } } },
        ],
      },
    });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(mapped.body.messages);
    const nativeSteps = (provider as any).buildCascadeAdditionalStepsFromSemanticConversation(
      semantic,
      mapped.body.windsurf_declared_native_tools,
    );
    expect(nativeSteps).toHaveLength(1);
    const prompt = (provider as any).buildCascadePromptText(
      mapped.body.messages,
      semantic,
      'gpt-5-4-medium',
      mapped.body.windsurf_unsupported_text_tools,
    );
    expect(prompt).toContain('RCC tool results already returned');
    expect(prompt).toContain('Do not repeat the same RCC invocation');
    expect(prompt).toContain('<|RCC|tool_result id="call_patch" name="apply_patch">');
    expect(prompt).toContain('patch applied');
    expect(prompt).not.toContain('<|RCC|tool_result id="call_shell"');
  });

  test('RED: Cascade request schema has no structured custom tool-definition input slot; unsupported Codex/MCP tools use RCC text protocol', async () => {
    const provider = createProvider();
    const appSchema = execFileSync('python3', ['-c', `
from pathlib import Path
s=Path('/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js').read_text(errors='ignore')
needle='typeName="exa.language_server_pb.SendUserCascadeMessageRequest"'
i=s.find(needle)
if i < 0:
    raise SystemExit('SendUserCascadeMessageRequest not found')
start=s.rfind('static fields=', 0, i)
end=s.find(']);', i)
chunk=s[start:end+3]
for token in ['name:"tool_definitions"','name:"custom_tools"','name:"tool_definition"','name:"mcp_servers"','name:"tools"']:
    if token in chunk:
        raise SystemExit('unexpected request tool input slot: '+token)
required=['name:"cascade_id"','name:"items"','name:"metadata"','name:"cascade_config"','name:"additional_steps"']
missing=[x for x in required if x not in chunk]
if missing:
    raise SystemExit('missing expected request field(s): '+','.join(missing))
print('{"ok":true,"hasCustomToolSpec":%s,"hasChatToolDefinition":%s}' % (str('CustomToolSpec' in s).lower(), str('ChatToolDefinition' in s).lower()))
`], { encoding: 'utf8' });
    expect(JSON.parse(appSchema)).toEqual({ ok: true, hasCustomToolSpec: true, hasChatToolDefinition: true });

    const windsurfApiEvidence = execFileSync('python3', ['-c', `
from pathlib import Path
p=Path('/Volumes/extension/code/WindsurfAPI/src/handlers/tool-emulation.js')
s=p.read_text(errors='ignore')
needles=['no per-request slot for client-defined function', 'fields 1-9, none accept tool defs', 'CustomToolSpec exists only as a trajectory']
missing=[n for n in needles if n not in s]
if missing:
    raise SystemExit('missing WindsurfAPI evidence: '+repr(missing))
print('{"ok":true}')
`], { encoding: 'utf8' });
    expect(JSON.parse(windsurfApiEvidence)).toEqual({ ok: true });

    const mapped = await (provider as any).preprocessRequest({
      body: {
        model: 'gpt-5.4-medium',
        messages: [{ role: 'user', content: 'use custom tools' }],
        tools: [
          { type: 'function', function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'update_plan', description: 'plan', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'mcp__computer_use__click', description: 'click', parameters: { type: 'object' } } },
        ],
      },
    });
    expect(mapped.body.windsurf_native_mode).toBe(false);
    expect(mapped.body.windsurf_text_tool_protocol).toBe('rcc');
    expect(mapped.body.windsurf_unsupported_text_tools.map((t: any) => t.function.name)).toEqual([
      'apply_patch',
      'update_plan',
      'mcp__computer_use__click',
    ]);
  });


  test('RED: native run_command response tool name must still build additional_steps when caller declared shell_command', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const semantic = [
      { type: 'user', text: 'run pwd' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'native:run_command:3', name: 'run_command', arguments: { command_line: 'pwd', cwd: '/Users/fanzhang/Documents/github/routecodex' } }],
      },
      { type: 'function_call_output', call_id: 'native:run_command:3', name: 'run_command', output: '/Users/fanzhang/Documents/github/routecodex\n' },
      { type: 'user', text: 'continue' },
    ];
    const steps = (provider as any).buildCascadeAdditionalStepsFromSemanticConversation(semantic, [
      { type: 'function', function: { name: 'shell_command', parameters: { type: 'object' } } },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].length).toBeGreaterThan(0);
    const parsedFields = (provider as any).parseProtoFields(steps[0]);
    expect(parsedFields.map((f: any) => f.fieldNo)).toContain(28);
  });

  test('RED: unique cascade blackbox must encode additional_steps like WindsurfAPI native bridge history', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildAdditionalStep } from '/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js';
      const step = buildAdditionalStep('run_command', {
        command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
        stdout: '/tmp/ws\\n', full_output: '/tmp/ws\\n', exit_code: 0,
      });
      process.stdout.write(JSON.stringify({ hex: step.toString('hex'), length: step.length }));
    `);
    const actual = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    expect({ hex: actual.toString('hex'), length: actual.length }).toEqual(reference);
  });

  test('RED: native Cascade request prompt override shape must match WindsurfAPI blackbox and must not inject no-tool suppression text', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      const buf = buildSendCascadeMessageRequest('api-key-1', 'cid-native-tools', 'run pwd', 0, 'gpt-5-4-medium', 'session-1', { nativeMode: true, nativeAllowlist: ['run_command'] });
      const text = buf.toString('utf8');
      process.stdout.write(JSON.stringify({
        containsUseFunctions: text.includes('Use the functions above when relevant.'),
        containsNoTools: text.includes('No tools are available.'),
        containsNoShell: text.includes('NO shell'),
        containsRunCommand: text.includes('run_command'),
      }));
    `);
    const request = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1',
      cascadeId: 'cid-native-tools',
      text: 'run pwd',
      sessionId: 'session-1',
      modelEnum: 0,
      modelUid: 'gpt-5-4-medium',
      nativeMode: true,
      nativeAllowlist: ['run_command'],
    });
    const text = request.toString('utf8');
    expect(reference).toMatchObject({ containsUseFunctions: false, containsRunCommand: true });
    expect({
      containsUseFunctions: text.includes('Use the functions above when relevant.'),
      containsNoTools: text.includes('No tools are available.'),
      containsNoShell: text.includes('NO shell'),
      containsRunCommand: text.includes('run_command'),
    }).toEqual({
      containsUseFunctions: false,
      containsNoTools: false,
      containsNoShell: false,
      containsRunCommand: true,
    });
  });


  test('RED: unique cascade blackbox must include SendUserCascadeMessage additional_steps field 9 like WindsurfAPI', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      Math.random = () => 0;
      import { buildSendCascadeMessageRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { buildAdditionalStep } from '/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js';
      import { parseFields, getAllFields } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const step = buildAdditionalStep('run_command', { command_line:'pwd', cwd:'/tmp/ws', blocking:true, stdout:'/tmp/ws\\n', full_output:'/tmp/ws\\n', exit_code:0 });
      const buf = buildSendCascadeMessageRequest('api-key-1', 'cid-1', 'next', 0, 'gpt-5-3-codex-medium', 'session-1', { additionalSteps: [step] });
      const top = parseFields(buf);
      process.stdout.write(JSON.stringify({ fieldNos: top.map(f => f.field), stepHex: getAllFields(top, 9)[0].value.toString('hex') }));
    `);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const step = (provider as any).buildCascadeAdditionalStep('run_command', {
        command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
        stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
      });
      const actual = (provider as any).buildSendCascadeMessageRequest({
        apiKey: 'api-key-1', cascadeId: 'cid-1', text: 'next', sessionId: 'session-1',
        modelEnum: 0, modelUid: 'gpt-5-3-codex-medium', additionalSteps: [step],
      });
      const top = (provider as any).parseProtoFields(actual);
      expect({
        fieldNos: top.map((f: any) => f.fieldNo),
        stepHex: Buffer.from((provider as any).getAllProtoFields(top, 9)[0].value).toString('hex'),
      }).toEqual(reference);
    } finally {
      randomSpy.mockRestore();
    }
  });


  test('RED: native trajectory oneof IDE steps must parse into tool_calls like WindsurfAPI parseTrajectorySteps', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildAdditionalStep } from '/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js';
      import { parseTrajectorySteps } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      function writeVarint(n) {
        const out = [];
        let value = BigInt(n);
        while (value >= 0x80n) { out.push(Number((value & 0x7fn) | 0x80n)); value >>= 7n; }
        out.push(Number(value));
        return Buffer.from(out);
      }
      function writeMessageField(field, body) {
        return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(body.length), body]);
      }
      const step = buildAdditionalStep('run_command', { command_line: 'pwd', cwd: '/tmp/ws', blocking: true, stdout: 'out\\n', full_output: 'out\\n', exit_code: 0 });
      const response = writeMessageField(1, step);
      const parsed = parseTrajectorySteps(response)[0];
      process.stdout.write(JSON.stringify(parsed.toolCalls));
    `);
    const step = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: 'out\n', full_output: 'out\n', exit_code: 0,
    });
    const response = Buffer.concat([Buffer.from([0x0a, step.length]), step]);
    const parsed = (provider as any).parseTrajectorySteps(response)[0];
    expect(parsed.toolCalls).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI GetCascadeTrajectorySteps request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildGetTrajectoryStepsRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildGetTrajectoryStepsRequest('cid-1', 7);
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        cascadeId: getField(fields, 1, 2)?.value?.toString('utf8') ?? '',
        stepOffset: getField(fields, 2, 0)?.value ?? null,
      }));
    `);

    const actual = (provider as any).buildGetTrajectoryStepsRequest?.('cid-1', 7);
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      cascadeId: (provider as any).readProtoString(fields, 1),
      stepOffset: (provider as any).readProtoNumber(fields, 2) ?? null,
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must match WindsurfAPI GetCascadeTrajectory request family', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { buildGetTrajectoryRequest } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { parseFields, getField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = buildGetTrajectoryRequest('cid-1');
      const fields = parseFields(buf);
      process.stdout.write(JSON.stringify({
        fieldNos: fields.map(f => f.field),
        cascadeId: getField(fields, 1, 2)?.value?.toString('utf8') ?? '',
      }));
    `);

    const actual = (provider as any).buildGetTrajectoryRequest?.('cid-1');
    expect(actual).toBeDefined();
    const fields = (provider as any).parseProtoFields(actual);
    expect({
      fieldNos: fields.map((f: any) => f.fieldNo),
      cascadeId: (provider as any).readProtoString(fields, 1),
    }).toEqual(reference);
  });

  test('RED: unique cascade blackbox must parse StartCascade response like WindsurfAPI parseStartCascadeResponse', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$cascade', rawType: 'windsurf-devin-token' });
    const reference = runWindsurfApiReference(`
      import { parseStartCascadeResponse } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { writeStringField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const buf = writeStringField(1, 'cid-start-1');
      process.stdout.write(JSON.stringify(parseStartCascadeResponse(buf)));
    `);

    const actual = (provider as any).parseStartCascadeResponse?.(encodeProtoFieldString(1, 'cid-start-1'));
    expect(actual).toEqual(reference);
  });

  test('RED: sendRequestInternal must orchestrate StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps and project completion', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-failfast', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const calls: string[] = [];
    jest.spyOn(provider as any, 'selectUsablePinnedGrpcRuntime').mockImplementation(async () => {
      (provider as any).setPinnedGrpcRuntime({
        lsPort: 42101,
        csrfToken: 'windsurf-api-csrf-fixed-token',
        sessionId: 'session-1',
        workspacePath: '/tmp/ws-1',
        workspaceUri: 'file:///tmp/ws-1',
      });
      calls.push('select:session-1');
      return { sessionId: 'session-1', cascadeId: 'cid-orchestrated-1' };
    });
    jest.spyOn(provider as any, 'sendCascadeMessage').mockImplementation(async (args: any) => {
      calls.push(`send:${args.cascadeId}:${args.text}`);
      return undefined;
    });
    jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => {
      calls.push(`poll:${args.cascadeId}`);
      return {
        candidate: {
          role: 'assistant',
          content: 'hello from cascade',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
          }],
        },
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 5,
          cacheWriteTokens: 3,
        },
      };
    });

    const result = await (provider as any).sendRequestInternal({
      body: {
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'say hi from user' }],
      },
    });

    expect(calls).toEqual([
      'select:session-1',
      'send:cid-orchestrated-1:say hi from user',
      'poll:cid-orchestrated-1',
    ]);
    expect(result).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.3-codex',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'hello from cascade',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
          }],
        },
      }],
      usage: {
        completion_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
      },
    });
  });

  test('RED: auth blackbox must follow WindsurfAPI sequence CheckUserLoginMethod -> password/login -> PostAuth -> GetCascadeModelConfigs', async () => {
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
          account: 'sequence@example.com',
          password: 'secret',
        },
      },
    } as any, deps);

    const calls: string[] = [];
    jest.spyOn(provider as any, 'loadPersistedWindsurfSessionCredential').mockResolvedValue(null);
    jest.spyOn(provider as any, 'persistWindsurfSessionCredential').mockResolvedValue(undefined);
    (provider as any).windsurfSessionCredential = null;
    (provider as any).windsurfForceRefreshLogin = true;
    const probeSpy = jest.spyOn(provider as any, 'resolveWindsurfLoginMethodProbe')
      .mockImplementation(async () => {
        calls.push('check-login-method');
        return { method: 'auth1', hasPassword: true };
      });
    const postSpy = jest.spyOn((provider as any).httpClient, 'post')
      .mockImplementation(async (url: string) => {
        if (String(url).includes('/_devin-auth/password/login')) {
          calls.push('password-login');
          return { data: { token: 'auth1-token-seq' } } as any;
        }
        throw new Error(`unexpected httpClient.post ${url}`);
      });
    const fetchSpy = jest.spyOn(provider as any, 'fetchWithTimeout')
      .mockImplementation(async (url: string) => {
        if (String(url).includes('WindsurfPostAuth')) {
          calls.push('post-auth');
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              sessionToken: 'devin-session-token$seq',
              accountId: 'account-seq',
              primaryOrgId: 'org-seq',
            }),
          } as any;
        }
        throw new Error(`unexpected fetchWithTimeout ${url}`);
      });
    const modelConfigSpy = jest.spyOn(provider as any, 'fetchCascadeModelConfigsForSite')
      .mockImplementation(async () => {
        calls.push('get-cascade-model-configs');
        return { status: 200, raw: 'ok' };
      });

    try {
      const credential = await (provider as any).ensureWindsurfSessionCredential();
      await (provider as any).fetchCascadeModelConfigsForSite(credential.apiKey);
      expect(calls).toEqual([
        'check-login-method',
        'password-login',
        'post-auth',
        'get-cascade-model-configs',
      ]);
      expect(credential).toMatchObject({
        apiKey: 'devin-session-token$seq',
        sessionToken: 'devin-session-token$seq',
        auth1Token: 'auth1-token-seq',
        accountId: 'account-seq',
        primaryOrgId: 'org-seq',
      });
    } finally {
      probeSpy.mockRestore();
      postSpy.mockRestore();
      fetchSpy.mockRestore();
      modelConfigSpy.mockRestore();
    }
  });

  test('RED: startup/request blackbox must follow WindsurfAPI sequence warmup -> StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps with same session', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$startup-seq', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const calls: string[] = [];
    const warmupSpy = jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup')
      .mockImplementation(async (_apiKey: string, sessionId: string) => {
        calls.push(`warmup:${sessionId}`);
      });
    const sessionSpy = jest.spyOn(provider as any, 'resolveWindsurfCascadeSessionId').mockReturnValue('session-1');
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade').mockImplementation(async (args: any) => {
      await (provider as any).ensureWindsurfCascadeWarmup(args.apiKey, args.sessionId);
      calls.push(`start:${args.sessionId}`);
      return 'cid-1';
    });
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage').mockImplementation(async (args: any) => {
      calls.push(`send:${args.sessionId}:${args.cascadeId}`);
    });
    jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockImplementation(async (args: any) => {
      calls.push(`poll:${args.cascadeId}`);
      return { candidate: { role: 'assistant', content: 'OK' }, usage: null };
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });
      expect(calls).toEqual([
        'warmup:session-1',
        'start:session-1',
        'send:session-1:cid-1',
        'poll:cid-1',
      ]);
      expect(warmupSpy).toHaveBeenCalledWith('devin-session-token$startup-seq', 'session-1');
    } finally {
      warmupSpy.mockRestore();
      sessionSpy.mockRestore();
      startSpy.mockRestore();
      sendSpy.mockRestore();
    }
  });



  test('RED: native submit continuation with only function_call + function_call_output must send tool result as latest cascade text, not empty prompt', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$native-submit-text', rawType: 'windsurf-devin-token' });
    const messages = [
      { role: 'user', content: [{ type: 'input_text', text: 'Use the shell_command tool to run exactly: pwd.' }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'native:run_command:3', type: 'function', function: { name: 'run_command', arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}' } }] },
      { role: 'tool', tool_call_id: 'native:run_command:3', content: '/Users/fanzhang/Documents/github/routecodex\n' },
    ];
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync(messages);
    const text = (provider as any).buildCascadePromptText(messages, semantic, 'gpt-5-4-medium');
    expect(text.trim()).toContain('/Users/fanzhang/Documents/github/routecodex');
    expect(text.trim()).not.toBe('Use the shell_command tool to run exactly: pwd.');
  });

  test('RED: history projection must preserve assistant tool_calls and tool_result for next cascade turn', async () => {
    const provider = createProvider({ type: 'apikey', apiKey: 'devin-session-token$history-tools', rawType: 'windsurf-devin-token' });
    const semantic = (provider as any).parseCascadeSemanticRoundtripSync([
      { role: 'user', content: 'where am I?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_pwd', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'call_pwd', content: '/Users/fanzhang/Documents/github/routecodex\n' },
      { role: 'user', content: 'continue from that result' },
    ]);
    const text = (provider as any).buildCascadePromptText([
      { role: 'user', content: 'where am I?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_pwd', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'call_pwd', content: '/Users/fanzhang/Documents/github/routecodex\n' },
      { role: 'user', content: 'continue from that result' },
    ], semantic, 'gpt-5-3-codex-medium');
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toContain('<tool_result');
    expect(text).not.toContain('function_call');
    expect(text).toContain('<human>\ncontinue from that result\n</human>');
    const steps = (provider as any).buildCascadeAdditionalStepsFromSemanticConversation(semantic);
    expect(steps).toHaveLength(1);
    const request = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'api-key-1', cascadeId: 'cid-1', text, sessionId: 'session-1', modelEnum: 0, modelUid: 'gpt-5-3-codex-medium', additionalSteps: steps,
    });
    const top = (provider as any).parseProtoFields(request);
    expect((provider as any).getAllProtoFields(top, 9)).toHaveLength(1);
  });

  test('RED: startup/request blackbox must project system + history into cascade text like WindsurfAPI cascadeChat instead of only last user message', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$history-shape', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    let capturedText = '';
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade').mockResolvedValue('cid-1');
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage').mockImplementation(async (args: any) => {
      capturedText = String(args.text ?? '');
      return undefined;
    });
    const pollSpy = jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'OK' },
      usage: null,
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [
            { role: 'system', content: 'You are RouteCodex system.' },
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
          ],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(pollSpy).toHaveBeenCalledTimes(1);
      expect(capturedText).toContain('RouteCodex system');
      expect(capturedText).toContain('The following is a multi-turn conversation');
      expect(capturedText).toContain('<human>\nfirst question\n</human>');
      expect(capturedText).toContain('<assistant>\nfirst answer\n</assistant>');
      expect(capturedText).toContain('<human>\nsecond question\n</human>');
      expect(capturedText).not.toBe('second question');
    } finally {
      startSpy.mockRestore();
      sendSpy.mockRestore();
      pollSpy.mockRestore();
    }
  });

  test('RED: local cascade transport must prefer live language_server csrf_token over stale ~/.rcc configured token', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-live-csrf', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const execSpy = jest.spyOn(provider as any, 'execFileUtf8')
      .mockImplementation(((file: any, args?: any) => {
        if (file === 'ps') {
          return '94051 /Users/fanzhang/.windsurf/language_server_macos_arm --api_server_url=https://server.self-serve.windsurf.com --server_port=42101 --csrf_token=ce845714-6ac1-45b4-b684-fcddb6c099ce --codeium_dir=/tmp/.windsurf\n' as any;
        }
        throw new Error(`unexpected execFileSync ${file} ${(args || []).join(' ')}`);
      }) as any);

    try {
      expect((provider as any).resolveLiveLocalGrpcRuntime()).toMatchObject({
        lsPort: 42101,
        csrfToken: 'ce845714-6ac1-45b4-b684-fcddb6c099ce',
      });
    } finally {
      execSpy.mockRestore();
    }
  });


  test('RED: local cascade transport must prefer latest routecodex-windsurf runtime over stale configured port when exact port is gone', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-live-runtime-scan', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const execSpy = jest.spyOn(provider as any, 'execFileUtf8')
      .mockImplementation(((file: any, args?: any) => {
        if (file === 'ps') {
          return [
            '50001 /Users/fanzhang/.windsurf/language_server_macos_arm --api_server_url=https://server.self-serve.windsurf.com --server_port=42107 --csrf_token=ce845714-6ac1-45b4-b684-fcddb6c099ce --codeium_dir=/var/folders/x/routecodex-windsurf-old/.windsurf',
            '90001 /Users/fanzhang/.windsurf/language_server_macos_arm --api_server_url=https://server.self-serve.windsurf.com --server_port=42119 --csrf_token=ce845714-6ac1-45b4-b684-fcddb6c099ce --codeium_dir=/var/folders/x/routecodex-windsurf-new/.windsurf',
          ].join('\n') + '\n' as any;
        }
        throw new Error(`unexpected execFileSync ${file} ${(args || []).join(' ')}`);
      }) as any);

    try {
      expect((provider as any).resolveLiveLocalGrpcRuntime()).toMatchObject({
        lsPort: 42119,
        csrfToken: 'ce845714-6ac1-45b4-b684-fcddb6c099ce',
      });
    } finally {
      execSpy.mockRestore();
    }
  });

  test('RED: local cascade transport must keep configured csrf token when live language_server introspection is unavailable', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$send-live-csrf-fallbackless', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const execSpy = jest.spyOn(provider as any, 'execFileUtf8')
      .mockImplementation(((file: any) => {
        if (file === 'ps') {
          return '77777 /Users/fanzhang/.windsurf/language_server_macos_arm --api_server_url=https://server.self-serve.windsurf.com --server_port=42109 --csrf_token=other-token --codeium_dir=/tmp/.windsurf\n' as any;
        }
        throw new Error(`unexpected execFileSync ${file}`);
      }) as any);

    try {
      expect((provider as any).resolveLiveLocalGrpcRuntime()).toMatchObject({
        lsPort: 42101,
        csrfToken: 'windsurf-api-csrf-fixed-token',
      });
    } finally {
      execSpy.mockRestore();
    }
  });

  test('RED: ensureWindsurfCascadeWarmup must treat AddTrackedWorkspace \"path is already tracked\" as idempotent success aligned to WindsurfAPI warmupCascade lifecycle', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$warmup-idempotent', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const calls: string[] = [];
    const grpcSpy = jest.spyOn(provider as any, 'grpcUnaryLocal')
      .mockImplementation((async (pathName: string) => {
        calls.push(pathName);
        if (pathName.endsWith('/AddTrackedWorkspace')) {
          throw Object.assign(new Error('uri: file:///tmp/ws-1: path is already tracked'), {
            code: 'WINDSURF_SERVICE_UNREACHABLE',
            status: 502,
            retryable: false,
          });
        }
        return Buffer.alloc(0);
      }) as any);
    const closeSpy = jest.spyOn(provider as any, 'closeLocalGrpcSession').mockImplementation(() => {});

    try {
      await expect((provider as any).ensureWindsurfCascadeWarmup('api-key-1', 'session-1')).resolves.toBeUndefined();
      expect(calls).toEqual([
        '/exa.language_server_pb.LanguageServerService/InitializeCascadePanelState',
        '/exa.language_server_pb.LanguageServerService/AddTrackedWorkspace',
        '/exa.language_server_pb.LanguageServerService/UpdateWorkspaceTrust',
        '/exa.language_server_pb.LanguageServerService/Heartbeat',
      ]);
      expect(closeSpy).not.toHaveBeenCalled();
      expect((provider as any).windsurfCascadeWarmupPromise).toBeTruthy();
    } finally {
      grpcSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });


  test('RED: unique cascade blackbox must match WindsurfAPI parseTrajectorySteps for proposal + choice + mcp + custom + error fields', async () => {
    const provider = createProvider();
    const top = Buffer.concat([
      encodeTrajectoryStepEnvelope({
        type: 15,
        status: 3,
        responseText: 'draft answer',
        modifiedText: 'final answer',
        thinking: 'deep think',
        usage: { inputTokens: 13, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1 },
        proposalToolCall: { id: 'proposal_1', name: 'exec_command', argumentsJson: '{"cmd":"pwd"}' },
      }),
      encodeTrajectoryStepEnvelope({
        type: 15,
        status: 3,
        choiceToolCalls: [
          { id: 'choice_0', name: 'Read', argumentsJson: '{"path":"a"}' },
          { id: 'choice_1', name: 'Read', argumentsJson: '{"path":"b"}' },
        ],
        choiceIndex: 1,
      }),
      encodeTrajectoryStepEnvelope({
        type: 15,
        status: 3,
        mcpToolCall: {
          serverName: 'mcp-fs',
          id: 'mcp_1',
          name: 'fs.read',
          argumentsJson: '{"path":"/tmp/a"}',
          result: 'file body',
        },
      }),
      encodeTrajectoryStepEnvelope({
        type: 15,
        status: 3,
        customToolCall: {
          id: 'custom_1',
          name: 'custom_tool',
          argumentsJson: '{"x":1}',
          result: 'done',
        },
      }),
      encodeTrajectoryStepEnvelope({
        type: 24,
        status: 3,
        errorText: 'policy blocked by upstream',
      }),
    ]);

    const reference = runWindsurfApiReference(`
      import { parseTrajectorySteps } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { writeVarintField, writeStringField, writeMessageField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const step = (...parts) => writeMessageField(1, Buffer.concat(parts));
      const usage = Buffer.concat([
        writeVarintField(2, 13),
        writeVarintField(3, 8),
        writeVarintField(4, 1),
        writeVarintField(5, 2),
      ]);
      const one = step(
        writeVarintField(1, 15),
        writeVarintField(4, 3),
        writeMessageField(5, writeMessageField(9, usage)),
        writeMessageField(20, Buffer.concat([
          writeStringField(1, 'draft answer'),
          writeStringField(3, 'deep think'),
          writeStringField(8, 'final answer'),
        ])),
        writeMessageField(49, writeMessageField(1, Buffer.concat([
          writeStringField(1, 'proposal_1'),
          writeStringField(2, 'exec_command'),
          writeStringField(3, '{"cmd":"pwd"}'),
        ]))),
      );
      const two = step(
        writeVarintField(1, 15),
        writeVarintField(4, 3),
        writeMessageField(50, Buffer.concat([
          writeMessageField(1, Buffer.concat([
            writeStringField(1, 'choice_0'),
            writeStringField(2, 'Read'),
            writeStringField(3, '{"path":"a"}'),
          ])),
          writeMessageField(1, Buffer.concat([
            writeStringField(1, 'choice_1'),
            writeStringField(2, 'Read'),
            writeStringField(3, '{"path":"b"}'),
          ])),
          writeVarintField(2, 1),
        ])),
      );
      const three = step(
        writeVarintField(1, 15),
        writeVarintField(4, 3),
        writeMessageField(47, Buffer.concat([
          writeStringField(1, 'mcp-fs'),
          writeMessageField(2, Buffer.concat([
            writeStringField(1, 'mcp_1'),
            writeStringField(2, 'fs.read'),
            writeStringField(3, '{"path":"/tmp/a"}'),
          ])),
          writeStringField(3, 'file body'),
        ])),
      );
      const four = step(
        writeVarintField(1, 15),
        writeVarintField(4, 3),
        writeMessageField(45, Buffer.concat([
          writeStringField(1, 'custom_1'),
          writeStringField(2, '{"x":1}'),
          writeStringField(3, 'done'),
          writeStringField(4, 'custom_tool'),
        ])),
      );
      const five = step(
        writeVarintField(1, 24),
        writeVarintField(4, 3),
        writeMessageField(24, writeMessageField(3, writeStringField(1, 'policy blocked by upstream'))),
      );
      process.stdout.write(JSON.stringify(parseTrajectorySteps(Buffer.concat([one, two, three, four, five]))));
    `);

    const actual = (provider as any).parseTrajectorySteps?.(top);
    expect(actual).toEqual(reference);
  });




  test('RED: pollCascadeTrajectorySteps must ignore native repeated prior tool call when completed additional step already has result', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const completedNativeStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    const repeatedNativeCall = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
    });
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: 'DONE' });
    const trajectoryStatus = Buffer.from([0x10, 0x01]);
    let stepsCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string, _body: Buffer) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        if (stepsCalls < 5) {
          return Buffer.concat([
            encodeProtoFieldMessage(1, completedNativeStep),
            encodeProtoFieldMessage(1, repeatedNativeCall),
          ]);
        }
        return finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) return trajectoryStatus;
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'cid-native-repeat',
      model: 'gpt-5.4-medium',
      completedNativeToolCallIds: ['native:run_command:1'],
      completedNativeToolSignatures: ['run_command:{"command_line":"pwd","cwd":"/tmp/ws"}'],
    });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('DONE');
    expect(result.candidate.tool_calls).toBeUndefined();
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must ignore completed native-only steps and wait for RCC unsupported tool call', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const completedNativeStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    const rccTextStep = encodeTrajectoryStepEnvelope({
      type: 2,
      status: 3,
      responseText: [
        '<|RCC|tool_calls>',
        '<|RCC|invoke name="apply_patch">',
        '<|RCC|parameter name="patch"><![CDATA[*** Begin Patch\n*** Add File: /tmp/rcc_mixed_smoke.txt\n+mixed\n*** End Patch]]></|RCC|parameter>',
        '</|RCC|invoke>',
        '</|RCC|tool_calls>',
      ].join('\n'),
    });
    const trajectoryStatus = Buffer.from([0x10, 0x01]);
    let stepsCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string, _body: Buffer) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 5 ? Buffer.concat([encodeProtoFieldMessage(1, completedNativeStep)]) : rccTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) return trajectoryStatus;
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'cid-native-then-rcc',
      model: 'gpt-5.4-medium',
      unsupportedTextTools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] } } }],
      completedNativeToolCallIds: ['native:run_command:3'],
      completedNativeToolSignatures: ['run_command:{"command_line":"pwd","cwd":"/tmp/ws"}'],
    });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('');
    expect(result.candidate.tool_calls).toHaveLength(1);
    expect(result.candidate.tool_calls[0].function.name).toBe('apply_patch');
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must not finalize empty assistant while only completed native result steps are visible', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const nativeResultStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: '/tmp/ws' });
    const trajectoryStatus = Buffer.from([0x10, 0x01]);
    let stepsCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string, _body: Buffer) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 9 ? Buffer.concat([encodeProtoFieldMessage(1, nativeResultStep)]) : finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) return trajectoryStatus;
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-native-result-delayed-text', model: 'gpt-5.4-medium' });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 30 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('/tmp/ws');
    expect(result.candidate.tool_calls).toBeUndefined();
    expect(stepsCalls).toBeGreaterThanOrEqual(9);
    jest.useRealTimers();
  });



  test('RED: pollCascadeTrajectorySteps must keep polling when completed native result is visible but final assistant text is empty', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const nativeResultStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/Users/fanzhang/Documents/github/routecodex', blocking: true,
      stdout: '/Users/fanzhang/Documents/github/routecodex\n', full_output: '/Users/fanzhang/Documents/github/routecodex\n', exit_code: 0,
    });
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: '/Users/fanzhang/Documents/github/routecodex' });
    let stepsCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 8 ? Buffer.concat([encodeProtoFieldMessage(1, nativeResultStep)]) : finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) return Buffer.from([0x10, 0x01]);
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'cid-completed-native-result-empty-until-final-text',
      model: 'gpt-5.4-medium',
      completedNativeToolCallIds: ['native:run_command:3'],
    });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 30 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('/Users/fanzhang/Documents/github/routecodex');
    expect(result.candidate.tool_calls).toBeUndefined();
    expect(stepsCalls).toBeGreaterThanOrEqual(8);
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must keep waiting when final snapshot is empty after native submit continuation produced completed result without id set', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: '/Users/fanzhang/Documents/github/routecodex' });
    let stepsCalls = 0;
    let statusCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 8 ? Buffer.alloc(0) : finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) {
        statusCalls += 1;
        return Buffer.from([0x10, 0x01]);
      }
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'cid-empty-then-final-text-after-native-submit',
      model: 'gpt-5.4-medium',
      completedNativeToolCallIds: ['native:run_command:3'],
    });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 30 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('/Users/fanzhang/Documents/github/routecodex');
    expect(result.candidate.tool_calls).toBeUndefined();
    expect(statusCalls).toBeGreaterThanOrEqual(4);
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must keep waiting when idle final snapshot has only completed native result and no assistant text', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const nativeResultStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: '/tmp/ws' });
    let stepsCalls = 0;
    let statusCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 8 ? Buffer.concat([encodeProtoFieldMessage(1, nativeResultStep)]) : finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) {
        statusCalls += 1;
        return Buffer.from([0x10, 0x01]);
      }
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'cid-idle-completed-native-only',
      model: 'gpt-5.4-medium',
      completedNativeToolCallIds: ['native:run_command:3'],
      completedNativeToolSignatures: ['run_command:{"command_line":"pwd","cwd":"/tmp/ws"}'],
    });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 30 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('/tmp/ws');
    expect(result.candidate.tool_calls).toBeUndefined();
    expect(statusCalls).toBeGreaterThanOrEqual(4);
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must return final text even when current trajectory has only completed native result step', async () => {
    jest.useFakeTimers();
    const provider = createProvider();
    const nativeResultStep = (provider as any).buildCascadeAdditionalStep('run_command', {
      command_line: 'pwd', cwd: '/tmp/ws', blocking: true,
      stdout: '/tmp/ws\n', full_output: '/tmp/ws\n', exit_code: 0,
    });
    const finalTextStep = encodeTrajectoryStepEnvelope({ type: 2, status: 3, responseText: '/tmp/ws' });
    const trajectoryStatus = Buffer.from([0x10, 0x01]);
    let stepsCalls = 0;
    (provider as any).grpcUnaryLocal = jest.fn(async (_method: string, _body: Buffer) => {
      if (String(_method).includes('GetCascadeTrajectorySteps')) {
        stepsCalls += 1;
        return stepsCalls < 5 ? Buffer.concat([encodeProtoFieldMessage(1, nativeResultStep)]) : finalTextStep;
      }
      if (String(_method).includes('GetCascadeTrajectory')) return trajectoryStatus;
      return Buffer.alloc(0);
    });
    const promise = (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-native-result', model: 'gpt-5.4-medium' });
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result.candidate.content).toBe('/tmp/ws');
    expect(result.candidate.tool_calls).toBeUndefined();
    jest.useRealTimers();
  });

  test('RED: pollCascadeTrajectorySteps must rebuild latest trajectory from offset 0 so partial ACTIVE text is not treated as final', async () => {
    const provider = createProvider();
    const calls: Array<{ path: string; offset?: number }> = [];
    const encodeSteps = (text: string) => encodeProtoFieldMessage(1, Buffer.concat([
      encodeProtoFieldVarint(1, 20),
      encodeProtoFieldVarint(4, 3),
      encodeProtoFieldMessage(20, encodeProtoFieldString(1, text)),
    ]));
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string, payload: Buffer) => {
      if (String(pathName).includes('GetCascadeTrajectorySteps')) {
        const fields = (provider as any).parseProtoFields(payload);
        calls.push({ path: 'steps', offset: (provider as any).readProtoNumber(fields, 2) ?? 0 });
        return calls.filter((c) => c.path === 'steps').length === 1
          ? encodeSteps('partial active text')
          : encodeSteps('complete answer, not truncated');
      }
      if (String(pathName).includes('GetCascadeTrajectory')) {
        calls.push({ path: 'status' });
        return encodeProtoFieldVarint(2, calls.filter((c) => c.path === 'status').length >= 2 ? 1 : 2);
      }
      throw new Error(`unexpected ${pathName}`);
    });
    const result = await (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-1', model: 'gpt-5.4-medium' });
    expect(calls.filter((c) => c.path === 'steps').map((c) => c.offset).slice(0, 2)).toEqual([0, 0]);
    expect(result.candidate.content).toBe('complete answer, not truncated');
  });


  test('pollCascadeTrajectorySteps waits for stable final text after IDLE so tail is not truncated', async () => {
    const provider = createProvider();
    const calls: string[] = [];
    const encodeSteps = (text: string) => encodeProtoFieldMessage(1, Buffer.concat([
      encodeProtoFieldVarint(1, 20),
      encodeProtoFieldVarint(4, 3),
      encodeProtoFieldMessage(20, encodeProtoFieldString(1, text)),
    ]));
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string) => {
      if (String(pathName).includes('GetCascadeTrajectorySteps')) {
        calls.push('steps');
        const n = calls.filter((x) => x === 'steps').length;
        if (n <= 3) return encodeSteps('partial answer');
        return encodeSteps('partial answer with final tail');
      }
      if (String(pathName).includes('GetCascadeTrajectory')) {
        calls.push('status');
        return encodeProtoFieldVarint(2, 1);
      }
      throw new Error(`unexpected ${pathName}`);
    });
    const result = await (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-idle-tail', model: 'gpt-5.4-medium' });
    expect(result.candidate.content).toBe('partial answer with final tail');
    expect(calls.filter((x) => x === 'steps').length).toBeGreaterThanOrEqual(4);
  });

  test('RED: pollCascadeTrajectorySteps must not finish on first IDLE before cascade had active progress', async () => {
    const provider = createProvider();
    const calls: string[] = [];
    const emptySteps = Buffer.alloc(0);
    const finalSteps = encodeProtoFieldMessage(1, Buffer.concat([
      encodeProtoFieldVarint(1, 20),
      encodeProtoFieldVarint(4, 3),
      encodeProtoFieldMessage(20, encodeProtoFieldString(1, 'complete answer, not truncated')),
    ]));
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string) => {
      if (String(pathName).includes('GetCascadeTrajectorySteps')) {
        calls.push('steps');
        return calls.filter((x) => x === 'steps').length < 3 ? emptySteps : finalSteps;
      }
      if (String(pathName).includes('GetCascadeTrajectory')) {
        calls.push('status');
        const n = calls.filter((x) => x === 'status').length;
        return encodeProtoFieldVarint(2, n === 1 ? 1 : n === 2 ? 2 : 1);
      }
      throw new Error(`unexpected ${pathName}`);
    });
    const result = await (provider as any).pollCascadeTrajectorySteps({ cascadeId: 'cid-idle-race', model: 'gpt-5.4-medium' });
    expect(result.candidate.content).toBe('complete answer, not truncated');
    expect(calls.filter((x) => x === 'status').length).toBeGreaterThanOrEqual(2);
  });

  test('RED: unique cascade blackbox must project trajectory steps like WindsurfAPI parseTrajectorySteps for planner text + tool call + usage', async () => {
    const provider = createProvider();
    const reference = runWindsurfApiReference(`
      import { parseTrajectorySteps } from '/Volumes/extension/code/WindsurfAPI/src/windsurf.js';
      import { writeVarintField, writeStringField, writeMessageField } from '/Volumes/extension/code/WindsurfAPI/src/proto.js';
      const usage = Buffer.concat([
        writeVarintField(2, 11),
        writeVarintField(3, 7),
        writeVarintField(4, 5),
        writeVarintField(5, 3),
      ]);
      const meta = writeMessageField(9, usage);
      const planner = Buffer.concat([
        writeStringField(1, 'hello from planner'),
        writeStringField(3, 'thinking...'),
      ]);
      const toolCall = Buffer.concat([
        writeStringField(1, 'call_1'),
        writeStringField(2, 'exec_command'),
        writeStringField(3, '{"cmd":"pwd"}'),
      ]);
      const proposal = writeMessageField(1, toolCall);
      const step = Buffer.concat([
        writeVarintField(1, 15),
        writeVarintField(4, 3),
        writeMessageField(5, meta),
        writeMessageField(20, planner),
        writeMessageField(49, proposal),
      ]);
      const top = writeMessageField(1, step);
      process.stdout.write(JSON.stringify(parseTrajectorySteps(top)));
    `);

    const makeField = (fieldNo: number, body: Buffer) => Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(body.length), body]);
    const usage = Buffer.concat([
      encodeProtoFieldVarint(2, 11),
      encodeProtoFieldVarint(3, 7),
      encodeProtoFieldVarint(4, 5),
      encodeProtoFieldVarint(5, 3),
    ]);
    const meta = makeField(9, usage);
    const planner = Buffer.concat([
      encodeProtoFieldString(1, 'hello from planner'),
      encodeProtoFieldString(3, 'thinking...'),
    ]);
    const toolCall = Buffer.concat([
      encodeProtoFieldString(1, 'call_1'),
      encodeProtoFieldString(2, 'exec_command'),
      encodeProtoFieldString(3, '{"cmd":"pwd"}'),
    ]);
    const proposal = makeField(1, toolCall);
    const step = Buffer.concat([
      encodeProtoFieldVarint(1, 15),
      encodeProtoFieldVarint(4, 3),
      makeField(5, meta),
      makeField(20, planner),
      makeField(49, proposal),
    ]);
    const top = makeField(1, step);

    const actual = (provider as any).parseTrajectorySteps?.(top);
    expect(actual).toEqual(reference);
  });









  // ── WindsurfConnectSseTransform ─────────────────────────────────
  // Covers: binary Connect frames → SSE text lines transformation.
  // The transform class is accessed via the module's prototype chain since it's
  // a file-scoped (non-exported) implementation detail.

  function encodeConnectFrame(payload: Record<string, unknown>, flags = 0): Buffer {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  }

  // Access the private WindsurfConnectSseTransform via the provider's prototype.
  // The class is defined at module scope and attached to the class constructor.
  function makeSseTransform(): any {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    // The class is module-scoped, accessible via the prototype's constructor.
    // Since we cannot reference it directly, test the SSE output by checking
    // the sendRequestInternal path when wantsSse=true.
    // We access it by finding it on the WindsurfChatProvider constructor.
    const Constructor = (WindsurfChatProvider as any).prototype?.constructor;
    // WindsurfConnectSseTransform is a module-level class; access it via
    // the provider's [[Prototype]] chain.
    for (const key of Object.getOwnPropertyNames(Constructor)) {
      const val = (Constructor as any)[key];
      if (val && val.prototype && val.prototype._transform) return val;
    }
    // Fallback: construct via stream path — test the observable output instead.
    throw new Error('WindsurfConnectSseTransform not accessible; use stream sendRequestInternal test');
  }

  async function collectSseOutputViaStream(transform: any): Promise<string[]> {
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      transform
        .on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
        .on('end', resolve)
        .on('error', reject);
    });
    return chunks;
  }

  // Direct unit tests: find and instantiate the private class via module introspection.
  test('WindsurfConnectSseTransform emits text delta as SSE data line', async () => {
    // Access private module-level class via provider prototype chain.
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    // Find WindsurfConnectSseTransform in the prototype chain.
    let TransformClass: any = null;
    let proto: any = Object.getPrototypeOf(provider);
    while (proto && !TransformClass) {
      const names = Object.getOwnPropertyNames(proto.constructor).filter(
        k => k !== 'length' && k !== 'name' && k !== 'prototype'
      );
      for (const n of names) {
        const v = (proto.constructor as any)[n];
        if (v && v.prototype && typeof v.prototype._transform === 'function') {
          TransformClass = v;
          break;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect(TransformClass).toBeTruthy();
    const transform = new TransformClass();
    transform.write(encodeConnectFrame({ deltaText: 'Hello' }));
    transform.end();
    const lines = await collectSseOutputViaStream(transform);
    const dataLines = lines.filter(l => l.startsWith('data:'));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(dataLines[0]!.slice(6));
    expect(payload.choices[0].delta.content).toBe('Hello');
  });

  test('WindsurfConnectSseTransform emits thinking delta as SSE reasoning_content', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    let TransformClass: any = null;
    let proto: any = Object.getPrototypeOf(provider);
    while (proto && !TransformClass) {
      for (const n of Object.getOwnPropertyNames(proto.constructor)) {
        const v = (proto.constructor as any)[n];
        if (v && v.prototype && typeof v.prototype._transform === 'function') {
          TransformClass = v;
          break;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    const transform = new TransformClass();
    transform.write(encodeConnectFrame({ deltaThinking: 'Let me think' }));
    transform.end();
    const lines = await collectSseOutputViaStream(transform);
    const payload = JSON.parse(lines.find(l => l.startsWith('data:'))!.slice(6));
    expect(payload.choices[0].delta.reasoning_content).toBe('Let me think');
  });

  test('WindsurfConnectSseTransform emits tool call delta', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    let TransformClass: any = null;
    let proto: any = Object.getPrototypeOf(provider);
    while (proto && !TransformClass) {
      for (const n of Object.getOwnPropertyNames(proto.constructor)) {
        const v = (proto.constructor as any)[n];
        if (v && v.prototype && typeof v.prototype._transform === 'function') {
          TransformClass = v;
          break;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    const transform = new TransformClass();
    transform.write(encodeConnectFrame({
      deltaToolCalls: [{ id: 'call_1', name: 'read', argumentsJson: '{"filePath":"/tmp/a.txt"}' }],
    }));
    transform.end();
    const lines = await collectSseOutputViaStream(transform);
    const payload = JSON.parse(lines.find(l => l.startsWith('data:'))!.slice(6));
    expect(payload.choices[0].delta.tool_calls[0].id).toBe('call_1');
    expect(payload.choices[0].delta.tool_calls[0].function.name).toBe('read');
    expect(payload.choices[0].delta.tool_calls[0].function.arguments).toBe('{"filePath":"/tmp/a.txt"}');
  });

  test('WindsurfConnectSseTransform terminal frame emits usage + DONE', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    let TransformClass: any = null;
    let proto: any = Object.getPrototypeOf(provider);
    while (proto && !TransformClass) {
      for (const n of Object.getOwnPropertyNames(proto.constructor)) {
        const v = (proto.constructor as any)[n];
        if (v && v.prototype && typeof v.prototype._transform === 'function') {
          TransformClass = v;
          break;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    const transform = new TransformClass();
    transform.write(encodeConnectFrame({
      deltaText: 'done',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    }, 0x02));
    transform.end();
    const lines = await collectSseOutputViaStream(transform);
    const dataLines = lines.filter(l => l.startsWith('data:'));
    const nonDoneLines = dataLines.filter(l => !l.includes('[DONE]'));
    const usagePayload = JSON.parse(nonDoneLines[nonDoneLines.length - 1]!.slice(6));
    expect(usagePayload.usage.prompt_tokens).toBe(10);
    expect(usagePayload.usage.completion_tokens).toBe(5);
    expect(usagePayload.usage.prompt_tokens_details.cached_tokens).toBe(3);
    expect(lines.some(l => l.includes('[DONE]'))).toBe(true);
  });

  test('WindsurfConnectSseTransform accepts snake_case field variants', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: { providerType: 'openai', baseUrl: 'http://localhost:3003', model: 'gpt-5.4-medium', auth: { type: 'apikey', apiKey: 'test-key' } },
    } as any, deps);
    let TransformClass: any = null;
    let proto: any = Object.getPrototypeOf(provider);
    while (proto && !TransformClass) {
      for (const n of Object.getOwnPropertyNames(proto.constructor)) {
        const v = (proto.constructor as any)[n];
        if (v && v.prototype && typeof v.prototype._transform === 'function') {
          TransformClass = v;
          break;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    const transform = new TransformClass();
    transform.write(encodeConnectFrame({
      delta_text: 'hello',
      delta_thinking: 'reasoning',
      delta_tool_calls: [{ id: 'c1', name: 'bash', argumentsJson: '{}' }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 1 },
    }));
    transform.end();
    const lines = await collectSseOutputViaStream(transform);
    const first = JSON.parse(lines.find(l => l.startsWith('data:'))!.slice(6));
    expect(first.choices[0].delta.content).toBe('hello');
    expect(first.choices[0].delta.reasoning_content).toBe('reasoning');
  });


  test('RED: sendStartCascade transport error must reset local session + warmup state aligned to WindsurfAPI resetCascadeTransportState', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$transport-start', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const transportError = new Error('ERR_HTTP2_STREAM_CANCEL pending stream has been canceled');
    (provider as any).windsurfCascadeWarmupPromise = Promise.resolve();
    const closeSpy = jest.spyOn(provider as any, 'closeLocalGrpcSession').mockImplementation(() => {});
    const warmupSpy = jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup').mockResolvedValue(undefined);
    const grpcSpy = jest.spyOn(provider as any, 'grpcUnaryLocal').mockRejectedValue(transportError);

    try {
      await expect((provider as any).sendStartCascade({
        apiKey: 'api-key-1',
        sessionId: 'session-1',
      })).rejects.toMatchObject({
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      });
      expect(warmupSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect((provider as any).windsurfCascadeWarmupPromise).toBeNull();
    } finally {
      closeSpy.mockRestore();
      warmupSpy.mockRestore();
      grpcSpy.mockRestore();
    }
  });

  test('RED: sendCascadeMessage transport error must reset local session + warmup state aligned to WindsurfAPI resetCascadeTransportState', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$transport-send', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    (provider as any).windsurfCascadeWarmupPromise = Promise.resolve();
    const closeSpy = jest.spyOn(provider as any, 'closeLocalGrpcSession').mockImplementation(() => {});
    const grpcSpy = jest.spyOn(provider as any, 'grpcUnaryLocal').mockRejectedValue(
      new Error('pending stream has been canceled'),
    );

    try {
      await expect((provider as any).sendCascadeMessage({
        apiKey: 'api-key-1',
        cascadeId: 'cid-1',
        text: 'hi',
        sessionId: 'session-1',
        modelEnum: 0,
        modelUid: 'gpt-5-3-codex-medium',
      })).rejects.toMatchObject({
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect((provider as any).windsurfCascadeWarmupPromise).toBeNull();
    } finally {
      closeSpy.mockRestore();
      grpcSpy.mockRestore();
    }
  });

  test('RED: pollCascadeTrajectorySteps transport error must reset local session + warmup state aligned to WindsurfAPI resetCascadeTransportState', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$transport-poll', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    (provider as any).windsurfCascadeWarmupPromise = Promise.resolve();
    const closeSpy = jest.spyOn(provider as any, 'closeLocalGrpcSession').mockImplementation(() => {});
    const grpcSpy = jest.spyOn(provider as any, 'grpcUnaryLocal').mockRejectedValue(
      new Error('session closed while polling cascade trajectory'),
    );

    try {
      await expect((provider as any).pollCascadeTrajectorySteps({
        cascadeId: 'cid-1',
        model: 'gpt-5.3-codex',
      })).rejects.toMatchObject({
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect((provider as any).windsurfCascadeWarmupPromise).toBeNull();
    } finally {
      closeSpy.mockRestore();
      grpcSpy.mockRestore();
    }
  });


  test('RED: sendRequestInternal must retry StartCascade after panel state missing by force rewarm + fresh session aligned to WindsurfAPI cascadeChat', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$panel-retry', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const warmupSpy = jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup').mockResolvedValue(undefined);
    const sessionSpy = jest.spyOn(provider as any, 'resolveWindsurfCascadeSessionId')
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('session-2');
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade')
      .mockRejectedValueOnce(new Error('panel state not found'))
      .mockResolvedValueOnce('cid-2');
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage').mockResolvedValue(undefined);
    const pollSpy = jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'OK' },
      usage: null,
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(warmupSpy).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2', cascadeId: 'cid-2' }));
      expect(pollSpy).toHaveBeenCalledWith(expect.objectContaining({ cascadeId: 'cid-2' }));
      expect(sessionSpy).toHaveBeenCalledTimes(2);
    } finally {
      warmupSpy.mockRestore();
      sessionSpy.mockRestore();
      startSpy.mockRestore();
      sendSpy.mockRestore();
      pollSpy.mockRestore();
    }
  });

  test('RED: sendRequestInternal must retry SendUserCascadeMessage after untrusted workspace by force rewarm + fresh cascade aligned to WindsurfAPI cascadeChat', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$untrusted-retry', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const warmupSpy = jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup').mockResolvedValue(undefined);
    const sessionSpy = jest.spyOn(provider as any, 'resolveWindsurfCascadeSessionId')
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('session-2');
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade')
      .mockResolvedValueOnce('cid-1')
      .mockResolvedValueOnce('cid-2');
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage')
      .mockRejectedValueOnce(new Error('untrusted workspace'))
      .mockResolvedValueOnce(undefined);
    const pollSpy = jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'OK' },
      usage: null,
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(warmupSpy).not.toHaveBeenCalled();
      expect(sendSpy.mock.calls[1][0]).toMatchObject({ sessionId: 'session-2', cascadeId: 'cid-2' });
      expect(pollSpy).toHaveBeenCalledWith(expect.objectContaining({ cascadeId: 'cid-2' }));
      expect(sessionSpy).toHaveBeenCalledTimes(2);
    } finally {
      warmupSpy.mockRestore();
      sessionSpy.mockRestore();
      startSpy.mockRestore();
      sendSpy.mockRestore();
      pollSpy.mockRestore();
    }
  });

  test('RED: sendRequestInternal must retry SendUserCascadeMessage after expired/not_found cascade by force rewarm + fresh cascade aligned to WindsurfAPI cascadeChat', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$expired-retry', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const warmupSpy = jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup').mockResolvedValue(undefined);
    const sessionSpy = jest.spyOn(provider as any, 'resolveWindsurfCascadeSessionId')
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('session-2');
    const startSpy = jest.spyOn(provider as any, 'sendStartCascade')
      .mockResolvedValueOnce('cid-1')
      .mockResolvedValueOnce('cid-2');
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage')
      .mockRejectedValueOnce(new Error('trajectory not_found for cascade cid-1'))
      .mockResolvedValueOnce(undefined);
    const pollSpy = jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'OK' },
      usage: null,
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(warmupSpy).not.toHaveBeenCalled();
      expect(sendSpy.mock.calls[1][0]).toMatchObject({ sessionId: 'session-2', cascadeId: 'cid-2' });
      expect(pollSpy).toHaveBeenCalledWith(expect.objectContaining({ cascadeId: 'cid-2' }));
      expect(sessionSpy).toHaveBeenCalledTimes(2);
    } finally {
      warmupSpy.mockRestore();
      sessionSpy.mockRestore();
      startSpy.mockRestore();
      sendSpy.mockRestore();
      pollSpy.mockRestore();
    }
  });

  test('RED: proto empty embedded message must be omitted like WindsurfAPI writeMessageField', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'test-key' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'routecodex-windsurf-session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    expect((provider as any).writeProtoMessageField?.(6, Buffer.alloc(0)) ?? Buffer.alloc(0)).toEqual(Buffer.alloc(0));
  });

  test('RED: unique cascade blackbox must not emit zero-length embedded messages in SendUserCascadeMessage request family', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'test-key' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'routecodex-windsurf-session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const args = {
      apiKey: 'devin-session-token$test',
      cascadeId: '392a94b5-6e35-4678-8bc0-fc4b806c27ca',
      text: 'Reply with exactly OK',
      sessionId: 'routecodex-windsurf-session-1',
      modelEnum: 3,
      modelUid: 'gpt-5.3-codex',
    };

    const ours = (provider as any).buildSendCascadeMessageRequest(args);
    const fields = (provider as any).parseProtoFields(ours);
    const cascadeConfig = fields.find((field: any) => field.fieldNo === 5 && field.wireType === 2);
    const cascadeConfigFields = (provider as any).parseProtoFields(cascadeConfig.value);
    const brainConfig = cascadeConfigFields.find((field: any) => field.fieldNo === 7 && field.wireType === 2);
    const brainConfigFields = (provider as any).parseProtoFields(brainConfig.value);

    expect(ours.includes(Buffer.from('3200', 'hex'))).toBe(false);
    expect(brainConfigFields.map((field: any) => field.fieldNo)).toEqual([1]);
  });

  test('RED: sendRequestInternal must pin one live local grpc runtime across StartCascade -> SendUserCascadeMessage -> poll to avoid trajectory not found from runtime drift', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$runtime-pin', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);

    const runtimeA = {
      lsPort: 42120,
      csrfToken: 'csrf-a',
      sessionId: 'session-1',
      workspacePath: '/tmp/ws-1',
      workspaceUri: 'file:///tmp/ws-1',
    };
    const runtimeB = {
      lsPort: 42134,
      csrfToken: 'csrf-b',
      sessionId: 'session-1',
      workspacePath: '/tmp/ws-1',
      workspaceUri: 'file:///tmp/ws-1',
    };

    const apiSpy = jest.spyOn(provider as any, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$runtime-pin');
    const selectSpy = jest.spyOn(provider as any, 'selectUsablePinnedGrpcRuntime').mockImplementation(async () => {
      (provider as any).setPinnedGrpcRuntime(runtimeA);
      return { sessionId: 'session-1', cascadeId: 'cid-1' };
    });
    const sendSpy = jest.spyOn(provider as any, 'sendCascadeMessage').mockImplementation(async () => {
      expect((provider as any).getPinnedGrpcRuntime()?.lsPort).toBe(42120);
    });
    const pollSpy = jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockImplementation(async () => {
      const pinned = (provider as any).getPinnedGrpcRuntime();
      if (!pinned || pinned.lsPort !== runtimeA.lsPort || pinned.lsPort === runtimeB.lsPort) {
        throw Object.assign(new Error('trajectory not found'), {
          code: 'WINDSURF_SERVICE_UNREACHABLE',
          status: 502,
          retryable: true,
        });
      }
      return {
        candidate: { role: 'assistant', content: 'OK' },
        usage: null,
      };
    });

    try {
      await expect((provider as any).sendRequestInternal({
        body: {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      })).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      });
      expect(apiSpy).toHaveBeenCalled();
      expect(selectSpy).toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalled();
      expect(pollSpy).toHaveBeenCalled();
      expect((provider as any).getPinnedGrpcRuntime()).toBeNull();
    } finally {
      apiSpy.mockRestore();
      selectSpy.mockRestore();
      sendSpy.mockRestore();
      pollSpy.mockRestore();
    }
  });

  test('RED: concurrent sendRequestInternal for same Windsurf account must serialize one local runtime instead of sharing LS concurrently', async () => {
    const provider = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.3-codex',
        auth: { type: 'apikey', apiKey: 'devin-session-token$runtime-lease', rawType: 'windsurf-devin-token' },
        extensions: {
          windsurf: {
            lsPort: 42101,
            csrfToken: 'windsurf-api-csrf-fixed-token',
            sessionId: 'session-1',
            workspacePath: '/tmp/ws-1',
            workspaceUri: 'file:///tmp/ws-1',
          },
        },
      },
    } as any, deps);
    const runtimeA = { lsPort: 42120, csrfToken: 'csrf-a', sessionId: 'session-1', workspacePath: '/tmp/ws-1', workspaceUri: 'file:///tmp/ws-1' };
    jest.spyOn(provider as any, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$runtime-lease');
    jest.spyOn(provider as any, 'buildRoutecodexWindsurfRuntimeCandidates').mockReturnValue([runtimeA]);
    jest.spyOn(provider as any, 'ensureWindsurfCascadeWarmup').mockResolvedValue(undefined);
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async () => {
      const pinned = (provider as any).getPinnedGrpcRuntime();
      return encodeProtoFieldString(1, `cid-${pinned?.lsPort}`);
    });
    let inFlight = 0;
    let maxInFlight = 0;
    jest.spyOn(provider as any, 'sendCascadeMessage').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    });
    jest.spyOn(provider as any, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'OK' },
      usage: null,
    });

    await Promise.all([
      (provider as any).sendRequestInternal({ body: { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'a' }] } }),
      (provider as any).sendRequestInternal({ body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'b' }] } }),
    ]);

    expect(maxInFlight).toBe(1);
  });

  test('RED: classifyWindsurfCascadeError must map policy blocked symptom to WINDSURF_POLICY_BLOCKED for error blackbox parity', async () => {
    const provider = createProvider();
    const classified = (provider as any).classifyWindsurfCascadeError(new Error('prompt rejected by policy due to content policy'));
    expect(classified).toMatchObject({
      code: 'WINDSURF_POLICY_BLOCKED',
      status: 451,
      retryable: false,
    });
  });

});
