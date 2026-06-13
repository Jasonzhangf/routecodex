import { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

const recordResponsesResponseForRequestMock = jest.fn(async () => undefined);
const captureResponsesRequestContextForRequestMock = jest.fn(async () => undefined);
const finalizeResponsesConversationRequestRetentionMock = jest.fn(async () => undefined);
const convertResponseToJsonToSseMock = jest.fn(async () => Readable.from(['event: response.completed\n', 'data: {}\n\n']));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  captureResponsesRequestContextForRequest: captureResponsesRequestContextForRequestMock,
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(async () => ({
    convertResponseToJsonToSse: convertResponseToJsonToSseMock
  })),
  deriveFinishReasonNative: jest.fn((body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }
    const record = body as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status : '';
    if (status === 'requires_action') {
      return 'tool_calls';
    }
    if (status === 'completed') {
      return 'stop';
    }
    return undefined;
  }),
  finalizeResponsesConversationRequestRetention: finalizeResponsesConversationRequestRetentionMock,
  importCoreDist: jest.fn(),
  requireCoreDist: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: recordResponsesResponseForRequestMock
}));

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public jsonBody: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.jsonBody = body;
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

describe('sendPipelineResponse responses conversation recording', () => {
  it('RED: records requires_action under response id even when request-id contexts are missing', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();
    recordResponsesResponseForRequestMock.mockImplementationOnce(async () => { throw new Error('missing request context'); });

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_response_id_only_fallback',
          object: 'response',
          status: 'requires_action',
          output: [
            { type: 'function_call', name: 'echo_tool', arguments: '{"text":"x"}', call_id: 'call_x' }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: { tool_calls: [{ id: 'call_x', type: 'function', name: 'echo_tool', arguments: '{"text":"x"}', tool_call_id: 'call_x' }] }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking',
          timingRequestIds: ['openai-responses-provider-missing-context']
        }
      } as any,
      'openai-responses-router-missing-context',
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: { model: 'gpt-5.4', store: true, input: [], tools: [] },
          context: { input: [], toolsRaw: [] }
        }
      }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toEqual([
      'resp_response_id_only_fallback'
    ]);
  });

  it('releases non-tool response retention by canonical response-id (not stale router/provider ids)', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    finalizeResponsesConversationRequestRetentionMock.mockClear();

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_final_stop_1',
          object: 'response',
          status: 'completed',
          output: [{ type: 'output_text', text: 'done' }]
        },
        usageLogInfo: {
          finishReason: 'stop',
          routeName: 'thinking',
          timingRequestIds: [
            'openai-responses-provider-a',
            'openai-responses-router-b'
          ]
        }
      } as any,
      'openai-responses-router-b',
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: { model: 'gpt-5.4', store: true, input: [], tools: [] },
          context: { input: [], toolsRaw: [] }
        }
      }
    );

    expect(res.statusCode).toBe(200);
    // non-tool finalization should resolve to canonical response id only
    expect(
      finalizeResponsesConversationRequestRetentionMock.mock.calls.map(([requestId]) => requestId)
    ).toContain('resp_final_stop_1');
    expect(
      finalizeResponsesConversationRequestRetentionMock.mock.calls.map(([requestId]) => requestId)
    ).not.toContain('openai-responses-provider-a');
    expect(
      finalizeResponsesConversationRequestRetentionMock.mock.calls.map(([requestId]) => requestId)
    ).not.toContain('openai-responses-router-b');
  });

  it('records requires_action only under the client-visible response id', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_provider_native_tool_1',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'shell_command',
              arguments: '{"cmd":"pwd"}',
              call_id: 'native:run_command:3'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'native:run_command:3',
                  type: 'function',
                  name: 'shell_command',
                  arguments: '{"cmd":"pwd"}',
                  tool_call_id: 'native:run_command:3'
                }
              ]
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking/gateway-priority-5520-thinking',
          timingRequestIds: [
            'openai-responses-openai.key1-gpt-5.4-medium-20260523T053402638-222073-757',
            'openai-responses-router-gpt-5.4-medium-20260523T053402638-222073-757'
          ]
        }
      } as any,
      'openai-responses-openai.key1-gpt-5.4-medium-20260523T053402638-222073-757',
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: { model: 'gpt-5.4', store: true, input: [], tools: [] },
          context: { input: [], toolsRaw: [] }
        }
      }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toEqual([
      'resp_provider_native_tool_1'
    ]);
  });

  it('RED: records submit continuation requires_action under response id so second submit can resume', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_provider_mixed_second',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'echo_tool',
              arguments: '{"text":"mixed-rcc"}',
              call_id: 'call_echo_mixed'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_echo_mixed',
                  type: 'function',
                  name: 'echo_tool',
                  arguments: '{"text":"mixed-rcc"}',
                  tool_call_id: 'call_echo_mixed'
                }
              ]
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking',
          timingRequestIds: ['openai-responses-openai.submit-2']
        }
      } as any,
      'openai-responses-router-submit-2',
      { entryEndpoint: '/v1/responses.submit_tool_outputs' }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toContain('resp_provider_mixed_second');
  });

  it('RED: records streamed /v1/responses tool_calls so continuation restores tools after tool execution', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();
    convertResponseToJsonToSseMock.mockClear();

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_provider_streamed_tool_100318513',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
              call_id: 'call_provider_streamed_tool'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_provider_streamed_tool',
                  type: 'function',
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}',
                  tool_call_id: 'call_provider_streamed_tool'
                }
              ]
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'default/gateway-priority-5520-default',
          timingRequestIds: [
            'openai-responses-openai.key1-gpt-5.4-none-20260523T100318513-222172-856',
            'openai-responses-router-gpt-5.3-codex-20260523T100318513-222172-856'
          ]
        }
      } as any,
      'openai-responses-router-gpt-5.3-codex-20260523T100318513-222172-856',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: { model: 'gpt-5.4', store: true, input: [], tools: [] },
          context: { input: [], toolsRaw: [] }
        }
      }
    );
    await waitForEnd(res);

    expect(res.statusCode).toBe(200);
    expect(convertResponseToJsonToSseMock).toHaveBeenCalledTimes(1);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toEqual([
      'resp_provider_streamed_tool_100318513'
    ]);
  });

  it('RED: streamed /v1/responses.submit_tool_outputs tool_calls must capture context for next continuation', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();
    captureResponsesRequestContextForRequestMock.mockClear();
    convertResponseToJsonToSseMock.mockClear();

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_submit_streamed_tool_1',
          object: 'response',
          status: 'requires_action',
          finish_reason: 'tool_calls',
          output: [
            {
              type: 'function_call',
              name: 'update_plan',
              arguments: '{"plan":[{"step":"streamed submit"}]}',
              call_id: 'call_submit_streamed_1'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_submit_streamed_1',
                  type: 'function',
                  name: 'update_plan',
                  arguments: '{"plan":[{"step":"streamed submit"}]}',
                  tool_call_id: 'call_submit_streamed_1'
                }
              ]
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'tools/gateway-priority-5555-tools',
          timingRequestIds: ['openai-responses-submit-streamed-1']
        }
      } as any,
      'openai-responses-submit-streamed-router-1',
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.4',
            previous_response_id: 'resp_parent_streamed_1',
            input: [{ type: 'function_call_output', call_id: 'call_submit_streamed_0', output: 'ok' }]
          },
          context: {
            input: [{ type: 'function_call_output', call_id: 'call_submit_streamed_0', output: 'ok' }],
            toolsRaw: [{ type: 'function', name: 'update_plan', parameters: { type: 'object' } }]
          },
          sessionId: 'sess-submit-streamed',
        }
      }
    );
    await waitForEnd(res);

    expect(res.statusCode).toBe(200);
    expect(captureResponsesRequestContextForRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'resp_submit_streamed_tool_1',
      payload: expect.objectContaining({ previous_response_id: 'resp_parent_streamed_1' })
    }));
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toContain(
      'resp_submit_streamed_tool_1'
    );
  });

});
