import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { RouteCodexHttpServer } from '../../../../src/server/runtime/http-server/index.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  clearAllResponsesConversationState,
  responsesConversationStore,
  resumeLatestResponsesContinuationByScope,
} from '../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

const RESPONSES_REQUEST_IDS = [
  'req-router-direct-retention-success',
  'req-router-direct-retention-http-502',
  'req-router-direct-retention-sse-wrapper',
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
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } }
    }, {
      requestId: 'req-router-direct-session-color',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-router-direct-color',
        conversationId: 'conv-router-direct-color',
        cwd: '/tmp/router-direct-project',
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }
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
      inputRequestId: 'req-router-direct-session-color'
    });
  });

  it('router-direct usage log uses client tmux session when sessionId is absent', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { id: 'resp_router_direct_tmux_session', model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'tools' } }
    }, {
      requestId: 'req-router-direct-tmux-session',
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {
        clientTmuxSessionId: 'tmux-router-direct-session',
        cwd: '/tmp/router-direct-tmux-project'
      }
    });

    expect(result.usageLogInfo).toMatchObject({
      sessionId: 'tmux-router-direct-session',
      projectPath: '/tmp/router-direct-tmux-project'
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
      providerHandle: { providerType: 'openai' }
    }, {
      requestId: 'req-provider-direct-session-color',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        sessionId: 'sess-provider-direct-color',
        conversationId: 'conv-provider-direct-color',
        workdir: '/tmp/provider-direct-project',
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }
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
      inputRequestId: 'req-provider-direct-session-color'
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
      providerHandle: { providerType: 'openai' }
    }, {
      body: { model: 'gpt-5.3-codex', stream: false },
      metadata: {}
    }, {}, 'test.key1');

    expect(result.body).toBe(readonlyBody);
    expect((result.body as Record<string, unknown>).model).toBe('gpt-5.4');
  });
  it('router-direct responses result records response retention state instead of leaving pending request payload orphaned', async () => {
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
    }, {
      requestId: 'req-router-direct-retention-success',
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
      },
    });

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.scopeIndexSize).toBe(1);

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

    expect(restored?.payload.previous_response_id).toBe('resp-router-direct-success');
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
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } }
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
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } }
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
});
