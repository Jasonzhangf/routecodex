import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

const recordResponsesResponseForRequestMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  createResponsesJsonToSseConverter: jest.fn(),
  importCoreDist: jest.fn(),
  requireCoreDist: jest.fn(),
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

describe('sendPipelineResponse responses conversation recording', () => {
  it('RED: records requires_action under response id even when request-id contexts are missing', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();
    recordResponsesResponseForRequestMock.mockImplementationOnce(async () => { throw new Error('missing request context'); });

    const res = new MockResponse();
    sendPipelineResponse(
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
      { entryEndpoint: '/v1/responses' }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toEqual([
      'resp_response_id_only_fallback',
      'openai-responses-router-missing-context',
      'openai-responses-provider-missing-context'
    ]);
  });

  it('RED: records requires_action under provider timing request id, not only outer router request id', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();

    const res = new MockResponse();
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_windsurf_native_tool_1',
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
            'openai-responses-windsurf.ws-pro-4-gpt-5.4-medium-20260523T053402638-222073-757',
            'openai-responses-router-gpt-5.4-medium-20260523T053402638-222073-757'
          ]
        }
      } as any,
      'openai-responses-windsurf.ws-pro-4-gpt-5.4-medium-20260523T053402638-222073-757',
      { entryEndpoint: '/v1/responses' }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toEqual([
      'resp_windsurf_native_tool_1',
      'openai-responses-windsurf.ws-pro-4-gpt-5.4-medium-20260523T053402638-222073-757',
      'openai-responses-router-gpt-5.4-medium-20260523T053402638-222073-757'
    ]);
  });

  it('RED: records submit continuation requires_action under response id so second submit can resume', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    recordResponsesResponseForRequestMock.mockClear();

    const res = new MockResponse();
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_windsurf_mixed_second',
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
          timingRequestIds: ['openai-responses-windsurf.submit-2']
        }
      } as any,
      'openai-responses-router-submit-2',
      { entryEndpoint: '/v1/responses.submit_tool_outputs' }
    );

    expect(res.statusCode).toBe(200);
    expect(recordResponsesResponseForRequestMock.mock.calls.map(([arg]) => arg.requestId)).toContain('resp_windsurf_mixed_second');
  });

});
