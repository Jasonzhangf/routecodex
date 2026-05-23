import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', async () => {
  const store = await import('../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
  return {
    createResponsesJsonToSseConverter: jest.fn(async () => ({
      convertResponseToJsonToSse: jest.fn(async () => Readable.from(['event: response.completed\n', 'data: {}\n\n']))
    })),
    importCoreDist: jest.fn(),
    requireCoreDist: jest.fn(),
    captureResponsesRequestContextForRequest: jest.fn(async (args: {
      requestId: string;
      payload: Record<string, unknown>;
      context: Record<string, unknown>;
      sessionId?: string;
      routeHint?: string;
    }) => store.captureResponsesRequestContext(args)),
    clearResponsesConversationByRequestId: jest.fn(async (requestId?: string) => {
      store.clearResponsesConversationByRequestId(requestId);
      return undefined;
    }),
    finalizeResponsesConversationRequestRetention: jest.fn(async (requestId?: string, options?: { keepForSubmitToolOutputs?: boolean }) => {
      store.finalizeResponsesConversationRequestRetention(requestId, options);
      return undefined;
    }),
    recordResponsesResponseForRequest: jest.fn(async (args: {
      requestId: string;
      response: Record<string, unknown>;
      routeHint?: string;
    }) => {
      store.recordResponsesResponse(args);
      return undefined;
    })
  };
});

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.end(JSON.stringify(body));
    return this;
  }
}

async function waitForEnd(stream: PassThrough): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
    stream.resume();
  });
}

describe('sendPipelineResponse responses store integration', () => {
  const requestIds = [
    'openai-responses-windsurf.ws-pro-5-gpt-5.4-none-20260523T102906604-222183-867',
    'openai-responses-router-gpt-5.3-codex-20260523T102906604-222183-867',
    'resp_1779503404150',
    'resp_windsurf_json_resume_1',
    'openai-responses-router-gpt-5.3-codex-orphan-cleanup',
    'openai-responses-windsurf.ws-pro-4-gpt-5.4-none-orphan-cleanup',
    'resp_windsurf_orphan_cleanup_1',
    'req-windsurf-history-tool-next'
  ];

  afterEach(async () => {
    const bridge = await import('../../../src/modules/llmswitch/bridge.js');
    (bridge.captureResponsesRequestContextForRequest as jest.Mock).mockClear();
    (bridge.recordResponsesResponseForRequest as jest.Mock).mockClear();
    (bridge.clearResponsesConversationByRequestId as jest.Mock).mockClear();
    (bridge.finalizeResponsesConversationRequestRetention as jest.Mock).mockClear();
    const store = await import('../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    for (const requestId of requestIds) {
      store.clearResponsesConversationByRequestId(requestId);
    }
  });

  it('RED: streamed Windsurf tool_calls records provider context so history plus tools restore together', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const store = await import('../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    const providerRequestId = 'openai-responses-windsurf.ws-pro-5-gpt-5.4-none-20260523T102906604-222183-867';
    const routerRequestId = 'openai-responses-router-gpt-5.3-codex-20260523T102906604-222183-867';
    const responseId = 'resp_1779503404150';

    store.captureResponsesRequestContext({
      requestId: responseId,
      sessionId: 'rcc-routecodex-2',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first coding request' }] }
        ],
        tools: [{ type: 'function', function: { name: 'exec_command' } }]
      },
      context: {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first coding request' }] }
        ],
        toolsRaw: [{ type: 'function', function: { name: 'exec_command' } }]
      },
      routeHint: 'tools/gateway-priority-5520-tools'
    });

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: responseId,
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
              call_id: 'call_windsurf_history_tool'
            }
          ]
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'tools/gateway-priority-5520-tools',
          sessionId: 'rcc-routecodex-2',
          timingRequestIds: [providerRequestId, routerRequestId]
        }
      } as any,
      routerRequestId,
      { entryEndpoint: '/v1/responses', forceSSE: true }
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.scopeIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const restored = store.resumeLatestResponsesContinuationByScope({
      requestId: 'req-windsurf-history-tool-next',
      sessionId: 'rcc-routecodex-2',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first coding request' }] },
          { type: 'function_call_output', call_id: 'call_windsurf_history_tool', output: '/Users/fanzhang/Documents/github/routecodex' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue coding' }] }
        ]
      }
    });

    expect(restored).not.toBeNull();
    expect(restored?.payload.previous_response_id).toBe('resp_1779503404150');
    expect(restored?.payload.tools).toEqual([{ type: 'function', function: { name: 'exec_command' } }]);
    expect(restored?.payload.input).toEqual([
      { type: 'function_call_output', call_id: 'call_windsurf_history_tool', output: '/Users/fanzhang/Documents/github/routecodex' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue coding' }] }
    ]);
  });

  it('records JSON /v1/responses tool_calls under client-visible response id and submit_tool_outputs resumes', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const bridge = await import('../../../src/modules/llmswitch/bridge.js');
    const store = await import('../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    const routerRequestId = 'openai-responses-router-gpt-5.3-codex-json-resume';
    const responseId = 'resp_windsurf_json_resume_1';

    try {
      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: {
            id: responseId,
            object: 'response',
            status: 'requires_action',
            output: [
              {
                type: 'function_call',
                name: 'shell_command',
                arguments: '{"command":"printf native-windsurf-ok"}',
                call_id: 'native:run_command:3'
              }
            ],
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: { tool_calls: [] }
            }
          },
          usageLogInfo: {
            finishReason: 'tool_calls',
            routeName: 'thinking/gateway-priority-5520-thinking',
            sessionId: 'rcc-json-resume-session'
          }
        } as any,
        routerRequestId,
        {
          entryEndpoint: '/v1/responses',
          responsesRequestContext: {
            payload: {
              model: 'gpt-5.3-codex',
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'call shell_command' }] }],
              tools: [{ type: 'function', name: 'shell_command' }]
            },
            context: {
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'call shell_command' }] }],
              toolsRaw: [{ type: 'function', name: 'shell_command' }]
            },
            sessionId: 'rcc-json-resume-session'
          }
        }
      );

      const stats = store.responsesConversationStore.getDebugStats();
      expect((bridge.captureResponsesRequestContextForRequest as jest.Mock).mock.calls.map(([arg]) => arg.requestId)).toEqual([
        responseId
      ]);
      expect((bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.map(([arg]) => arg.requestId)).toEqual([
        responseId
      ]);
      expect((bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.map(([arg]) => arg.response?.id)).toEqual([
        responseId
      ]);
      expect(stats.responseIndexSize).toBe(1);

      const resumed = store.resumeResponsesConversation(responseId, {
        response_id: responseId,
        tool_outputs: [{ tool_call_id: 'native:run_command:3', output: 'native-windsurf-ok' }]
      });

      expect(resumed.payload.previous_response_id).toBe(responseId);
      expect(resumed.payload.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'native:run_command:3', output: 'native-windsurf-ok' })
      ]));
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it('clears superseded router/provider request contexts after client response id is known', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const bridge = await import('../../../src/modules/llmswitch/bridge.js');
    const store = await import('../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    const routerRequestId = 'openai-responses-router-gpt-5.3-codex-orphan-cleanup';
    const providerRequestId = 'openai-responses-windsurf.ws-pro-4-gpt-5.4-none-orphan-cleanup';
    const responseId = 'resp_windsurf_orphan_cleanup_1';

    store.captureResponsesRequestContext({
      requestId: routerRequestId,
      sessionId: 'rcc-orphan-cleanup-session',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
        tools: [{ type: 'function', name: 'exec_command' }]
      },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
        toolsRaw: [{ type: 'function', name: 'exec_command' }]
      },
      routeHint: 'tools/gateway-priority-5520-tools'
    });
    store.captureResponsesRequestContext({
      requestId: providerRequestId,
      sessionId: 'rcc-orphan-cleanup-session',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
        tools: [{ type: 'function', name: 'exec_command' }]
      },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
        toolsRaw: [{ type: 'function', name: 'exec_command' }]
      },
      routeHint: 'tools/gateway-priority-5520-tools'
    });

    const before = store.responsesConversationStore.getDebugStats();
    expect(before.requestEntriesWithoutLastResponseId).toBe(2);
    expect(before.retainedInputItems).toBeGreaterThan(0);

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: responseId,
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
              call_id: 'call_orphan_cleanup'
            }
          ]
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'tools/gateway-priority-5520-tools',
          sessionId: 'rcc-orphan-cleanup-session',
          timingRequestIds: [providerRequestId, routerRequestId]
        }
      } as any,
      routerRequestId,
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.3-codex',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
            tools: [{ type: 'function', name: 'exec_command' }]
          },
          context: {
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }],
            toolsRaw: [{ type: 'function', name: 'exec_command' }]
          },
          sessionId: 'rcc-orphan-cleanup-session'
        }
      }
    );

    const after = store.responsesConversationStore.getDebugStats();
    expect((bridge.clearResponsesConversationByRequestId as jest.Mock).mock.calls.map(([requestId]) => requestId).sort()).toEqual([
      providerRequestId,
      routerRequestId
    ].sort());
    expect((bridge.finalizeResponsesConversationRequestRetention as jest.Mock).mock.calls).toEqual([
      [responseId, { keepForSubmitToolOutputs: true }]
    ]);
    expect(after.responseIndexSize).toBe(1);
    expect(after.scopeIndexSize).toBe(1);
    expect(after.requestEntriesWithoutLastResponseId).toBe(0);
    expect(after.retainedInputItems).toBe(0);
  });
});
