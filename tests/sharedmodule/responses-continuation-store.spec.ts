import { afterEach, describe, expect, it } from '@jest/globals';
import {
  captureResponsesRequestContext,
  clearAllResponsesConversationState,
  clearResponsesConversationByRequestId,
  clearUnresolvedResponsesConversationRequests,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponse,
  releaseResponsesConversationRequestPayload,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  responsesConversationStore
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

describe('responses conversation store plain continuation restore', () => {
  const requestIds = new Set<string>();
  const track = (requestId: string): string => {
    requestIds.add(requestId);
    return requestId;
  };

  afterEach(() => {
    for (const requestId of requestIds) {
      clearResponsesConversationByRequestId(requestId);
    }
    requestIds.clear();
  });

  it('restores previous_response_id by session scope when incoming input replays the exact prefix', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-1'),
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      providerKey: 'crs.direct.gpt-5.4',
      payload: {
        model: 'gpt-5.3-codex',
        store: true,
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
      requestId: track('req-resp-store-1'),
      providerKey: 'crs.direct.gpt-5.4',
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
      requestId: track('req-resp-store-2'),
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
      providerKey: 'crs.direct.gpt-5.4',
      restored: true
    });
  });

  it('RED: submit_tool_outputs resume must preserve direct providerKey pin for same-provider remote continuation ownership', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-direct-pin-1'),
      sessionId: 'sess-direct-pin',
      conversationId: 'conv-direct-pin',
      providerKey: 'dibittai.crsa.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: false,
        tools: [{ type: 'function', function: { name: 'exec_command' } }]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'call tool' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-direct-pin-1'),
      providerKey: 'dibittai.crsa.gpt-5.4',
      response: {
        id: 'resp-direct-pin-1',
        output: [
          {
            type: 'function_call',
            id: 'fc_direct_pin_1',
            call_id: 'call_direct_pin_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          }
        ]
      }
    });

    const resumed = resumeResponsesConversation(
      'resp-direct-pin-1',
      {
        response_id: 'resp-direct-pin-1',
        tool_outputs: [{ call_id: 'call_direct_pin_1', output: '/tmp' }]
      },
      { requestId: track('req-resp-store-direct-pin-2') }
    );

    expect(resumed.meta).toMatchObject({
      restoredFromResponseId: 'resp-direct-pin-1',
      providerKey: 'dibittai.crsa.gpt-5.4'
    });
  });

  it('returns null when no exact prefix match exists', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-3'),
      sessionId: 'sess-x',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
      requestId: track('req-resp-store-3'),
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
      requestId: track('req-resp-store-4'),
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
        store: true,
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

    const statsAfterRelease = responsesConversationStore.getDebugStats();
    expect(statsAfterRelease.retainedInputItems).toBe(0);
    expect(statsAfterRelease.requestMapSize).toBe(1);
    expect(statsAfterRelease.responseIndexSize).toBe(1);
    expect(statsAfterRelease.scopeIndexSize).toBe(1);

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
        model: 'gpt-5.3-codex',
        store: true
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

  it('materializes full input by session scope even after request payload was released', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-release-materialize-1',
      sessionId: 'sess-release-materialize',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
      requestId: 'req-resp-store-release-materialize-1',
      response: {
        id: 'resp-store-release-materialize-1',
        output: []
      }
    });

    releaseResponsesConversationRequestPayload('req-resp-store-release-materialize-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-release-materialize-2',
      sessionId: 'sess-release-materialize',
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
    expect(materialized?.meta).toMatchObject({
      restoredFromResponseId: 'resp-store-release-materialize-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });

  it('detaches superseded scoped entries so requestMap/responseIndex do not grow unbounded per session', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-supersede',
      conversationId: 'conv-supersede',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'turn-1' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-1',
      response: {
        id: 'resp-store-supersede-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'answer-1' }]
          }
        ]
      }
    });

    releaseResponsesConversationRequestPayload('req-resp-store-1');

    captureResponsesRequestContext({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-supersede',
      conversationId: 'conv-supersede',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'turn-2' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: 'req-resp-store-2',
      response: {
        id: 'resp-store-supersede-2',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'answer-2' }]
          }
        ]
      }
    });

    const rawStore = responsesConversationStore as unknown as {
      requestMap?: Map<string, unknown>;
      responseIndex?: Map<string, unknown>;
      scopeIndex?: Map<string, unknown>;
    };

    expect(rawStore.requestMap?.has('req-resp-store-1')).toBe(false);
    expect(rawStore.requestMap?.has('req-resp-store-2')).toBe(true);
    expect(rawStore.responseIndex?.has('resp-store-supersede-1')).toBe(false);
    expect(rawStore.responseIndex?.has('resp-store-supersede-2')).toBe(true);
    expect(rawStore.scopeIndex?.has('session:sess-supersede')).toBe(true);
    expect(rawStore.scopeIndex?.has('conversation:conv-supersede')).toBe(true);

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: 'req-resp-store-3',
      sessionId: 'sess-supersede',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'turn-2' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'answer-2' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'turn-3' }]
          }
        ]
      }
    });

    expect(restored?.payload.previous_response_id).toBe('resp-store-supersede-2');
    expect(restored?.meta).toMatchObject({
      previousRequestId: 'req-resp-store-2',
      restoredFromResponseId: 'resp-store-supersede-2'
    });
  });

  it('RED: prunes stale pending scoped requests when a newer scoped request arrives before prior response records', () => {
    captureResponsesRequestContext({
      requestId: track('req-pending-old-1'),
      sessionId: 'sess-pending-prune',
      conversationId: 'conv-pending-prune',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'pending-1' }]
          }
        ]
      }
    });

    captureResponsesRequestContext({
      requestId: track('req-pending-old-2'),
      sessionId: 'sess-pending-prune',
      conversationId: 'conv-pending-prune',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'pending-2' }]
          }
        ]
      }
    });

    const rawStore = responsesConversationStore as unknown as {
      requestMap?: Map<string, unknown>;
    };
    expect(rawStore.requestMap?.has('req-pending-old-1')).toBe(false);
    expect(rawStore.requestMap?.has('req-pending-old-2')).toBe(true);

    const stats = responsesConversationStore.getDebugStats();
    expect(stats.requestEntriesWithoutLastResponseId).toBeGreaterThanOrEqual(1);
  });

  it('does not prune pending requests from different scopes', () => {
    captureResponsesRequestContext({
      requestId: track('req-pending-scope-a-1'),
      sessionId: 'sess-pending-a',
      conversationId: 'conv-pending-a',
      payload: { model: 'gpt-5.3-codex', store: true },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'pending-a-1' }]
          }
        ]
      }
    });

    captureResponsesRequestContext({
      requestId: track('req-pending-scope-b-1'),
      sessionId: 'sess-pending-b',
      conversationId: 'conv-pending-b',
      payload: { model: 'gpt-5.3-codex', store: true },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'pending-b-1' }]
          }
        ]
      }
    });

    const rawStore = responsesConversationStore as unknown as {
      requestMap?: Map<string, unknown>;
    };
    expect(rawStore.requestMap?.has('req-pending-scope-a-1')).toBe(true);
    expect(rawStore.requestMap?.has('req-pending-scope-b-1')).toBe(true);
  });

  it('keeps recording when response capture sees synthetic RouteCodex assistant control text', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-1',
      sessionId: 'sess-1',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
    ).not.toThrow();
  });

  it('keeps recording when response capture sees synthetic RouteCodex tool placeholder output', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-tool-1'),
      sessionId: 'sess-tool-1',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
        requestId: track('req-resp-store-tool-1'),
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
    ).not.toThrow();
  });

  it('keeps recording when conversation capture sees synthetic RouteCodex local control text', () => {
    captureResponsesRequestContext({
      requestId: 'req-resp-store-2',
      sessionId: 'sess-synthetic-control',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
    ).not.toThrow();
  });

  it('captures a requires_action response with unresolved function_call for later submit_tool_outputs resume', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-pending-call'),
      sessionId: 'sess-pending-call',
      payload: {
        model: 'gpt-5.3-codex',
        store: true
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
        requestId: track('req-resp-store-pending-call'),
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

    const resumed = resumeResponsesConversation(
      'resp-store-pending-call',
      { tool_outputs: [{ tool_call_id: 'call_pending_call_1', output: '/tmp/project\n' }], stream: false },
      { requestId: track('req-resp-store-pending-call-submit') }
    );
    expect(resumed.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run pwd' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_pending_call_1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_pending_call_1',
        output: '/tmp/project\n'
      })
    ]);
  });



  it('RED: store=false captured entry must not allow submit_tool_outputs resume or scope continuation', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-store-false-blocked'),
      sessionId: 'sess-store-false-blocked',
      payload: {
        model: 'gpt-5.4',
        store: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'store false should not persist continuation' }]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'store false should not persist continuation' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      }
    });

    expect(() =>
      recordResponsesResponse({
        requestId: track('req-resp-store-store-false-blocked'),
        response: {
          id: 'resp-store-false-blocked',
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              id: 'fc_store_false_blocked_1',
              call_id: 'call_store_false_blocked_1',
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
                  id: 'call_store_false_blocked_1',
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

    expect(() =>
      resumeResponsesConversation(
        'resp-store-false-blocked',
        {
          tool_outputs: [{ tool_call_id: 'call_store_false_blocked_1', output: '/tmp/project\n' }],
          stream: false
        },
        { requestId: track('req-resp-store-store-false-blocked-submit') }
      )
    ).toThrow(/Responses conversation expired or not found/);

    const restored = resumeLatestResponsesContinuationByScope({
      sessionId: 'sess-store-false-blocked',
      requestId: track('req-resp-store-store-false-blocked-next'),
      payload: {
        model: 'gpt-5.4',
        store: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn should not auto-continue' }]
          }
        ]
      }
    });
    expect(restored).toBeNull();

    clearResponsesConversationByRequestId('req-resp-store-store-false-blocked');
    clearResponsesConversationByRequestId('resp-store-false-blocked');
  });
  it('keeps native run_command function_call arguments during submit_tool_outputs resume', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-native-run-command'),
      sessionId: 'sess-native-run-command',
      payload: {
        model: 'gpt-5.4-medium',
        store: true
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

    recordResponsesResponse({
      requestId: track('req-resp-store-native-run-command'),
      response: {
        id: 'resp-store-native-run-command',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_native_run_command_1',
            call_id: 'native:run_command:3',
            name: 'run_command',
            arguments: '{"command":"pwd","workdir":"/Users/fanzhang/Documents/github/routecodex"}',
            status: 'in_progress'
          }
        ]
      }
    });

    const resumed = resumeResponsesConversation(
      'resp-store-native-run-command',
      { tool_outputs: [{ tool_call_id: 'native:run_command:3', output: '/Users/fanzhang/Documents/github/routecodex\n' }], stream: false },
      { requestId: track('req-resp-store-native-run-command-submit') }
    );
    expect(resumed.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run pwd' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'native:run_command:3',
        name: 'run_command',
        arguments: '{"command":"pwd","workdir":"/Users/fanzhang/Documents/github/routecodex"}'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'native:run_command:3',
        output: '/Users/fanzhang/Documents/github/routecodex\n'
      })
    ]);
  });

  it('RED: third submit_tool_outputs resume must preserve cumulative exec_command history instead of collapsing to first user-only input', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-third-round'),
      sessionId: 'sess-third-round',
      payload: {
        model: 'gpt-5.5',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '这是第三轮 stopless 恢复测试' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-third-round'),
      response: {
        id: 'resp-third-round-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_third_round_1',
            call_id: 'call_third_round_1',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex servertool run stop_message_auto --input-json \\"{\\\\\\"repeatCount\\\\\\":1}\\""}',
            status: 'in_progress'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_third_round_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex servertool run stop_message_auto --input-json \\"{\\\\\\"repeatCount\\\\\\":1}\\""}'
              }
            ]
          }
        }
      }
    });

    const resumed1 = resumeResponsesConversation(
      'resp-third-round-1',
      {
        tool_outputs: [{ tool_call_id: 'call_third_round_1', output: '{"repeatCount":1}' }],
        stream: false
      },
      { requestId: track('req-resp-store-third-round-submit-1') }
    );

    captureResponsesRequestContext({
      requestId: track('req-resp-store-third-round-submit-1'),
      sessionId: 'sess-third-round',
      payload: {
        model: 'gpt-5.5',
        store: true
      },
      context: {
        input: resumed1.payload.input
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-third-round-submit-1'),
      response: {
        id: 'resp-third-round-2',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_third_round_2',
            call_id: 'call_third_round_2',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex servertool run stop_message_auto --input-json \\"{\\\\\\"repeatCount\\\\\\":2}\\""}',
            status: 'in_progress'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_third_round_2',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex servertool run stop_message_auto --input-json \\"{\\\\\\"repeatCount\\\\\\":2}\\""}'
              }
            ]
          }
        }
      }
    });

    const resumed2 = resumeResponsesConversation(
      'resp-third-round-2',
      {
        tool_outputs: [{ tool_call_id: 'call_third_round_2', output: '{"repeatCount":2}' }],
        stream: false
      },
      { requestId: track('req-resp-store-third-round-submit-2') }
    );

    captureResponsesRequestContext({
      requestId: track('req-resp-store-third-round-submit-2'),
      sessionId: 'sess-third-round',
      payload: {
        model: 'gpt-5.5',
        store: true
      },
      context: {
        input: resumed2.payload.input
      }
    });

    expect(Array.isArray(resumed1.payload.input)).toBe(true);
    expect(Array.isArray(resumed2.payload.input)).toBe(true);
    expect(resumed2.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '这是第三轮 stopless 恢复测试' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_third_round_1',
        name: 'exec_command'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_third_round_1',
        output: '{"repeatCount":1}'
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_third_round_2',
        name: 'exec_command'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_third_round_2',
        output: '{"repeatCount":2}'
      })
    ]);
  });

  it('clears all retained entries on global clear (shutdown cleanup path)', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-clearall-1'),
      sessionId: 'sess-clearall-1',
      payload: { model: 'gpt-5.4', store: true },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      }
    });

    captureResponsesRequestContext({
      requestId: track('req-resp-store-clearall-2'),
      sessionId: 'sess-clearall-2',
      payload: { model: 'gpt-5.4', store: true },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      }
    });

    const before = responsesConversationStore.getDebugStats();
    expect(before.requestMapSize).toBeGreaterThan(0);

    clearAllResponsesConversationState();

    const after = responsesConversationStore.getDebugStats();
    expect(after.requestMapSize).toBe(0);
    expect(after.responseIndexSize).toBe(0);
    expect(after.scopeIndexSize).toBe(0);
    expect(after.retainedInputItems).toBe(0);
  });

  it('clears unresolved request entries without deleting resolved response index entries', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-unresolved-sweep-1'),
      sessionId: 'sess-unresolved-sweep',
      payload: { model: 'gpt-5.4', store: true },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pending' }] }]
      }
    });

    captureResponsesRequestContext({
      requestId: track('req-resp-store-unresolved-sweep-2'),
      sessionId: 'sess-unresolved-sweep-resolved',
      payload: { model: 'gpt-5.4', store: true },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resolved' }] }]
      }
    });
    recordResponsesResponse({
      requestId: track('req-resp-store-unresolved-sweep-2'),
      response: {
        id: 'resp-store-unresolved-sweep-2',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      }
    });

    const cleared = clearUnresolvedResponsesConversationRequests();
    const stats = responsesConversationStore.getDebugStats();

    expect(cleared).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
    expect(stats.requestMapSize).toBe(1);
    expect(stats.responseIndexSize).toBe(1);
  });
});
