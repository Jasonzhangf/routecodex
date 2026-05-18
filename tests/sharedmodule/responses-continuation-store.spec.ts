import { afterEach, describe, expect, it } from '@jest/globals';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponse,
  releaseResponsesConversationRequestPayload,
  resumeLatestResponsesContinuationByScope
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

describe('responses conversation store plain continuation restore', () => {
  const requestIds = ['req-resp-store-1', 'req-resp-store-2', 'req-resp-store-3'];

  afterEach(() => {
    for (const requestId of requestIds) {
      clearResponsesConversationByRequestId(requestId);
    }
  });

  it('restores previous_response_id by session scope when incoming input replays the exact prefix', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      routeHint: 'tools',
      payload: {
        model: 'gpt-5.3-codex',
        stream: true,
        tools: [{ type: 'function', function: { name: 'exec_command' } }]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-1',
      routeHint: 'thinking',
      response: {
        id: 'resp-store-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        stream: true,
        metadata: { conversation_id: 'conv-1' },
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(restored).not.toBeNull();
    expect(restored?.payload.previous_response_id).toBe('resp-store-1');
    expect(restored?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
    expect(restored?.meta).toMatchObject({
      previousRequestId: 'req-resp-store-1',
      restoredFromResponseId: 'resp-store-1',
      scopeKey: 'session:sess-1',
      routeHint: 'thinking',
      restored: true
    });
  });

  it('returns null when no exact prefix match exists', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-3',
      sessionId: 'sess-x',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-3',
      response: {
        id: 'resp-store-x',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-4',
      sessionId: 'sess-x',
      payload: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'different' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(restored).toBeNull();
  });


  it('releasing request payload preserves scope-based continuation lookup', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ],
        tools: [{ type: 'function', function: { name: 'exec_command' } }]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-1',
      response: {
        id: 'resp-store-release-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    releaseResponsesConversationRequestPayload('req-resp-store-1');

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(restored).not.toBeNull();
    expect(restored?.payload.previous_response_id).toBe('resp-store-release-1');
  });

  it('materializes full input by session scope for local continuation when incoming payload only carries delta', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-1',
      response: {
        id: 'resp-store-materialize-1',
        output: []
      }
    });

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'world' }]
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
    expect(materialized?.payload.previous_response_id).toBeUndefined();
    expect(materialized?.meta).toMatchObject({
      previousRequestId: 'req-resp-store-1',
      restoredFromResponseId: 'resp-store-materialize-1',
      scopeKey: 'session:sess-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });

  it('fails fast when response capture sees synthetic RouteCodex assistant control text', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    expect(() =>
      recordResponsesResponse({
        requestId: 'req-resp-store-1',
        response: {
          id: 'resp-store-synthetic-1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '[RouteCodex] assistant response became empty after response sanitization.'
                }
              ]
            }
          ]
        }
      })
    ).toThrow(/Tool history contract violated/i);
  });

  it('fails fast when response capture sees synthetic RouteCodex tool placeholder output', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-tool-1',
      sessionId: 'sess-tool-1',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello tool' }]
          }
        ]
      }
    });

    expect(() =>
      recordResponsesResponse({
        requestId: 'req-resp-store-tool-1',
        response: {
          id: 'resp-store-tool-synthetic-1',
          output: [
            {
              type: 'function_call',
              id: 'fc_demo',
              call_id: 'fc_demo',
              name: 'demo',
              arguments: '{}'
            },
            {
              type: 'function_call_output',
              call_id: 'fc_demo',
              output: [
                {
                  type: 'output_text',
                  text: '[RouteCodex] Tool call result unknown: tool "demo" (fc_demo) did not produce a result in this session. Treat this tool as failed with unknown status.'
                }
              ]
            }
          ]
        }
      })
    ).toThrow(/Tool history contract violated/i);
  });

  it('fails fast when conversation capture sees synthetic RouteCodex local control text', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-synthetic-control',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      }
    });

    expect(() =>
      recordResponsesResponse({
        requestId: 'req-resp-store-2',
        response: {
          id: 'resp-store-synthetic-control',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '[RouteCodex] assistant response became empty after response sanitization.'
                }
              ]
            }
          ]
        }
      })
    ).toThrow(/synthetic RouteCodex local control text/i);
  });

  it('captures a requires_action response with unresolved function_call for later submit_tool_outputs resume', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-pending-call',
      sessionId: 'sess-pending-call',
      payload: {
        model: 'gpt-5.3-codex'
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }]
          }
        ]
      }
    });

    expect(() =>
      recordResponsesResponse({
        requestId: 'req-resp-store-pending-call',
        response: {
          id: 'resp-store-pending-call',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              id: 'fc_pending_call_1',
              call_id: 'call_pending_call_1',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
              status: 'in_progress'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_pending_call_1',
                  type: 'function',
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}'
                }
              ]
            }
          }
        }
      })
    ).not.toThrow();
  });
});
