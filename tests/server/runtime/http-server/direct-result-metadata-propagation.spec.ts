import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

jest.unstable_mockModule(
  '../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.js',
  () => {
    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    const readString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const buildScopeKeys = (scope: Record<string, unknown>): string[] => {
      const entryKind = readString(scope.entryKind) ?? 'responses';
      const portScopeKey = readString(scope.portScopeKey);
      const prefix = portScopeKey ? `${entryKind}:${portScopeKey}` : entryKind;
      const keys: string[] = [];
      const addScoped = (kind: string, value: unknown) => {
        const text = readString(value);
        if (!text) return;
        keys.push(`${prefix}:${kind}:${text}`);
      };
      addScoped('session', scope.sessionId ?? scope.session_id);
      addScoped('conversation', scope.conversationId ?? scope.conversation_id);
      return [...new Set(keys)];
    };
    const collectPendingToolCallIds = (input: Array<Record<string, unknown>>): string[] => {
      const ids: string[] = [];
      for (const item of input) {
        if (item.type === 'function_call') {
          const id = readString(item.call_id) ?? readString(item.id);
          if (id) ids.push(id);
        }
      }
      return ids;
    };
    return ({
    assertResponsesConversationStoreNativeAvailable: jest.fn(() => undefined),
    pickPersistedFields: jest.fn((payload: Record<string, unknown>) => ({ ...payload })),
    prepareConversationEntry: jest.fn((payload: Record<string, unknown>, context: Record<string, unknown>) => ({
      basePayload: { ...payload },
      input: Array.isArray(context.input) ? context.input : (Array.isArray(payload.input) ? payload.input : []),
      tools: Array.isArray(payload.tools) ? payload.tools : undefined,
    })),
    convertOutputToInputItems: jest.fn((response: Record<string, unknown>) => {
      const output = Array.isArray(response.output) ? response.output : [];
      const items = output.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
      const toolCalls = asRecord(asRecord(response.required_action)?.submit_tool_outputs)?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const record = asRecord(call);
          if (!record) continue;
          items.push({
            type: 'function_call',
            call_id: readString(record.call_id) ?? readString(record.id),
            id: readString(record.id) ?? readString(record.call_id),
            name: readString(record.name),
            arguments: readString(record.arguments) ?? '{}',
          });
        }
      }
      return items;
    }),
    collectPendingToolCallIds: jest.fn(collectPendingToolCallIds),
    restoreContinuationPayload: jest.fn((entry: any, payload: Record<string, unknown>) => ({
      payload: {
        ...payload,
        previous_response_id: entry.lastResponseId,
      },
      meta: {
        providerKey: entry.providerKey,
      },
    })),
    materializeContinuationPayload: jest.fn((entry: any, payload: Record<string, unknown>) => ({
      payload: {
        ...payload,
        previous_response_id: entry.lastResponseId,
      },
      meta: {
        providerKey: entry.providerKey,
      },
    })),
    resumeConversationPayload: jest.fn((entry: any, responseId: string, submitPayload: Record<string, unknown>) => ({
      payload: {
        ...entry.basePayload,
        previous_response_id: responseId,
        input: [
          ...(Array.isArray(entry.input) ? entry.input : []),
          ...(Array.isArray(submitPayload.tool_outputs) ? submitPayload.tool_outputs : []),
        ],
      },
      meta: {
        providerKey: entry.providerKey,
      },
    })),
    stripStoredContextInputMedia: jest.fn((input: unknown) => ({
      changed: false,
      messages: Array.isArray(input) ? input : [],
    })),
    buildConversationScopePlan: jest.fn((input: unknown) => {
      const record = asRecord(input) ?? {};
      const scope = asRecord(record.scope) ?? asRecord(record.payload) ?? {};
      const matchedPort = readString(scope.matchedPort);
      const routingPolicyGroup = readString(scope.routingPolicyGroup);
      const portScopeKey = readString(scope.portScopeKey)
        ?? (matchedPort || routingPolicyGroup ? `${matchedPort ?? '*'}:${routingPolicyGroup ?? '*'}` : undefined);
      return {
        keys: buildScopeKeys({
          ...scope,
          ...(portScopeKey ? { portScopeKey } : {}),
        }),
        portScopeKey,
      };
    }),
    planStoreTokens: jest.fn((input: unknown) => {
      const record = asRecord(input) ?? {};
      return {
        providerKey: readString(record.providerKey) ?? readString(record.fallbackProviderKey),
        sessionId: readString(record.sessionId),
        conversationId: readString(record.conversationId),
        entryKind: readString(record.entryKind) ?? 'responses',
        continuationOwner: readString(record.continuationOwner) ?? readString(record.fallbackContinuationOwner),
      };
    }),
    planPersistedEntry: jest.fn((input: any) => ({
      action: input?.entry ? 'entry' : 'skip',
      reason: input?.entry ? 'ok' : 'missing_entry',
      entry: input?.entry,
    })),
    planPersistenceEligibility: jest.fn((entry: any) => ({
      action: entry?.lastResponseId ? 'persist' : 'skip',
      reason: entry?.lastResponseId ? 'has_response' : 'missing_response',
      lastResponseId: entry?.lastResponseId,
    })),
    planConversationPreflight: jest.fn((input: any) => {
      if (input?.mode === 'capture_request') {
        const requestId = readString(input.requestId);
        return requestId
          ? { action: 'continue', reason: 'ok', requestId }
          : { action: 'skip', reason: 'missing_request_id' };
      }
      if (input?.mode === 'record_response') {
        const requestId = readString(input.requestId);
        const responseId = readString(asRecord(input.response)?.id);
        if (!requestId) return { action: 'throw', reason: 'missing_request_id', responseId };
        if (!responseId) return { action: 'throw', reason: 'missing_response_id', requestId };
        return { action: 'continue', reason: 'ok', requestId, responseId };
      }
      if (input?.mode === 'resume_conversation') {
        const responseId = readString(input.responseId);
        if (!responseId) return { action: 'throw', reason: 'missing_or_empty_response_id' };
        if (!Array.isArray(asRecord(input.submitPayload)?.tool_outputs)) {
          return { action: 'throw', reason: 'missing_tool_outputs', responseId };
        }
        return { action: 'continue', reason: 'ok', responseId };
      }
      return { action: 'continue', reason: 'ok' };
    }),
    planCapturedEntry: jest.fn((input: any) => ({
      action: input?.requestId ? 'entry' : 'skip',
      reason: input?.requestId ? 'ok' : 'missing_request_id',
      entry: input?.requestId
        ? {
            requestId: input.requestId,
            basePayload: { ...(asRecord(input.payload) ?? {}) },
            input: Array.isArray(input.context?.input)
              ? input.context.input
              : Array.isArray(input.payload?.input)
                ? input.payload.input
                : [],
            tools: Array.isArray(input.context?.toolsRaw)
              ? input.context.toolsRaw
              : Array.isArray(input.payload?.tools)
                ? input.payload.tools
                : undefined,
            providerKey: readString(input.providerKey),
            sessionId: readString(input.sessionId),
            conversationId: readString(input.conversationId),
            entryKind: readString(input.entryKind) ?? 'responses',
            continuationOwner: 'relay',
            scopeKeys: Array.isArray(input.scopeKeys) ? input.scopeKeys : [],
            portScopeKey: readString(input.portScopeKey),
            createdAt: typeof input.nowMs === 'number' ? input.nowMs : Date.now(),
            updatedAt: typeof input.nowMs === 'number' ? input.nowMs : Date.now(),
          }
        : undefined,
    })),
    planCapturePendingCleanup: jest.fn(() => ({
      action: 'noop',
      reason: 'ok',
      detachRequestIds: [],
    })),
    planRecordScopeCleanup: jest.fn(() => ({
      action: 'noop',
      reason: 'ok',
      detachRequestIds: [],
    })),
    planRecordContinuationFlag: jest.fn((input: any) => ({
      allowContinuation: input?.allowContinuation === true || (Array.isArray(input?.pendingToolCallIds) && input.pendingToolCallIds.length > 0),
      reason: 'ok',
      pendingToolCallCount: Array.isArray(input?.pendingToolCallIds) ? input.pendingToolCallIds.length : 0,
    })),
    planRecordScopeEntryMatch: jest.fn((input: any) => {
      const candidate = Array.isArray(input?.candidates) ? input.candidates[0] : undefined;
      return candidate
        ? { action: 'select', reason: 'ok', scopeKey: candidate.scopeKey, requestId: candidate.requestId }
        : { action: 'none', reason: 'no_candidates' };
    }),
    planStoreSweep: jest.fn((input: any) => ({
      action: 'noop',
      reason: 'ok',
      detachRequestIds: input?.mode === 'clear_unresolved'
        ? (Array.isArray(input?.candidates)
            ? input.candidates
                .filter((candidate: any) => !readString(candidate?.lastResponseId))
                .map((candidate: any) => readString(candidate?.requestId))
                .filter(Boolean)
            : [])
        : [],
    })),
    planAttachEntryScopes: jest.fn((input: any) => ({
      action: 'attach',
      reason: 'ok',
      scopeKeys: Array.isArray(input?.scopeKeys) ? input.scopeKeys : [],
      detachRequestIds: [],
    })),
    planRebindRequestId: jest.fn((input: any) => (
      input?.oldEntryExists && !input?.newEntryExists && readString(input?.oldId) && readString(input?.newId)
        ? { action: 'rebind', reason: 'ok', oldId: input.oldId, newId: input.newId }
        : { action: 'noop', reason: 'not_applicable' }
    )),
    planContinuationMeta: jest.fn((input: any) => ({
      action: 'meta',
      reason: 'ok',
      meta: {
        ...(asRecord(input?.meta) ?? {}),
        ...(readString(input?.entry?.providerKey) ? { providerKey: input.entry.providerKey } : {}),
      },
    })),
    planReleaseRequestPayload: jest.fn((entry: any) => ({
      basePayload: { ...(asRecord(entry?.basePayload) ?? {}), input: [] },
      releasedInputPrefix: Array.isArray(entry?.input) ? entry.input : [],
      releasedPendingToolCallIds: collectPendingToolCallIds(Array.isArray(entry?.input) ? entry.input : []),
      input: [],
    })),
    planScopeContinuationMatch: jest.fn((input: any) => {
      const candidate = Array.isArray(input?.candidates) ? input.candidates[0] : undefined;
      if (!candidate) return { action: 'none', reason: 'no_candidates' };
      return {
        action: input?.mode === 'materialize' ? 'materialize' : 'restore',
        reason: 'ok',
        scopeKey: candidate.scopeKey,
        requestId: candidate.requestId,
        lastResponseId: candidate.lastResponseId,
      };
    }),
    planResumeEntryMatch: jest.fn((input: any) => {
      const candidate = Array.isArray(input?.candidates) ? input.candidates.find((item: any) => readString(item?.lastResponseId) === readString(input?.responseId)) ?? input.candidates[0] : undefined;
      return candidate
        ? {
            action: 'select',
            reason: 'ok',
            source: candidate.source,
            requestId: candidate.requestId,
            lastResponseId: candidate.lastResponseId,
            scopeKey: candidate.scopeKey,
          }
        : { action: 'none', reason: 'no_candidates' };
    }),
    planContinuationLookupByResponseId: jest.fn((input: any) => {
      const entry = asRecord(input?.entry);
      const responseId = readString(input?.responseId);
      return entry && responseId
        ? {
            action: 'select',
            reason: 'ok',
            responseId,
            providerKey: readString(entry.providerKey),
            continuationOwner: readString(entry.continuationOwner),
            entryKind: readString(entry.entryKind) ?? 'responses',
            requestId: readString(entry.requestId),
          }
        : { action: 'none', reason: 'missing_entry' };
    }),
    planConversationRetention: jest.fn((entry: any, options: any) => {
      if (!readString(entry?.lastResponseId)) {
        return { action: 'clear', reason: 'missing_response' };
      }
      if (options?.keepForSubmitToolOutputs) {
        return { action: 'noop', reason: 'keep_for_submit', lastResponseId: entry.lastResponseId };
      }
      return { action: 'release', reason: 'release', lastResponseId: entry.lastResponseId };
    }),
  });
  }
);

const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');
const {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  clearAllResponsesConversationState,
  responsesConversationStore,
  resumeLatestResponsesContinuationByScope,
  resumeResponsesConversation,
} = await import('../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');

const TEST_METADATA_ORIGIN = {
  module: 'tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts',
  symbol: 'request-truth',
  stage: 'test',
};

function withRequestTruth<T extends Record<string, unknown>>(
  metadata: T,
  truth: { requestId?: string; sessionId?: string; conversationId?: string }
): T {
  const center = MetadataCenter.attach(metadata);
  if (truth.requestId) {
    center.writeRequestTruth('requestId', truth.requestId, TEST_METADATA_ORIGIN);
  }
  if (truth.sessionId) {
    center.writeRequestTruth('sessionId', truth.sessionId, TEST_METADATA_ORIGIN);
  }
  if (truth.conversationId) {
    center.writeRequestTruth('conversationId', truth.conversationId, TEST_METADATA_ORIGIN);
  }
  return metadata;
}

const RESPONSES_REQUEST_IDS = [
  'req-router-direct-retention-success',
  'req-router-direct-retention-http-502',
  'req-router-direct-retention-required-action-only',
  'req-router-direct-retention-sse-wrapper',
  'req-provider-direct-retention-success',
  'req-provider-direct-retention-required-action-only',
  'req-provider-direct-retention-http-502',
  'req-provider-direct-retention-sse-wrapper',
  'req-router-direct-completed-without-capture',
  'req-provider-direct-completed-without-capture',
];

beforeEach(() => {
  clearAllResponsesConversationState();
});

afterEach(() => {
  for (const requestId of RESPONSES_REQUEST_IDS) {
    clearResponsesConversationByRequestId(requestId);
  }
  clearAllResponsesConversationState();
});

describe('http-server direct result metadata propagation', () => {
  it('router-direct result preserves input metadata for downstream SSE restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 2345,
    }, {
      requestId: 'req-router-direct-session-color',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: withRequestTruth({
        sessionId: 'sess-router-direct-color',
        conversationId: 'conv-router-direct-color',
        cwd: '/tmp/router-direct-project',
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }, {
        requestId: 'req-router-direct-session-color',
        sessionId: 'sess-router-direct-color',
        conversationId: 'conv-router-direct-color',
      })
    });

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
    expect(result.usageLogInfo).toMatchObject({
      sessionId: 'sess-router-direct-color',
      conversationId: 'conv-router-direct-color',
      projectPath: '/tmp/router-direct-project',
      providerRequestId: 'req-router-direct-session-color',
      inputRequestId: 'req-router-direct-session-color',
      externalLatencyMs: 2345,
      model: 'gpt-5.4'
    });
  });

  it('router-direct usage log does not synthesize request truth from tmux-only metadata', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { id: 'resp_router_direct_tmux_session', model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-chat', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'tools' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 678,
    }, {
      requestId: 'req-router-direct-tmux-session',
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {
        clientTmuxSessionId: 'tmux-router-direct-session',
        cwd: '/tmp/router-direct-tmux-project'
      }
    });

    expect(result.usageLogInfo).toMatchObject({
      projectPath: '/tmp/router-direct-tmux-project',
      externalLatencyMs: 678,
      model: 'gpt-5.4',
      logSessionColorKey: 'tmux-router-direct-session'
    });
    expect(result.usageLogInfo?.sessionId).toBeUndefined();
  });

  it('router-direct usage log keeps request model and provider target model after response model restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';

    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { id: 'resp_router_direct_model_restore', model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: {
        providerKey: 'cc.key1.gpt-5.5',
        routingDecision: { routeName: 'thinking' },
        originalClientModel: 'gpt-5.4',
        providerModelId: 'gpt-5.5'
      },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 890,
    }, {
      requestId: 'req-router-direct-provider-target-model',
      body: { model: 'gpt-5.4', stream: true },
      metadata: withRequestTruth({
        sessionId: 'sess-router-direct-provider-target-model',
        cwd: '/tmp/router-direct-provider-target-model',
      }, {
        requestId: 'req-router-direct-provider-target-model',
        sessionId: 'sess-router-direct-provider-target-model',
      })
    });

    expect(result.usageLogInfo).toMatchObject({
      providerKey: 'cc.key1.gpt-5.5',
      requestModel: 'gpt-5.4',
      model: 'gpt-5.5',
      providerProtocol: 'openai-responses',
      routeName: 'router-direct:thinking'
    });
  });

  it('provider-direct result preserves input metadata for downstream SSE restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const result = await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 3456,
    }, {
      requestId: 'req-provider-direct-session-color',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: withRequestTruth({
        sessionId: 'sess-provider-direct-color',
        conversationId: 'conv-provider-direct-color',
        workdir: '/tmp/provider-direct-project',
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }, {
        requestId: 'req-provider-direct-session-color',
        sessionId: 'sess-provider-direct-color',
        conversationId: 'conv-provider-direct-color',
      })
    }, {}, 'test.key1');

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
    expect(result.usageLogInfo).toMatchObject({
      sessionId: 'sess-provider-direct-color',
      conversationId: 'conv-provider-direct-color',
      projectPath: '/tmp/provider-direct-project',
      providerRequestId: 'req-provider-direct-session-color',
      inputRequestId: 'req-provider-direct-session-color',
      externalLatencyMs: 3456
    });
  });

  it('provider-direct result does not rewrite readonly response model', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const readonlyBody: Record<string, unknown> = { id: 'resp_provider_direct_readonly', model: 'gpt-5.4' };
    Object.freeze(readonlyBody);

    const result = await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: readonlyBody
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 1,
    }, {
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {}
    }, {}, 'test.key1');

    expect(result.body).toBe(readonlyBody);
    expect((result.body as Record<string, unknown>).model).toBe('gpt-5.4');
  });

  it('router-direct streamed chat tool_calls retains client model metadata for downstream SSE restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'MiniMax-M3';

    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        sseStream: Readable.from([
          'data: {"id":"chatcmpl_router_direct_stream_restore","object":"chat.completion.chunk","created":1782386212,"model":"MiniMax-M3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_router_direct_stream_restore","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl_router_direct_stream_restore","object":"chat.completion.chunk","created":1782386212,"model":"MiniMax-M3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        data: {
          id: 'chatcmpl_router_direct_stream_restore',
          object: 'chat.completion',
          model: 'MiniMax-M3',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_router_direct_stream_restore',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"src/main.rs"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      providerHandle: { providerProtocol: 'openai-chat', providerType: 'openai' },
      auditContext: { providerKey: 'minimax.key1.MiniMax-M3', routingDecision: { routeName: 'tools' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 12,
    }, {
      requestId: 'req-router-direct-stream-restore',
      body: { model: 'gpt-5.4', stream: true },
      metadata: {
        clientModelId: 'gpt-5.4',
        originalModelId: 'gpt-5.4',
      },
    });

    expect(result.continuationOwner).toBe('direct');
    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.4',
      originalModelId: 'gpt-5.4',
    });
    expect(result.sseStream).toBeDefined();
    expect(result.usageLogInfo).toMatchObject({
      model: 'MiniMax-M3',
      finishReason: 'tool_calls',
    });
  });
  it('router-direct completed responses clear captured request state instead of leaving stale continuation history', async () => {
    captureResponsesRequestContext({
      requestId: 'req-router-direct-retention-success',
      sessionId: 'sess-router-direct-success',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-router-direct-success',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'world' }],
            },
          ],
        },
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-router-direct-retention-success',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
      },
    });

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestMapSize).toBe(0);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.responseIndexSize).toBe(0);
    expect(stats.scopeIndexSize).toBe(0);
    expect(stats.retainedInputItems).toBe(0);

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-router-direct-retention-success-next',
      sessionId: 'sess-router-direct-success',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }],
          },
        ],
      },
    });

    expect(restored).toBeNull();
  });

  it('router-direct completed response without captured request context does not write continuation state', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.3-codex';

    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-router-direct-completed-without-capture',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-router-direct-completed-without-capture',
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {
        sessionId: 'sess-router-direct-completed-without-capture',
        clientModelId: 'gpt-5.3-codex',
      },
    });

    expect(result.status).toBe(200);
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().responseIndexSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().scopeIndexSize).toBe(0);
  });

  it('router-direct result clears captured responses request on recoverable upstream 502', async () => {
    captureResponsesRequestContext({
      requestId: 'req-router-direct-retention-http-502',
      sessionId: 'sess-router-direct-http-502',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBeGreaterThan(0);

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const result = await server.buildRouterDirectResult({
      response: {
        status: 502,
        data: { error: { code: 'HTTP_502' } }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-router-direct-retention-http-502',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex'
      }
    });

    expect(result.status).toBe(502);
    expect((result.body as any)?.error?.code).toBe('HTTP_502');
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('router-direct streaming wrapper clears captured responses request when no canonical response body is available to retain', async () => {
    captureResponsesRequestContext({
      requestId: 'req-router-direct-retention-sse-wrapper',
      sessionId: 'sess-router-direct-sse-wrapper',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-router-direct-retention-sse-wrapper',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex'
      }
    });

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('provider-direct responses result records retention state for continuation', async () => {
    captureResponsesRequestContext({
      requestId: 'req-provider-direct-retention-success',
      sessionId: 'sess-provider-direct-success',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-provider-direct-success',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              call_id: 'call_provider_direct_1',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
            },
          ],
        },
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-provider-direct-retention-success',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-provider-direct-success',
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
      }
    }, {}, 'test.key1');

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.scopeIndexSize).toBe(1);

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-provider-direct-retention-success-next',
      sessionId: 'sess-provider-direct-success',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          {
            type: 'function_call_output',
            call_id: 'call_provider_direct_1',
            output: '/tmp',
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }],
          },
        ],
      },
    });

    expect(restored?.payload.previous_response_id).toBe('resp-provider-direct-success');
  });

  it('provider-direct completed response without captured request context does not write continuation state', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.3-codex';

    const result = await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-provider-direct-completed-without-capture',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-provider-direct-completed-without-capture',
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {
        sessionId: 'sess-provider-direct-completed-without-capture',
        clientModelId: 'gpt-5.3-codex',
      },
    }, {
      id: 'resp-provider-direct-completed-without-capture',
      object: 'response',
      status: 'completed',
    }, 'test.key1');

    expect(result.status).toBe(200);
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().responseIndexSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().scopeIndexSize).toBe(0);
  });

  it('RED: provider-direct responses retain submit_tool_outputs continuation when response only exposes required_action', async () => {
    captureResponsesRequestContext({
      requestId: 'req-provider-direct-retention-required-action-only',
      sessionId: 'sess-provider-direct-required-action-only',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-provider-direct-required-action-only',
          object: 'response',
          status: 'requires_action',
          output: [],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_provider_direct_required_action_only',
                  type: 'function_call',
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}',
                },
              ],
            },
          },
        },
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-provider-direct-retention-required-action-only',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-provider-direct-required-action-only',
      }
    }, {}, 'test.key1');

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.responseIndexSize).toBe(1);

    const resumed = resumeResponsesConversation('resp-provider-direct-required-action-only', {
      tool_outputs: [
        {
          call_id: 'call_provider_direct_required_action_only',
          output: '/tmp',
        },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe('resp-provider-direct-required-action-only');
  });

  it('provider-direct result clears captured responses request on upstream 502', async () => {
    captureResponsesRequestContext({
      requestId: 'req-provider-direct-retention-http-502',
      sessionId: 'sess-provider-direct-http-502',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const result = await server.buildProviderDirectResult({
      response: {
        status: 502,
        data: { error: { code: 'HTTP_502' } }
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-provider-direct-retention-http-502',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-provider-direct-http-502',
      }
    }, {}, 'test.key1');

    expect(result.status).toBe(502);
    expect((result.body as any)?.error?.code).toBe('HTTP_502');
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('provider-direct streaming wrapper clears captured responses request when no canonical response body is available to retain', async () => {
    captureResponsesRequestContext({
      requestId: 'req-provider-direct-retention-sse-wrapper',
      sessionId: 'sess-provider-direct-sse-wrapper',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-provider-direct-retention-sse-wrapper',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-provider-direct-sse-wrapper',
      }
    }, {}, 'test.key1');

    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('RED: router-direct responses retain submit_tool_outputs continuation when response only exposes required_action', async () => {
    captureResponsesRequestContext({
      requestId: 'req-router-direct-retention-required-action-only',
      sessionId: 'sess-router-direct-required-action-only',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: {
          id: 'resp-router-direct-required-action-only',
          object: 'response',
          status: 'requires_action',
          output: [],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_router_direct_required_action_only',
                  type: 'function_call',
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}',
                },
              ],
            },
          },
        },
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } },
      externalLatencyStartedAtMs: 0,
      externalLatencyMs: 0,
    }, {
      requestId: 'req-router-direct-retention-required-action-only',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {},
    });

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.responseIndexSize).toBe(1);

    const resumed = resumeResponsesConversation('resp-router-direct-required-action-only', {
      tool_outputs: [
        {
          call_id: 'call_router_direct_required_action_only',
          output: '/tmp',
        },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe('resp-router-direct-required-action-only');
  });
});
