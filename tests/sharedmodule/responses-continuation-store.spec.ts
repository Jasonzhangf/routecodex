import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureResponsesRequestContext,
  clearAllResponsesConversationState,
  clearResponsesConversationByRequestId,
  clearUnresolvedResponsesConversationRequests,
  lookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponse,
  rebindResponsesConversationRequestId,
  resetResponsesConversationStateForRestartSimulation,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  responsesConversationStore
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';
import { buildChatRequestFromResponses } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import { buildResponsesRequestContextForHttp } from '../../src/modules/llmswitch/bridge/responses-request-bridge.ts';

function findOpenAiChatToolOrderingViolation(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const pending = new Set<string>();
  for (const message of messages) {
    if (
      message?.role === 'assistant'
      && Array.isArray((message as any).tool_calls)
      && (message as any).tool_calls.length > 0
    ) {
      if (pending.size > 0) return 'assistant_tool_calls_before_previous_results';
      for (const toolCall of (message as any).tool_calls) {
        if (typeof toolCall?.id === 'string') pending.add(toolCall.id);
      }
      continue;
    }
    if (message?.role === 'tool') {
      const id = (message as any).tool_call_id;
      if (typeof id !== 'string' || !pending.has(id)) return 'orphan_tool_result';
      pending.delete(id);
      continue;
    }
    if (pending.size > 0) return 'non_tool_message_before_tool_results';
  }
  return pending.size > 0 ? 'dangling_tool_call' : null;
}

describe('responses conversation store plain continuation restore', () => {
  const requestIds = new Set<string>();
  const persistFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'responses-store-spec-')),
    'responses-conversation-store.json'
  );
  process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = persistFile;

  const track = (requestId: string): string => {
    requestIds.add(requestId);
    return requestId;
  };

  afterEach(() => {
    clearAllResponsesConversationState();
    for (const requestId of requestIds) {
      clearResponsesConversationByRequestId(requestId);
    }
    requestIds.clear();
    try {
      fs.rmSync(persistFile, { force: true });
    } catch {}
  });

  it('reports missing response request context as local store error without scope fallback', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-other-context'),
      providerKey: 'minimax.key1.MiniMax-M2.7',
      sessionId: 'sess-missing-context',
      conversationId: 'conv-missing-context',
      matchedPort: null,
      payload: {
        model: 'gpt-5.5',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] }]
      },
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] }]
      }
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => recordResponsesResponse({
        requestId: track('req-resp-store-missing-context'),
        providerKey: 'minimax.key1.MiniMax-M2.7',
        sessionId: 'sess-missing-context',
        conversationId: 'conv-missing-context',
        matchedPort: null,
        response: {
          id: 'resp-missing-context',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }]
            }
          ]
        }
      })).toThrow(expect.objectContaining({
        name: 'ProviderProtocolError',
        code: 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT',
        category: 'INTERNAL_ERROR',
        details: expect.objectContaining({
          reason: 'missing_request_context',
          requestId: 'req-resp-store-missing-context',
          responseId: 'resp-missing-context'
        })
      }));

      expect(warnSpy).toHaveBeenCalledWith(
        '[responses-store] record.missing_request_context failed code=RESPONSES_STORE_MISSING_REQUEST_CONTEXT reason=missing_request_context'
      );
      const rendered = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(rendered).not.toContain('Error: missing_request_context');
      expect(rendered).not.toContain('details=');
      expect(rendered).not.toContain(' at ');
    } finally {
      warnSpy.mockRestore();
    }
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
      scopeKey: 'entry:responses|owner:relay|session:sess-1',
      providerKey: 'crs.direct.gpt-5.4',
      restored: true
    });
  });

  it('preserves restored tools for relay continuation resume when caller tools are empty', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-stopless-tools-1'),
      sessionId: 'sess-stopless-tools',
      conversationId: 'conv-stopless-tools',
      providerKey: 'XL.key1.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-stopless-tools-1'),
      providerKey: 'XL.key1.gpt-5.4',
      response: {
        id: 'resp-stopless-tools-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '继续做下一步' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-stopless-tools-2'),
      sessionId: 'sess-stopless-tools',
      conversationId: 'conv-stopless-tools',
      entryKind: 'responses',
      continuationOwner: 'relay',
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-stopless-tools-1',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行下一步' }]
          }
        ]
      }
    });

    expect(restored).not.toBeNull();
    expect(restored?.meta).toMatchObject({
      restoredFromResponseId: 'resp-stopless-tools-1',
      restored: true
    });
    expect(Array.isArray((restored?.meta as any)?.restoredTools)).toBe(true);
    expect((restored?.meta as any)?.restoredTools?.[0]).toMatchObject({
      type: 'function',
      name: 'exec_command'
    });

    const chatRequest = buildChatRequestFromResponses(
      {
        model: 'gpt-5.4',
        previous_response_id: 'resp-stopless-tools-1',
        input: (restored as any).payload.input,
        semantics: {
          responses: {
            resume: restored?.meta
          }
        },
        tools: []
      },
      {
        requestId: 'req-resp-store-stopless-tools-bridge',
        input: (restored as any).payload.input,
        toolsNormalized: [] as any
      } as any
    );

    expect(Array.isArray((chatRequest as any)?.toolsNormalized)).toBe(true);
    expect((chatRequest as any)?.toolsNormalized?.[0]).toMatchObject({
      type: 'function',
      function: expect.objectContaining({
        name: 'exec_command'
      })
    });
  });

  it('preserves restored tools for relay continuation materialize after request release', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-materialize-tools-1'),
      sessionId: 'sess-materialize-tools',
      conversationId: 'conv-materialize-tools',
      providerKey: 'XL.key1.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '先执行第一步' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-materialize-tools-1'),
      providerKey: 'XL.key1.gpt-5.4',
      response: {
        id: 'resp-materialize-tools-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '第一步完成' }]
          }
        ]
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-materialize-tools-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-materialize-tools-2'),
      sessionId: 'sess-materialize-tools',
      conversationId: 'conv-materialize-tools',
      entryKind: 'responses',
      continuationOwner: 'relay',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续第二步' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.meta).toMatchObject({
      restoredFromResponseId: 'resp-materialize-tools-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
    expect(Array.isArray((materialized?.meta as any)?.restoredTools)).toBe(true);
    expect((materialized?.meta as any)?.restoredTools?.[0]).toMatchObject({
      type: 'function',
      name: 'exec_command'
    });
  });

  it('keeps a pending operation across response save, response outbound release, next request restore, and chat bridge mapping', async () => {
    captureResponsesRequestContext({
      requestId: track('req-cross-operation-store-1'),
      sessionId: 'sess-cross-operation',
      conversationId: 'conv-cross-operation',
      providerKey: 'XL.key1.gpt-5.5',
      payload: {
        model: 'gpt-5.5',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run the verification command' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-cross-operation-store-1'),
      providerKey: 'XL.key1.gpt-5.5',
      continuationOwner: 'relay',
      response: {
        id: 'resp-cross-operation-1',
        status: 'requires_action',
        output: [
          {
            id: 'fc_call_cross_operation_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_cross_operation_1',
            name: 'exec_command',
            arguments: '{"cmd":"printf cross-request"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_cross_operation_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"printf cross-request"}'
              }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-cross-operation-store-1');

    const resumed = resumeResponsesConversation(
      'resp-cross-operation-1',
      {
        response_id: 'resp-cross-operation-1',
        model: 'gpt-5.5',
        tool_outputs: [
          {
            call_id: 'call_cross_operation_1',
            output: 'cross-request'
          }
        ]
      },
      {
        requestId: track('req-cross-operation-store-2'),
        continuationOwner: 'relay'
      }
    );

    expect(resumed.payload.previous_response_id).toBe('resp-cross-operation-1');
    expect(resumed.meta).toMatchObject({
      restoredFromResponseId: 'resp-cross-operation-1',
      previousRequestId: 'req-cross-operation-store-1',
      restored: true
    });
    expect((resumed.meta as any).fullInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_cross_operation_1',
          name: 'exec_command',
          arguments: '{"cmd":"printf cross-request"}'
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_cross_operation_1',
          output: 'cross-request'
        })
      ])
    );

    const requestContext = await buildResponsesRequestContextForHttp({
      payload: resumed.payload,
      requestId: track('req-cross-operation-store-2'),
      resumeMeta: {
        ...(resumed.meta as Record<string, unknown>),
        continuationOwner: 'relay'
      },
      metadata: {
        session_id: 'sess-cross-operation',
        conversation_id: 'conv-cross-operation'
      }
    });

    const chatRequest = buildChatRequestFromResponses(
      {
        model: 'gpt-5.5',
        previous_response_id: 'resp-cross-operation-1',
        input: requestContext.payload.input,
        tools: requestContext.payload.tools,
        semantics: {
          responses: {
            resume: resumed.meta
          }
        }
      },
      {
        requestId: 'req-cross-operation-chat-bridge',
        input: requestContext.context.input,
        toolsNormalized: []
      } as any
    );

    expect(findOpenAiChatToolOrderingViolation((chatRequest.request as any).messages)).toBeNull();
    expect((chatRequest.request as any).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [
            expect.objectContaining({
              id: 'call_cross_operation_1',
              type: 'function',
              function: expect.objectContaining({
                name: 'exec_command',
                arguments: '{"cmd":"printf cross-request"}'
              })
            })
          ]
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_cross_operation_1',
          content: 'cross-request'
        })
      ])
    );
  });

  it('rebinds the same continuation request context across provider switch and resumes from final success only', () => {
    captureResponsesRequestContext({
      requestId: track('req-provider-switch-router-1'),
      sessionId: 'sess-provider-switch',
      conversationId: 'conv-provider-switch',
      providerKey: 'crs.key1.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'provider switch then continue' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      }
    });

    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

    const providerAttempt1 = track('req-provider-switch-attempt-1');
    const providerAttempt2 = track('req-provider-switch-attempt-2');

    rebindResponsesConversationRequestId('req-provider-switch-router-1', providerAttempt1);
    rebindResponsesConversationRequestId(providerAttempt1, providerAttempt2);

    expect(() =>
      resumeLatestResponsesContinuationByScope({
        requestId: track('req-provider-switch-probe'),
        sessionId: 'sess-provider-switch',
        conversationId: 'conv-provider-switch',
        entryKind: 'responses',
        continuationOwner: 'relay',
        payload: {
          model: 'gpt-5.4',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'next turn after reroute' }]
            }
          ]
        }
      })
    ).not.toThrow();

    recordResponsesResponse({
      requestId: providerAttempt2,
      providerKey: 'crs.key2.gpt-5.4',
      response: {
        id: 'resp-provider-switch-success-1',
        status: 'requires_action',
        output: [
          {
            id: 'fc_call_provider_switch',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_provider_switch',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_provider_switch',
                type: 'function_call',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }
            ]
          }
        }
      }
    });

    const resumed = resumeResponsesConversation('resp-provider-switch-success-1', {
      response_id: 'resp-provider-switch-success-1',
      tool_outputs: [{ tool_call_id: 'call_provider_switch', output: 'ok' }]
    });

    expect(resumed.payload.previous_response_id).toBe('resp-provider-switch-success-1');
    expect(resumed.meta).toMatchObject({
      restoredFromResponseId: 'resp-provider-switch-success-1',
      previousRequestId: providerAttempt2,
      providerKey: 'crs.key2.gpt-5.4'
    });
  });

  it('keeps the canonical entry request id recordable after provider request id rebind', () => {
    captureResponsesRequestContext({
      requestId: track('req-provider-switch-router-alias-1'),
      sessionId: 'sess-provider-switch-alias',
      conversationId: 'conv-provider-switch-alias',
      providerKey: 'crs.key1.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'provider switch then continue' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: {} }
          }
        ]
      }
    });

    const providerAttempt = track('req-provider-switch-alias-attempt-1');
    rebindResponsesConversationRequestId('req-provider-switch-router-alias-1', providerAttempt);

    recordResponsesResponse({
      requestId: 'req-provider-switch-router-alias-1',
      providerKey: 'crs.key1.gpt-5.4',
      response: {
        id: 'resp-provider-switch-alias-success-1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      }
    });

    const lookup = lookupResponsesContinuationByResponseId('resp-provider-switch-alias-success-1');
    expect(lookup).toMatchObject({
      responseId: 'resp-provider-switch-alias-success-1',
      requestId: providerAttempt,
      providerKey: 'crs.key1.gpt-5.4'
    });
  });

  it('RED: relay materialized submit_tool_outputs resume keeps tools through request bridge restore', async () => {
    captureResponsesRequestContext({
      requestId: track('req-relay-materialized-tools-1'),
      sessionId: 'sess-relay-materialized-tools',
      conversationId: 'conv-relay-materialized-tools',
      payload: {
        model: 'gpt-5.5',
        store: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续 stopless relay materialized tools 验证' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-relay-materialized-tools-1'),
      continuationOwner: 'relay',
      response: {
        id: 'resp-relay-materialized-tools-1',
        status: 'requires_action',
        output: [
          {
            id: 'fc_call_relay_materialized_tools_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_relay_materialized_tools_1',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"maxRepeats\\\\\\":3,\\\\\\"repeatCount\\\\\\":1,\\\\\\"triggerHint\\\\\\":\\\\\\"no_schema\\\\\\"}\\""}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_relay_materialized_tools_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"maxRepeats\\\\\\":3,\\\\\\"repeatCount\\\\\\":1,\\\\\\"triggerHint\\\\\\":\\\\\\"no_schema\\\\\\"}\\""}'
              }
            ]
          }
        }
      }
    });

    const resumed = resumeResponsesConversation('resp-relay-materialized-tools-1', {
      response_id: 'resp-relay-materialized-tools-1',
      tool_outputs: [
        {
          call_id: 'call_relay_materialized_tools_1',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3,"routeHint":"thinking"}'
        }
      ]
    }, {
      requestId: track('req-relay-materialized-tools-2'),
      continuationOwner: 'relay'
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: resumed.payload,
      requestId: track('req-relay-materialized-tools-2'),
      resumeMeta: resumed.meta,
      metadata: {
        session_id: 'sess-relay-materialized-tools',
        conversation_id: 'conv-relay-materialized-tools'
      }
    });

    expect(Array.isArray((resumed.meta as any)?.restoredTools)).toBe(true);
    expect(context.payload.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'exec_command'
      })
    ]);
    expect(context.context.toolsRaw).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'exec_command'
      })
    ]);
  });

  it('records response message output_text as legal request history input_text instead of replaying response-only content types', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-output-text-1'),
      sessionId: 'sess-output-text',
      conversationId: 'conv-output-text',
      providerKey: 'crs.direct.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true,
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
      requestId: track('req-resp-store-output-text-1'),
      providerKey: 'crs.direct.gpt-5.4',
      response: {
        id: 'resp-output-text-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'world' },
              { type: 'commentary', text: 'progress note' }
            ]
          }
        ]
      }
    });

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-output-text-2'),
      sessionId: 'sess-output-text',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        metadata: { conversation_id: 'conv-output-text' },
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
        content: [
          { type: 'input_text', text: 'world' },
          { type: 'input_text', text: 'progress note' }
        ]
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
    expect(JSON.stringify(materialized)).not.toContain('"output_text"');
    expect(JSON.stringify(materialized)).not.toContain('"commentary"');
  });

  it('records reasoning history without replaying illegal reasoning.content back into next request', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-reasoning-1'),
      sessionId: 'sess-reasoning',
      conversationId: 'conv-reasoning',
      providerKey: 'crs.direct.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true,
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
      requestId: track('req-resp-store-reasoning-1'),
      providerKey: 'crs.direct.gpt-5.4',
      response: {
        id: 'resp-reasoning-1',
        output: [
          {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: [{ type: 'summary_text', text: 'thinking step 1' }],
            content: [{ type: 'reasoning_text', text: 'historical reasoning leak' }],
            encrypted_content: 'opaque-sig-abc'
          }
        ]
      }
    });

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-reasoning-2'),
      sessionId: 'sess-reasoning',
      payload: {
        model: 'gpt-5.4',
        stream: true,
        metadata: { conversation_id: 'conv-reasoning' },
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
        type: 'reasoning',
        id: 'reasoning-1',
        summary: [{ type: 'summary_text', text: 'thinking step 1' }],
        encrypted_content: 'opaque-sig-abc'
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
    const serialized = JSON.stringify(materialized);
    expect(serialized).not.toContain('"reasoning_text"');
    expect(serialized).not.toContain('historical reasoning leak');
  });

  it('submit_tool_outputs resume keeps function_call history without replaying response-only status fields', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-fc-status-1'),
      sessionId: 'sess-fc-status',
      conversationId: 'conv-fc-status',
      providerKey: 'minimax.key1.MiniMax-M3',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true,
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run the command' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-fc-status-1'),
      providerKey: 'minimax.key1.MiniMax-M3',
      response: {
        id: 'resp-fc-status-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_status_1',
            call_id: 'call_status_1',
            name: 'exec_command',
            status: 'in_progress',
            arguments: '{"cmd":"pwd"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_status_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }
            ]
          }
        }
      }
    });

    const resumed = resumeResponsesConversation(
      'resp-fc-status-1',
      {
        tool_outputs: [{ tool_call_id: 'call_status_1', output: '/tmp/project\n' }],
        stream: false
      },
      { requestId: track('req-resp-store-fc-status-2') }
    );

    expect(resumed.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run the command' }]
      },
      {
        type: 'function_call',
        id: 'fc_status_1',
        call_id: 'call_status_1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      },
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_status_1',
        output: '/tmp/project\n'
      })
    ]);
    expect(JSON.stringify(resumed.payload.input)).not.toContain('"status":"in_progress"');
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

  it('RED: direct-owned scope continuation must not local-restore remote previous_response_id by scope', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-direct-scope-1'),
      sessionId: 'sess-direct-scope',
      conversationId: 'conv-direct-scope',
      providerKey: 'asxs.crsa.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              parameters: {
                type: 'object',
                properties: {
                  patch: { type: 'string' }
                },
                required: ['patch']
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
            content: [{ type: 'input_text', text: 'first turn' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-direct-scope-1'),
      providerKey: 'asxs.crsa.gpt-5.4',
      continuationOwner: 'direct',
      response: {
        id: 'resp-direct-scope-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }]
          }
        ]
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-direct-scope-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-direct-scope-2'),
      sessionId: 'sess-direct-scope',
      conversationId: 'conv-direct-scope',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'second turn' }]
          }
        ]
      }
    });

    expect(materialized).toBeNull();
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

    responsesConversationStore.releaseRequestPayload('req-resp-store-1');

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

  it('releasing request payload strips historical images from stored continuation history after success', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-image-release-1'),
      sessionId: 'sess-image-release',
      payload: {
        model: 'gpt-5.3-codex',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,HISTORY' },
              { type: 'input_text', text: 'look' }
            ]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-image-release-1'),
      response: {
        id: 'resp-store-image-release-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }]
          }
        ]
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-image-release-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-image-release-2'),
      sessionId: 'sess-image-release',
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
    const serialized = JSON.stringify(materialized?.payload ?? {});
    expect(serialized).not.toContain('data:image/png;base64,HISTORY');
    expect(serialized).toContain('[Image omitted]');
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '[Image omitted]' },
          { type: 'input_text', text: 'look' }
        ]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: 'done' }]
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }]
      }
    ]);
  });

  it('stored continuation history preserves historical images before success release', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-image-capture-1'),
      sessionId: 'sess-image-capture',
      payload: {
        model: 'gpt-5.3-codex',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,HISTORY_RAW' },
              { type: 'input_text', text: 'look raw' }
            ]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-image-capture-1'),
      response: {
        id: 'resp-store-image-capture-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done raw' }]
          }
        ]
      }
    });

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-image-capture-2'),
      sessionId: 'sess-image-capture',
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
    const serialized = JSON.stringify(materialized?.payload ?? {});
    expect(serialized).toContain('data:image/png;base64,HISTORY_RAW');
    expect(serialized).not.toContain('[Image omitted]');
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
      scopeKey: 'entry:responses|owner:relay|session:sess-1',
      materialized: true,
      materializedMode: 'local_full_input'
    });
  });

  it('does not restore a responses continuation for a non-responses entry kind', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-entry-kind-1'),
      sessionId: 'sess-entry-kind',
      conversationId: 'conv-entry-kind',
      payload: {
        model: 'gpt-5.4',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello responses' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-entry-kind-1'),
      response: {
        id: 'resp-entry-kind-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world responses' }]
          }
        ]
      }
    });

    const restored = resumeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-entry-kind-2'),
      sessionId: 'sess-entry-kind',
      conversationId: 'conv-entry-kind',
      entryKind: 'chat',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next chat turn' }]
          }
        ]
      }
    });

    expect(restored).toBeNull();
  });

  it('fails fast when direct and relay continuations coexist under one scope without explicit owner', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-owner-relay-1'),
      sessionId: 'sess-owner-split',
      conversationId: 'conv-owner-split',
      payload: {
        model: 'gpt-5.4',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'relay branch' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-owner-relay-1'),
      response: {
        id: 'resp-owner-relay-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'relay response' }]
          }
        ]
      }
    });

    captureResponsesRequestContext({
      requestId: track('req-resp-store-owner-direct-1'),
      sessionId: 'sess-owner-split',
      conversationId: 'conv-owner-split',
      providerKey: 'provider.direct.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'direct branch' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-owner-direct-1'),
      providerKey: 'provider.direct.gpt-5.4',
      continuationOwner: 'direct',
      response: {
        id: 'resp-owner-direct-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'direct response' }]
          }
        ]
      }
    });
    responsesConversationStore.releaseRequestPayload('req-resp-store-owner-direct-1');

    const ambiguous = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-owner-next-1'),
      sessionId: 'sess-owner-split',
      conversationId: 'conv-owner-split',
      entryKind: 'responses',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }]
          }
        ]
      }
    });
    expect(ambiguous).toBeNull();

    const relayOnly = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-owner-next-relay'),
      sessionId: 'sess-owner-split',
      conversationId: 'conv-owner-split',
      entryKind: 'responses',
      continuationOwner: 'relay',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn relay' }]
          }
        ]
      }
    });
    expect(relayOnly?.meta).toMatchObject({
      restoredFromResponseId: 'resp-owner-relay-1',
      continuationOwner: 'relay',
      materialized: true
    });

    const directOnly = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-owner-next-direct'),
      sessionId: 'sess-owner-split',
      conversationId: 'conv-owner-split',
      entryKind: 'responses',
      continuationOwner: 'direct',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn direct' }]
          }
        ]
      }
    });
    expect(directOnly).toBeNull();
  });

  it('RED: restart simulation must not reload persisted direct-owned continuation by scope, while relay-owned continuation still reloads', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-restart-relay-1'),
      sessionId: 'sess-restart-owner',
      conversationId: 'conv-restart-owner',
      providerKey: 'provider.relay.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'relay turn' }]
          }
        ]
      }
    });
    recordResponsesResponse({
      requestId: track('req-resp-store-restart-relay-1'),
      providerKey: 'provider.relay.gpt-5.4',
      continuationOwner: 'relay',
      response: {
        id: 'resp-restart-relay-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'relay response' }]
          }
        ]
      }
    });
    responsesConversationStore.releaseRequestPayload('req-resp-store-restart-relay-1');

    captureResponsesRequestContext({
      requestId: track('req-resp-store-restart-direct-1'),
      sessionId: 'sess-restart-owner',
      conversationId: 'conv-restart-owner-direct',
      providerKey: 'provider.direct.gpt-5.4',
      payload: {
        model: 'gpt-5.4',
        store: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'direct turn' }]
          }
        ]
      }
    });
    recordResponsesResponse({
      requestId: track('req-resp-store-restart-direct-1'),
      providerKey: 'provider.direct.gpt-5.4',
      continuationOwner: 'direct',
      response: {
        id: 'resp-restart-direct-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'direct response' }]
          }
        ]
      }
    });
    responsesConversationStore.releaseRequestPayload('req-resp-store-restart-direct-1');

    expect(fs.existsSync(persistFile)).toBe(true);

    resetResponsesConversationStateForRestartSimulation();

    const relayReloaded = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-restart-relay-next'),
      sessionId: 'sess-restart-owner',
      conversationId: 'conv-restart-owner',
      entryKind: 'responses',
      continuationOwner: 'relay',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'relay next' }]
          }
        ]
      }
    });
    expect(relayReloaded).not.toBeNull();
    expect(relayReloaded?.meta).toMatchObject({
      restoredFromResponseId: 'resp-restart-relay-1',
      continuationOwner: 'relay'
    });

    const directReloaded = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-restart-direct-next'),
      sessionId: 'sess-restart-owner',
      conversationId: 'conv-restart-owner-direct',
      entryKind: 'responses',
      continuationOwner: 'direct',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'direct next' }]
          }
        ]
      }
    });
    expect(directReloaded).toBeNull();
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

    responsesConversationStore.releaseRequestPayload('req-resp-store-release-materialize-1');

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

  it('RED: materialize must not duplicate pending tool-call history when incoming payload already replays the current pending turn', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-no-dup-pending-1'),
      sessionId: 'sess-no-dup-pending',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'first user' }]
          },
          {
            type: 'function_call',
            id: 'fc_prev_1',
            call_id: 'call_prev_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          },
          {
            type: 'function_call_output',
            id: 'fc_prev_1',
            call_id: 'call_prev_1',
            output: '/tmp'
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-no-dup-pending-1'),
      response: {
        id: 'resp-no-dup-pending-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_pending_1',
            call_id: 'call_pending_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,5p note.md"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_pending_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"sed -n 1,5p note.md"}'
              }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-no-dup-pending-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-no-dup-pending-2'),
      sessionId: 'sess-no-dup-pending',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call',
            id: 'fc_pending_1',
            call_id: 'call_pending_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,5p note.md"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_pending_1',
            output: 'ok'
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first user' }]
      },
      {
        type: 'function_call',
        id: 'fc_prev_1',
        call_id: 'call_prev_1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      },
      {
        type: 'function_call_output',
        id: 'fc_prev_1',
        call_id: 'call_prev_1',
        output: '/tmp'
      },
      {
        type: 'function_call',
        id: 'fc_pending_1',
        call_id: 'call_pending_1',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,5p note.md"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_pending_1',
        output: 'ok'
      }
    ]);
  });

  it('RED: materialize must not duplicate a replayed pending tool batch when incoming payload restarts from the persisted tail block', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-tail-batch-1'),
      sessionId: 'sess-tail-batch',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'start' }]
          },
          {
            type: 'reasoning',
            id: 'rs_tail_1',
            summary: [{ type: 'summary_text', text: 'plan tools' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will inspect the relevant files.' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-tail-batch-1'),
      response: {
        id: 'resp-tail-batch-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_tail_1',
            call_id: 'call_tail_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p note.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_2',
            call_id: 'call_tail_2',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_3',
            call_id: 'call_tail_3',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_4',
            call_id: 'call_tail_4',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              { id: 'call_tail_1', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p note.md"}' },
              { id: 'call_tail_2', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p CACHE.md"}' },
              { id: 'call_tail_3', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}' },
              { id: 'call_tail_4', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}' }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-tail-batch-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-tail-batch-2'),
      sessionId: 'sess-tail-batch',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'reasoning',
            id: 'rs_tail_1',
            summary: [{ type: 'summary_text', text: 'plan tools' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will inspect the relevant files.' }]
          },
          {
            type: 'function_call',
            id: 'fc_tail_1',
            call_id: 'call_tail_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p note.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_2',
            call_id: 'call_tail_2',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_3',
            call_id: 'call_tail_3',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_tail_4',
            call_id: 'call_tail_4',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_tail_1',
            output: 'note'
          },
          {
            type: 'function_call_output',
            call_id: 'call_tail_2',
            output: 'cache'
          },
          {
            type: 'function_call_output',
            call_id: 'call_tail_3',
            output: 'agents'
          },
          {
            type: 'function_call_output',
            call_id: 'call_tail_4',
            output: 'memory'
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'continue' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'start' }]
      },
      {
        type: 'reasoning',
        id: 'rs_tail_1',
        summary: [{ type: 'summary_text', text: 'plan tools' }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect the relevant files.' }]
      },
      {
        type: 'function_call',
        id: 'fc_tail_1',
        call_id: 'call_tail_1',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p note.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_tail_2',
        call_id: 'call_tail_2',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_tail_3',
        call_id: 'call_tail_3',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_tail_4',
        call_id: 'call_tail_4',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_tail_1',
        output: 'note'
      },
      {
        type: 'function_call_output',
        call_id: 'call_tail_2',
        output: 'cache'
      },
      {
        type: 'function_call_output',
        call_id: 'call_tail_3',
        output: 'agents'
      },
      {
        type: 'function_call_output',
        call_id: 'call_tail_4',
        output: 'memory'
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    ]);
  });

  it('RED: materialize must collapse duplicated pending call batches when incoming delta repeats the same call_ids twice', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-dup-call-batch-1'),
      sessionId: 'sess-dup-call-batch',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'start' }]
          },
          {
            type: 'reasoning',
            id: 'rs_dup_1',
            summary: [{ type: 'summary_text', text: 'plan tools' }]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will inspect the relevant files.' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-dup-call-batch-1'),
      response: {
        id: 'resp-dup-call-batch-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_dup_1',
            call_id: 'call_dup_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p note.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_2',
            call_id: 'call_dup_2',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_3',
            call_id: 'call_dup_3',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_4',
            call_id: 'call_dup_4',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              { id: 'call_dup_1', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p note.md"}' },
              { id: 'call_dup_2', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p CACHE.md"}' },
              { id: 'call_dup_3', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}' },
              { id: 'call_dup_4', type: 'function', name: 'exec_command', arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}' }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-dup-call-batch-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-dup-call-batch-2'),
      sessionId: 'sess-dup-call-batch',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call',
            id: 'fc_dup_1',
            call_id: 'call_dup_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p note.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_2',
            call_id: 'call_dup_2',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_3',
            call_id: 'call_dup_3',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_4',
            call_id: 'call_dup_4',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_1',
            call_id: 'call_dup_1',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p note.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_2',
            call_id: 'call_dup_2',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_3',
            call_id: 'call_dup_3',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
          },
          {
            type: 'function_call',
            id: 'fc_dup_4',
            call_id: 'call_dup_4',
            name: 'exec_command',
            arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_1',
            output: 'note:first'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_2',
            output: 'cache:first'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_3',
            output: 'agents:first'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_4',
            output: 'memory:first'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_1',
            output: 'note:second'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_2',
            output: 'cache:second'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_3',
            output: 'agents:second'
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup_4',
            output: 'memory:second'
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'continue' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'start' }]
      },
      {
        type: 'reasoning',
        id: 'rs_dup_1',
        summary: [{ type: 'summary_text', text: 'plan tools' }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect the relevant files.' }]
      },
      {
        type: 'function_call',
        id: 'fc_dup_1',
        call_id: 'call_dup_1',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p note.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_dup_2',
        call_id: 'call_dup_2',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p CACHE.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_dup_3',
        call_id: 'call_dup_3',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p AGENTS.md"}'
      },
      {
        type: 'function_call',
        id: 'fc_dup_4',
        call_id: 'call_dup_4',
        name: 'exec_command',
        arguments: '{"cmd":"sed -n 1,10p MEMORY.md"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_dup_1',
        output: 'note:first'
      },
      {
        type: 'function_call_output',
        call_id: 'call_dup_2',
        output: 'cache:first'
      },
      {
        type: 'function_call_output',
        call_id: 'call_dup_3',
        output: 'agents:first'
      },
      {
        type: 'function_call_output',
        call_id: 'call_dup_4',
        output: 'memory:first'
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    ]);
  });

  it('RED: recordResponse must preserve standalone reasoning output items in persisted history before later tool turns', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-reasoning-keep-1'),
      sessionId: 'sess-reasoning-keep',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'inspect repo and continue' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-reasoning-keep-1'),
      response: {
        id: 'resp-reasoning-keep-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'reasoning',
            id: 'rs_reasoning_keep_1',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'plan tools' }],
            content: [{ type: 'reasoning_text', text: 'Need to inspect cwd before editing.' }]
          },
          {
            type: 'function_call',
            id: 'fc_reasoning_keep_1',
            call_id: 'call_reasoning_keep_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              { id: 'call_reasoning_keep_1', type: 'function', name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-reasoning-keep-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-reasoning-keep-2'),
      sessionId: 'sess-reasoning-keep',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call',
            id: 'fc_reasoning_keep_1',
            call_id: 'call_reasoning_keep_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_reasoning_keep_1',
            output: '/tmp'
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'continue' }]
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'inspect repo and continue' }]
      },
      {
        type: 'reasoning',
        id: 'rs_reasoning_keep_1',
        summary: [{ type: 'summary_text', text: 'plan tools' }]
      },
      {
        type: 'function_call',
        id: 'fc_reasoning_keep_1',
        call_id: 'call_reasoning_keep_1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_reasoning_keep_1',
        output: '/tmp'
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    ]);
  });

  it('materialize still builds full input when incoming payload is true delta after a pending tool call', () => {
    captureResponsesRequestContext({
      requestId: track('req-resp-store-pending-delta-1'),
      sessionId: 'sess-pending-delta',
      payload: {
        model: 'gpt-5.4',
        store: true,
        stream: true
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'start' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-pending-delta-1'),
      response: {
        id: 'resp-pending-delta-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_delta_1',
            call_id: 'call_delta_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_delta_1',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }
            ]
          }
        }
      }
    });

    responsesConversationStore.releaseRequestPayload('req-resp-store-pending-delta-1');

    const materialized = materializeLatestResponsesContinuationByScope({
      requestId: track('req-resp-store-pending-delta-2'),
      sessionId: 'sess-pending-delta',
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_delta_1',
            output: 'delta-ok'
          }
        ]
      }
    });

    expect(materialized).not.toBeNull();
    expect(materialized?.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'start' }]
      },
      {
        type: 'function_call',
        id: 'fc_delta_1',
        call_id: 'call_delta_1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_delta_1',
        output: 'delta-ok'
      }
    ]);
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

    responsesConversationStore.releaseRequestPayload('req-resp-store-1');

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
    expect(rawStore.scopeIndex?.has('entry:responses|owner:relay|session:sess-supersede')).toBe(true);
    expect(rawStore.scopeIndex?.has('entry:responses|owner:relay|conversation:conv-supersede')).toBe(true);

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



  it('RED: store=false captured entry still allows same-response submit_tool_outputs resume when pending tool calls exist, but must not allow scope continuation', () => {
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

    const resumed = resumeResponsesConversation(
      'resp-store-false-blocked',
      {
        tool_outputs: [{ tool_call_id: 'call_store_false_blocked_1', output: '/tmp/project\n' }],
        stream: false
      },
      { requestId: track('req-resp-store-store-false-blocked-submit') }
    );
    expect(resumed.payload).toBeTruthy();
    expect(resumed.meta).toMatchObject({
      restoredFromResponseId: 'resp-store-false-blocked'
    });

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

  it('RED: third submit_tool_outputs resume must collapse auto stopless tool history to latest guidance only', () => {
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
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}',
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
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}'
              }
            ]
          }
        }
      }
    });

    const resumed1 = resumeResponsesConversation(
      'resp-third-round-1',
      {
        tool_outputs: [{
          tool_call_id: 'call_third_round_1',
          output: '{"ok":true,"toolName":"stop_message_auto","flowId":"stop_message_flow","continuationPrompt":"继续往下做；先把手头能确认的结果拿回来。","repeatCount":2,"maxRepeats":3,"schemaGuidance":{"requiredFields":["stopreason","reason","next_step"],"stopreasonValues":{"finished":0,"blocked":1,"continueNeeded":2}}}'
        }],
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
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}',
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
                arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}'
              }
            ]
          }
        }
      }
    });

    const resumed2 = resumeResponsesConversation(
      'resp-third-round-2',
      {
        tool_outputs: [{
          tool_call_id: 'call_third_round_2',
          output: '{"ok":true,"toolName":"stop_message_auto","flowId":"stop_message_flow","continuationPrompt":"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。","repeatCount":3,"maxRepeats":3,"schemaGuidance":{"requiredFields":["stopreason","reason","next_step"],"stopreasonValues":{"finished":0,"blocked":1,"continueNeeded":2}}}'
        }],
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
    const resumed1Guidance = (resumed1.payload.input as Array<any>)[1]?.content?.[0]?.text ?? '';
    const resumed2Guidance = (resumed2.payload.input as Array<any>)[1]?.content?.[0]?.text ?? '';
    expect(String(resumed1Guidance)).toContain('上一轮执行结果：repeatCount=2/3');
    expect(String(resumed2Guidance)).toContain('上一轮执行结果：repeatCount=3/3');
    expect(String(resumed2Guidance)).toContain('stopreason');
    expect(String(resumed2Guidance)).toContain('0=finished，1=blocked，2=continue_needed');
    expect(resumed2.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '这是第三轮 stopless 恢复测试' }]
      },
      {
        type: 'message',
        role: 'user',
        content: [
          expect.objectContaining({
            type: 'input_text',
            text: expect.stringContaining('继续')
          })
        ]
      }
    ]);
    expect(JSON.stringify(resumed2.payload.input)).not.toContain('call_third_round_1');
    expect(JSON.stringify(resumed2.payload.input)).not.toContain('call_third_round_2');
    expect(JSON.stringify(resumed2.payload.input)).not.toContain('"type":"function_call_output"');
  });

  it('RED: reopened apply_patch after exec_command stays tool-ordered after submit_tool_outputs resume', () => {
    const patch1 = [
      '*** Begin Patch',
      '*** Update File: docs/a.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch'
    ].join('\n');
    const patch2 = [
      '*** Begin Patch',
      '*** Update File: docs/b.txt',
      '@@',
      '-before',
      '+after',
      '*** End Patch'
    ].join('\n');

    captureResponsesRequestContext({
      requestId: track('req-resp-store-reopen-1'),
      sessionId: 'sess-reopen-apply-patch',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          { type: 'function', function: { name: 'apply_patch' } },
          { type: 'function', function: { name: 'exec_command' } }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '开始修复' }]
          }
        ]
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-reopen-1'),
      response: {
        id: 'resp-reopen-1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '先打补丁' }]
          },
          {
            type: 'function_call',
            id: 'fc_patch_1',
            call_id: 'call_patch_1',
            name: 'apply_patch',
            arguments: JSON.stringify({ patch: patch1 }),
            status: 'completed'
          }
        ]
      }
    });

    const resumed1 = resumeResponsesConversation(
      'resp-reopen-1',
      {
        tool_outputs: [{ tool_call_id: 'call_patch_1', output: 'Patch applied successfully.' }],
        stream: false
      },
      { requestId: track('req-resp-store-reopen-2') }
    );

    captureResponsesRequestContext({
      requestId: track('req-resp-store-reopen-2'),
      sessionId: 'sess-reopen-apply-patch',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          { type: 'function', function: { name: 'apply_patch' } },
          { type: 'function', function: { name: 'exec_command' } }
        ]
      },
      context: {
        input: resumed1.payload.input
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-reopen-2'),
      response: {
        id: 'resp-reopen-2',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '再跑命令确认' }]
          },
          {
            type: 'function_call',
            id: 'fc_exec_1',
            call_id: 'call_exec_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            status: 'completed'
          }
        ]
      }
    });

    const resumed2 = resumeResponsesConversation(
      'resp-reopen-2',
      {
        tool_outputs: [{ tool_call_id: 'call_exec_1', output: '/Users/fanzhang/Documents/github/routecodex' }],
        stream: false
      },
      { requestId: track('req-resp-store-reopen-3') }
    );

    captureResponsesRequestContext({
      requestId: track('req-resp-store-reopen-3'),
      sessionId: 'sess-reopen-apply-patch',
      payload: {
        model: 'gpt-5.4',
        store: true,
        tools: [
          { type: 'function', function: { name: 'apply_patch' } },
          { type: 'function', function: { name: 'exec_command' } }
        ]
      },
      context: {
        input: resumed2.payload.input
      }
    });

    recordResponsesResponse({
      requestId: track('req-resp-store-reopen-3'),
      response: {
        id: 'resp-reopen-3',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '继续第二个补丁' }]
          },
          {
            type: 'function_call',
            id: 'fc_patch_2',
            call_id: 'call_patch_2',
            name: 'apply_patch',
            arguments: JSON.stringify({ patch: patch2 }),
            status: 'in_progress'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_patch_2',
                type: 'function',
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patch2 })
              }
            ]
          }
        }
      }
    });

    const resumed3 = resumeResponsesConversation(
      'resp-reopen-3',
      {
        tool_outputs: [{ tool_call_id: 'call_patch_2', output: 'Patch applied successfully.' }],
        stream: false
      },
      { requestId: track('req-resp-store-reopen-4') }
    );

    expect(resumed3.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '开始修复' }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: '先打补丁' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_patch_1',
        name: 'apply_patch'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_patch_1',
        output: 'Patch applied successfully.'
      }),
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: '再跑命令确认' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_exec_1',
        name: 'exec_command'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_exec_1',
        output: '/Users/fanzhang/Documents/github/routecodex'
      }),
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: '继续第二个补丁' }]
      },
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_patch_2',
        name: 'apply_patch'
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_patch_2',
        output: 'Patch applied successfully.'
      })
    ]);

    const chatRequest = buildChatRequestFromResponses(
      {
        model: 'gpt-5.4',
        previous_response_id: 'resp-reopen-3',
        input: resumed3.payload.input,
        tools: [
          { type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: {} } },
          { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }
        ]
      },
      {
        requestId: 'req-resp-store-reopen-4',
        input: resumed3.payload.input as any,
        toolsNormalized: [
          { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: {} } } },
          { type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }
        ] as any
      } as any
    );
    const messages = (chatRequest as any)?.request?.messages;
    expect(findOpenAiChatToolOrderingViolation(messages)).toBeNull();
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
