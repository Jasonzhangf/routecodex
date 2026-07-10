import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');
const {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  clearAllResponsesConversationState,
  getResponsesConversationStoreDebugStats,
  resumeLatestResponsesContinuationByScope,
  resumeResponsesConversation,
} = await import('../../../../src/modules/llmswitch/bridge/responses-conversation-store-host.ts');

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

    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

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

    const stats = getResponsesConversationStoreDebugStats();
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
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().responseIndexSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().scopeIndexSize).toBe(0);
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

    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBeGreaterThan(0);

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
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
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
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
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

    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

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

    const stats = getResponsesConversationStoreDebugStats();
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
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().responseIndexSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().scopeIndexSize).toBe(0);
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

    const stats = getResponsesConversationStoreDebugStats();
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
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
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

    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
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

    const stats = getResponsesConversationStoreDebugStats();
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
