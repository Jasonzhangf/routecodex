import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  buildResponsesPipelineMetadataForHttpFake,
  buildResponsesResumeControlForContinuationContextForHttpFake,
  finalizeResponsesHandlerPayloadForHttpFake,
} from './responses-request-handler-host-fake.js';

const mockCaptureReqInboundResponsesContextSnapshotJson = jest.fn();
const mockPlanResponsesHandlerEntry = jest.fn();
const mockMaterializeProviderOwnedSubmitContext = jest.fn();
const mockPlanResponsesRequestContext = jest.fn();
const mockPlanResponsesContinuationRequestAction = jest.fn();
const mockPlanResponsesResumeErrorForHttpNative = jest.fn();
const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockMaterializeLatestResponsesContinuationByScope = jest.fn();
const mockResumeResponsesConversation = jest.fn();
const mockGetSystemPromptOverride = jest.fn(() => null);
const mockPlanResponsesRequestBodyForHttpNative = jest.fn((payload: Record<string, unknown>) => {
  const { metadata, ...pipelineBody } = payload;
  return {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { requestBodyMetadata: { ...(metadata as Record<string, unknown>) } }
      : {}),
    pipelineBody,
  };
});
const mockExtractSessionIdentifiersFromMetadataNative = jest.fn((metadata: Record<string, unknown> | undefined) => {
  const clientHeaders =
    metadata?.clientHeaders && typeof metadata.clientHeaders === 'object' && !Array.isArray(metadata.clientHeaders)
      ? (metadata.clientHeaders as Record<string, unknown>)
      : undefined;
  const pick = (values: unknown[]): string | undefined => {
    for (const value of values) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) {
        return trimmed;
      }
    }
    return undefined;
  };
  return {
    sessionId: pick([
      metadata?.sessionId,
      metadata?.session_id,
      clientHeaders?.session_id,
      clientHeaders?.sessionId,
      clientHeaders?.['session-id'],
      clientHeaders?.['x-session-id']
    ]),
    conversationId: pick([
      metadata?.conversationId,
      metadata?.conversation_id,
      clientHeaders?.conversation_id,
      clientHeaders?.conversationId,
      clientHeaders?.['conversation-id'],
      clientHeaders?.['x-conversation-id']
    ])
  };
});

jest.unstable_mockModule('../../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
  getSystemPromptOverride: mockGetSystemPromptOverride,
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest: jest.fn(),
  resumeResponsesConversation: mockResumeResponsesConversation,
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/responses-request-handler-host.js', () => ({
  captureReqInboundResponsesContextSnapshotJson: mockCaptureReqInboundResponsesContextSnapshotJson,
  extractSessionIdentifiersFromMetadataNative: mockExtractSessionIdentifiersFromMetadataNative,
  materializeProviderOwnedSubmitContext: mockMaterializeProviderOwnedSubmitContext,
  planResponsesRequestBodyForHttpNative: mockPlanResponsesRequestBodyForHttpNative,
  planResponsesRequestContext: mockPlanResponsesRequestContext,
  planResponsesContinuationRequestAction: mockPlanResponsesContinuationRequestAction,
  planResponsesHandlerEntry: mockPlanResponsesHandlerEntry,
  shouldManageResponsesConversationForHttpNative: jest.fn(
    (entryEndpoint?: string) =>
      entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs'
  ),
  buildResponsesScopeContinuationExpiredErrorForHttpNative: jest.fn(() => ({
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  })),
  planResponsesResumeErrorForHttpNative: mockPlanResponsesResumeErrorForHttpNative,
  planResponsesInboundToolHistoryErrorsampleForHttpNative: jest.fn(() => ({ action: 'none' })),
  buildResponsesResumeControlForContinuationContextForHttpNative: jest.fn(
    buildResponsesResumeControlForContinuationContextForHttpFake
  ),
  buildResponsesPipelineMetadataForHttpNative: jest.fn(buildResponsesPipelineMetadataForHttpFake),
  finalizeResponsesHandlerPayloadForHttpNative: jest.fn(finalizeResponsesHandlerPayloadForHttpFake),
  buildResponsesConversationPortScopeForHttpNative: jest.fn(() => ({})),
  planResponsesHandlerStreamForHttpNative: jest.fn((args: {
    payload?: Record<string, unknown>;
    forceStream?: boolean;
    acceptsSse: boolean;
    requestTimeoutMs?: number;
  }) => {
    const payload = args.payload ?? {};
    const hasExplicitStream = typeof payload.stream === 'boolean';
    const originalStream = payload.stream === true;
    const outboundStream = typeof args.forceStream === 'boolean'
      ? args.forceStream
      : (hasExplicitStream ? originalStream : args.acceptsSse);
    return {
      originalStream,
      outboundStream,
      inboundStream: outboundStream,
      acceptsSse: args.acceptsSse,
      requestStartMeta: {
        inboundStream: outboundStream,
        outboundStream,
        clientAcceptsSse: args.acceptsSse,
        originalStream,
        type: payload.type,
        timeoutMs: args.requestTimeoutMs,
      },
    };
  }),
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(),
}));

const {
  buildResponsesRequestContextForHttp,
  prepareResponsesHandlerEntryForHttp,
  prepareResponsesHandlerRuntimeForHttp,
  prepareResponsesRequestBodyForHttp
} = await import(
  '../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts'
);

describe('responses-request-bridge relay request-context normalization', () => {
  beforeEach(() => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReset();
    mockPlanResponsesHandlerEntry.mockReset();
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      payload: undefined,
      mode: 'none',
      responseId: undefined
    });
    mockMaterializeProviderOwnedSubmitContext.mockReset();
    mockPlanResponsesRequestContext.mockReset();
    mockPlanResponsesRequestContext.mockImplementation(({ payload }) => {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const { metadata: _metadata, ...withoutMetadata } = payload as Record<string, unknown>;
        return { kind: 'capture_request', payload: withoutMetadata };
      }
      return { kind: 'capture_request', payload };
    });
    mockPlanResponsesContinuationRequestAction.mockReset();
    mockPlanResponsesResumeErrorForHttpNative.mockReset();
    mockPlanResponsesResumeErrorForHttpNative.mockReturnValue({ action: 'rethrow' });
    mockPlanResponsesContinuationRequestAction.mockImplementation(async (input: {
      plannedEntry?: {
        mode?: 'none' | 'submit_tool_outputs' | 'scope_materialize';
        payload?: Record<string, unknown>;
      };
    }) => ({
      action: 'complete',
      result: {
        kind: 'ok',
        payload: input.plannedEntry?.payload ?? {},
        pipelineEntryEndpoint: '/v1/responses',
        plannedEntryMode: input.plannedEntry?.mode ?? 'none',
        isSubmitToolOutputs: input.plannedEntry?.mode === 'submit_tool_outputs',
      },
    }));
    mockLookupResponsesContinuationByResponseId.mockReset();
    mockMaterializeLatestResponsesContinuationByScope.mockReset();
    mockResumeResponsesConversation.mockReset();
    mockGetSystemPromptOverride.mockReset();
    mockGetSystemPromptOverride.mockReturnValue(null);
  });

  it('RED: relay request context uses normalized native input instead of raw duplicate tool history', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [
        {
          type: 'function_call',
          call_id: 'call_dup',
          name: 'exec_command',
          arguments: '{"cmd":"cat skill.md"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_dup',
          output: 'Chunk ID: once',
        },
      ],
      toolsRaw: [{ type: 'function', function: { name: 'exec_command' } }],
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call',
            call_id: 'call_dup',
            name: 'exec_command',
            arguments: '{"cmd":"cat skill.md"}',
          },
          {
            type: 'function_call',
            call_id: 'call_dup',
            name: 'exec_command',
            arguments: '{"cmd":"cat skill.md"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'Chunk ID: once',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'Chunk ID: once',
          },
        ],
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
      },
      requestId: 'req_relay_context_normalized_1',
      metadata: { session_id: 'sess_1', conversation_id: 'conv_1' },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(mockCaptureReqInboundResponsesContextSnapshotJson).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_relay_context_normalized_1',
      }),
    );
    expect(context.context.input).toEqual([
      expect.objectContaining({ type: 'function_call', call_id: 'call_dup' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_dup' }),
    ]);
    expect(context.context.input).toHaveLength(2);
  });

  it('RED: relay request context keeps only the latest output when an identical tool-call batch repeats', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [
        {
          type: 'function_call',
          call_id: 'call_dup',
          name: 'exec_command',
          arguments: '{"cmd":"cat skill.md"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_dup',
          output: 'write_stdin failed: Unknown process id 1',
        },
      ],
      toolsRaw: [{ type: 'function', function: { name: 'exec_command' } }],
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            type: 'function_call',
            call_id: 'call_dup',
            name: 'exec_command',
            arguments: '{"cmd":"cat skill.md"}',
          },
          {
            type: 'function_call',
            call_id: 'call_dup',
            name: 'exec_command',
            arguments: '{"cmd":"cat skill.md"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'Chunk ID: once',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'write_stdin failed: Unknown process id 1',
          },
        ],
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
      },
      requestId: 'req_relay_context_normalized_2',
      metadata: { session_id: 'sess_2', conversation_id: 'conv_2' },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(context.context.input).toEqual([
      expect.objectContaining({ type: 'function_call', call_id: 'call_dup' }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_dup',
        output: 'write_stdin failed: Unknown process id 1',
      }),
    ]);
    expect(context.context.input).toHaveLength(2);
  });

  it('RED: relay request context does not fall back to raw input when native capture rejects orphan tool_result', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockImplementation(() => {
      throw new Error(
        'orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_JyD0R31sWoSfsvEtKsqHJkRh'
      );
    });

    await expect(
      buildResponsesRequestContextForHttp({
        payload: {
          model: 'gpt-5.4',
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_JyD0R31sWoSfsvEtKsqHJkRh',
              output: 'late tool result',
            },
          ],
        },
        requestId: 'req_relay_context_orphan_1',
      })
    ).rejects.toThrow(
      'orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_JyD0R31sWoSfsvEtKsqHJkRh'
    );
  });

  it('treats provider-owned submit_tool_outputs resume payload as context-free request state', async () => {
    mockPlanResponsesRequestContext.mockReturnValueOnce({
      kind: 'context',
      payload: {
        response_id: 'resp_submit_direct_1',
        previous_response_id: 'resp_submit_direct_1',
        tool_outputs: [
          {
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ],
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ]
      },
      context: {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ]
      }
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        response_id: 'resp_submit_direct_1',
        tool_outputs: [
          {
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ],
        metadata: {
          toolCallIdStyle: 'openai'
        }
      },
      requestId: 'req_submit_direct_context_free_1',
      metadata: {
        session_id: 'sess_submit_direct_1',
        conversation_id: 'conv_submit_direct_1'
      },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(mockCaptureReqInboundResponsesContextSnapshotJson).not.toHaveBeenCalled();
    expect(mockMaterializeProviderOwnedSubmitContext).not.toHaveBeenCalled();
    expect(mockPlanResponsesRequestContext).toHaveBeenCalledWith({
      payload: {
        response_id: 'resp_submit_direct_1',
        tool_outputs: [
          {
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ],
        metadata: {
          toolCallIdStyle: 'openai'
        }
      }
    });
    expect(context).toEqual({
      payload: {
        response_id: 'resp_submit_direct_1',
        previous_response_id: 'resp_submit_direct_1',
        tool_outputs: [
          {
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ],
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ]
      },
      context: {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ]
      },
      sessionId: 'sess_submit_direct_1',
      conversationId: 'conv_submit_direct_1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });

  it('routes direct submit_tool_outputs through native continuation action plan', async () => {
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      mode: 'submit_tool_outputs',
      responseId: 'resp_direct_plan_1',
      payload: {
        response_id: 'resp_direct_plan_1',
        tool_outputs: [{ call_id: 'call_direct_plan_1', output: 'ok' }]
      }
    });
    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      continuationOwner: 'direct',
      providerKey: 'provider.key1',
      requestId: 'req_prev_direct_1'
    });
    mockPlanResponsesContinuationRequestAction
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'lookup_continuation',
          args: {
            responseId: 'resp_direct_plan_1',
            options: {
              entryKind: 'responses',
              matchedPort: 5555,
              routingPolicyGroup: 'gateway_priority_5555',
            },
          },
        },
        resultPlanInput: { stage: 'lookup_continuation' },
      })
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'materialize_provider_owned_submit',
          args: {
            payload: {
              response_id: 'resp_direct_plan_1',
              previous_response_id: 'resp_direct_plan_1',
              tool_outputs: [{ call_id: 'call_direct_plan_1', output: 'ok' }],
            },
          },
        },
        resultPlanInput: { stage: 'materialize_provider_owned_submit' },
      })
      .mockResolvedValueOnce({
        action: 'complete',
        result: {
          kind: 'ok',
          payload: {
            response_id: 'resp_direct_plan_1',
            previous_response_id: 'resp_direct_plan_1',
            tool_outputs: [{ call_id: 'call_direct_plan_1', output: 'ok' }],
            input: [{ type: 'function_call_output', call_id: 'call_direct_plan_1', output: 'ok' }],
          },
          pipelineEntryEndpoint: '/v1/responses.submit_tool_outputs',
          plannedEntryMode: 'submit_tool_outputs',
          isSubmitToolOutputs: true,
          resumeMeta: {
            responseId: 'resp_direct_plan_1',
            restored: false,
            continuationOwner: 'direct',
            providerKey: 'provider.key1',
            previousRequestId: 'req_prev_direct_1',
          },
        },
      });
    mockMaterializeProviderOwnedSubmitContext.mockResolvedValue({
      payload: {
        response_id: 'resp_direct_plan_1',
        previous_response_id: 'resp_direct_plan_1',
        tool_outputs: [{ call_id: 'call_direct_plan_1', output: 'ok' }],
        input: [{ type: 'function_call_output', call_id: 'call_direct_plan_1', output: 'ok' }]
      },
      context: {
        input: [{ type: 'function_call_output', call_id: 'call_direct_plan_1', output: 'ok' }]
      }
    });

    const prepared = await prepareResponsesHandlerEntryForHttp({
      payload: { response_id: 'resp_direct_plan_1', tool_outputs: [] },
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      requestId: 'req_direct_plan_1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });

    expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
      'resp_direct_plan_1',
      {
        entryKind: 'responses',
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555',
      }
    );
    expect(mockPlanResponsesContinuationRequestAction).toHaveBeenCalledWith(
      expect.objectContaining({
        effectResult: expect.objectContaining({
          operation: 'lookup_continuation',
          result: expect.objectContaining({ continuationOwner: 'direct' }),
        })
      })
    );
    expect(mockResumeResponsesConversation).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      kind: 'ok',
      pipelineEntryEndpoint: '/v1/responses.submit_tool_outputs',
      resumeMeta: {
        continuationOwner: 'direct',
        providerKey: 'provider.key1'
      }
    });
  });

  it('routes relay submit_tool_outputs through native continuation action plan', async () => {
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      mode: 'submit_tool_outputs',
      responseId: 'resp_relay_plan_1',
      payload: {
        response_id: 'resp_relay_plan_1',
        tool_outputs: [{ call_id: 'call_relay_plan_1', output: 'ok' }]
      }
    });
    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      continuationOwner: 'relay',
      requestId: 'req_prev_relay_1'
    });
    mockPlanResponsesContinuationRequestAction
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'lookup_continuation',
          args: {
            responseId: 'resp_relay_plan_1',
            options: {
              entryKind: 'responses',
              matchedPort: 5555,
              routingPolicyGroup: 'gateway_priority_5555',
            },
          },
        },
        resultPlanInput: { stage: 'lookup_continuation' },
      })
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'resume_relay',
          args: {
            responseId: 'resp_relay_plan_1',
            payload: {
              response_id: 'resp_relay_plan_1',
              tool_outputs: [{ call_id: 'call_relay_plan_1', output: 'ok' }],
            },
            options: {
              requestId: 'req_relay_plan_1',
              entryKind: 'responses',
              matchedPort: 5555,
              routingPolicyGroup: 'gateway_priority_5555',
            },
          },
        },
        resultPlanInput: { stage: 'resume_relay' },
      })
      .mockResolvedValueOnce({
        action: 'complete',
        result: {
          kind: 'ok',
          payload: {
            previous_response_id: 'resp_relay_plan_1',
            input: [{ type: 'function_call_output', call_id: 'call_relay_plan_1', output: 'ok' }],
          },
          pipelineEntryEndpoint: '/v1/responses',
          plannedEntryMode: 'submit_tool_outputs',
          isSubmitToolOutputs: true,
          resumeMeta: {
            restored: true,
            continuationOwner: 'relay',
          },
        },
      });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        previous_response_id: 'resp_relay_plan_1',
        input: [{ type: 'function_call_output', call_id: 'call_relay_plan_1', output: 'ok' }]
      },
      meta: {
        restored: true,
        continuationOwner: 'relay'
      }
    });

    const prepared = await prepareResponsesHandlerEntryForHttp({
      payload: { response_id: 'resp_relay_plan_1', tool_outputs: [] },
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      requestId: 'req_relay_plan_1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });

    expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
      'resp_relay_plan_1',
      {
        entryKind: 'responses',
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555',
      }
    );
    expect(mockResumeResponsesConversation).toHaveBeenCalledWith(
      'resp_relay_plan_1',
      expect.objectContaining({ response_id: 'resp_relay_plan_1' }),
      expect.objectContaining({ entryKind: 'responses', matchedPort: 5555 })
    );
    expect(prepared).toMatchObject({
      kind: 'ok',
      pipelineEntryEndpoint: '/v1/responses',
      resumeMeta: {
        restored: true,
        continuationOwner: 'relay'
      }
    });
  });

  it('routes scope materialize through native continuation action plan', async () => {
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      mode: 'scope_materialize',
      responseId: undefined,
      payload: {
        previous_response_id: 'resp_scope_plan_1',
        input: [{ type: 'function_call_output', call_id: 'call_scope_plan_1', output: 'ok' }]
      }
    });
    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      continuationOwner: 'relay',
      requestId: 'req_prev_scope_1'
    });
    mockPlanResponsesContinuationRequestAction
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'lookup_continuation',
          args: {
            responseId: 'resp_scope_plan_1',
            options: {
              entryKind: 'responses',
              matchedPort: 5555,
              routingPolicyGroup: 'gateway_priority_5555',
            },
          },
        },
        resultPlanInput: { stage: 'lookup_continuation' },
      })
      .mockResolvedValueOnce({
        action: 'execute_effect',
        effect: {
          operation: 'materialize_scope',
          args: {
            payload: {
              previous_response_id: 'resp_scope_plan_1',
              input: [{ type: 'function_call_output', call_id: 'call_scope_plan_1', output: 'ok' }],
            },
            requestId: 'req_scope_plan_1',
            sessionId: 'sess_scope_plan_1',
            conversationId: 'conv_scope_plan_1',
            entryKind: 'responses',
            continuationOwner: 'relay',
            matchedPort: 5555,
            routingPolicyGroup: 'gateway_priority_5555',
          },
        },
        resultPlanInput: { stage: 'materialize_scope' },
      })
      .mockResolvedValueOnce({
        action: 'complete',
        result: {
          kind: 'ok',
          payload: {
            previous_response_id: 'resp_scope_plan_1',
            input: [{ type: 'function_call_output', call_id: 'call_scope_plan_1', output: 'ok' }],
          },
          pipelineEntryEndpoint: '/v1/responses',
          plannedEntryMode: 'scope_materialize',
          isSubmitToolOutputs: false,
          resumeMeta: {
            materialized: true,
            continuationOwner: 'relay',
          },
        },
      });
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValue({
      payload: {
        previous_response_id: 'resp_scope_plan_1',
        input: [{ type: 'function_call_output', call_id: 'call_scope_plan_1', output: 'ok' }]
      },
      meta: {
        materialized: true,
        continuationOwner: 'relay'
      }
    });

    const prepared = await prepareResponsesHandlerEntryForHttp({
      payload: { previous_response_id: 'resp_scope_plan_1', input: [] },
      entryEndpoint: '/v1/responses',
      requestId: 'req_scope_plan_1',
      sessionId: 'sess_scope_plan_1',
      conversationId: 'conv_scope_plan_1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });

    expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
      'resp_scope_plan_1',
      {
        entryKind: 'responses',
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555',
      }
    );
    expect(mockMaterializeLatestResponsesContinuationByScope).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationOwner: 'relay',
        sessionId: 'sess_scope_plan_1',
        conversationId: 'conv_scope_plan_1'
      })
    );
    expect(prepared).toMatchObject({
      kind: 'ok',
      pipelineEntryEndpoint: '/v1/responses',
      resumeMeta: {
        materialized: true,
        continuationOwner: 'relay'
      }
    });
  });

  it('normalizes relay fullInput stopless history into provider-facing reasoningStop pair', async () => {
    const fullInput = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续执行 stopless 测试' }],
      },
      {
        type: 'function_call',
        id: 'fc_stopless_resume_1',
        call_id: 'call_stopless_resume_1',
        name: 'exec_command',
        arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}',
      },
      {
        type: 'function_call_output',
        id: 'fc_stopless_resume_1',
        call_id: 'call_stopless_resume_1',
        output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
      },
      {
        type: 'function_call',
        id: 'fc_stopless_resume_2',
        call_id: 'call_stopless_resume_2',
        name: 'exec_command',
        arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}',
      },
      {
        type: 'function_call_output',
        id: 'fc_stopless_resume_2',
        call_id: 'call_stopless_resume_2',
        output: '',
      },
    ];
    const restoredTools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }];
    mockPlanResponsesRequestContext.mockReturnValueOnce({
      kind: 'capture_request',
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_stopless_resume_1',
        input: fullInput,
        tools: restoredTools,
      }
    });
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行 stopless 测试' }],
        },
        {
          type: 'function_call',
          id: 'fc_stopless_resume_1',
          call_id: 'call_stopless_resume_1',
          name: 'reasoningStop',
          arguments: '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}',
        },
        {
          type: 'function_call_output',
          id: 'fc_stopless_resume_1',
          call_id: 'call_stopless_resume_1',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
        },
      ],
      toolsRaw: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'reasoningStop', parameters: { type: 'object', properties: {} } }
      ],
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_stopless_resume_1',
        input: [
          {
            type: 'function_call',
            call_id: 'call_stopless_resume_2',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":2,\\\\\\"maxRepeats\\\\\\":3}\\""}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_stopless_resume_2',
          },
        ],
      },
      requestId: 'req_stopless_resume_context_1',
      metadata: {
        session_id: 'sess_stopless_resume_1',
        conversation_id: 'conv_stopless_resume_1',
      },
      resumeMeta: {
        continuationOwner: 'relay',
        fullInput,
        restoredTools,
      },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(mockCaptureReqInboundResponsesContextSnapshotJson).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_stopless_resume_context_1',
        rawRequest: expect.objectContaining({
          previous_response_id: 'resp_stopless_resume_1',
          tools: [
            { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }
          ],
          input: expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call',
              call_id: 'call_stopless_resume_1',
              name: 'exec_command',
            }),
          ]),
        }),
      }),
    );
    expect(context.context.input).toHaveLength(3);
    expect(context.context.input[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_stopless_resume_1',
      name: 'reasoningStop',
    });
    expect(context.context.input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_stopless_resume_1',
      output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
    });
    expect(context.payload.input).toEqual(context.context.input);
    expect(context.payload.tools).toEqual([
      { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'reasoningStop', parameters: { type: 'object', properties: {} } }
    ]);
  });

  it('persists normalized stopless payload instead of raw exec_command and tool message shape', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '继续处理' }],
        },
        {
          type: 'function_call',
          id: 'fc_live_stopless_1',
          call_id: 'call_live_stopless_1',
          name: 'reasoningStop',
          arguments: '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}',
        },
        {
          type: 'function_call_output',
          id: 'fc_live_stopless_1',
          call_id: 'call_live_stopless_1',
          output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续' }],
        },
      ],
      toolsRaw: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'reasoningStop', parameters: { type: 'object', properties: {} } }
      ],
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.4',
        input: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_live_stopless_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{\\\\\\"flowId\\\\\\":\\\\\\"stop_message_flow\\\\\\",\\\\\\"repeatCount\\\\\\":1,\\\\\\"maxRepeats\\\\\\":3}\\""}',
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_live_stopless_1',
            name: 'reasoningStop',
            content: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
          },
          {
            role: 'user',
            content: '继续',
          },
        ],
      },
      requestId: 'req_live_stopless_payload_normalized_1',
      metadata: {
        session_id: 'sess_live_stopless_1',
        conversation_id: 'conv_live_stopless_1',
      },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(context.context.input[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_live_stopless_1',
      name: 'reasoningStop',
    });
    expect(context.context.input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_live_stopless_1',
      output: '{"ok":true,"toolName":"stop_message_auto","repeatCount":2,"maxRepeats":3}',
    });
    expect(context.payload.input).toEqual(context.context.input);
    expect(JSON.stringify(context.payload.input)).not.toContain('"role":"tool"');
    expect(JSON.stringify(context.payload.input)).not.toContain('"name":"exec_command"');
  });

  it('materializes request context session truth from factual Codex client headers', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [],
      toolsRaw: []
    });

    const prepared = await prepareResponsesHandlerRuntimeForHttp({
      payload: {
        model: 'gpt-5.4',
        input: []
      },
      entryEndpoint: '/v1/responses',
      requestId: 'req_codex_header_session_1',
      requestMetadata: {
        clientHeaders: {
          'user-agent': 'codex-tui/0.128.0',
          originator: 'codex-tui',
          session_id: 'sess_codex_header_1',
          conversation_id: 'conv_codex_header_1'
        }
      },
      acceptsSse: true
    });

    expect(prepared.kind).toBe('ok');
    if (prepared.kind !== 'ok') {
      throw new Error(`expected ok, got ${prepared.kind}`);
    }
    expect(prepared.requestContext.sessionId).toBe('sess_codex_header_1');
    expect(prepared.requestContext.conversationId).toBe('conv_codex_header_1');
  });

  it('passes host-read system prompt override into native responses payload finalization', async () => {
    mockGetSystemPromptOverride.mockReturnValue({
      source: 'codex',
      prompt: 'SYSTEM OVERRIDE',
    });
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      payload: {
        model: 'gpt-5.4',
        instructions: 'Keep this.',
        input: [],
      },
      mode: 'none',
      responseId: undefined
    });
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [],
      toolsRaw: []
    });

    const prepared = await prepareResponsesHandlerRuntimeForHttp({
      payload: {
        model: 'gpt-5.4',
        instructions: 'Keep this.',
        input: []
      },
      entryEndpoint: '/v1/responses',
      requestId: 'req_system_prompt_native_finalize_1',
      requestMetadata: {},
      acceptsSse: false
    });

    expect(prepared.kind).toBe('ok');
    if (prepared.kind !== 'ok') {
      throw new Error(`expected ok, got ${prepared.kind}`);
    }
    expect(prepared.payload.instructions).toBe('SYSTEM OVERRIDE\n\nKeep this.');
  });

  it('returns the exact Rust-planned client resume error descriptor', async () => {
    const thrown = Object.assign(new Error('client resume failed'), {
      origin: 'client',
      status: 409,
      code: 'resume_conflict',
    });
    mockPlanResponsesHandlerEntry.mockRejectedValue(thrown);
    mockPlanResponsesResumeErrorForHttpNative.mockReturnValue({
      action: 'client_error',
      status: 409,
      body: {
        error: {
          message: 'client resume failed',
          type: 'invalid_request_error',
          code: 'resume_conflict',
          origin: 'client',
        },
      },
    });

    await expect(prepareResponsesHandlerRuntimeForHttp({
      payload: { model: 'gpt-5.4', input: [] },
      entryEndpoint: '/v1/responses',
      requestId: 'req_client_resume_error_1',
      requestMetadata: {},
      acceptsSse: false,
    })).resolves.toMatchObject({
      kind: 'client_error',
      status: 409,
      body: {
        error: {
          message: 'client resume failed',
          type: 'invalid_request_error',
          code: 'resume_conflict',
          origin: 'client',
        },
      },
    });
    expect(mockPlanResponsesResumeErrorForHttpNative).toHaveBeenCalledWith({
      name: 'Error',
      message: 'client resume failed',
      status: 409,
      code: 'resume_conflict',
      origin: 'client',
      details: undefined,
    });
  });

  it('rethrows the original non-client resume error from the Rust plan', async () => {
    const thrown = Object.assign(new Error('provider resume failed'), {
      origin: 'provider',
      status: 503,
    });
    mockPlanResponsesHandlerEntry.mockRejectedValue(thrown);
    mockPlanResponsesResumeErrorForHttpNative.mockReturnValue({ action: 'rethrow' });

    await expect(prepareResponsesHandlerRuntimeForHttp({
      payload: { model: 'gpt-5.4', input: [] },
      entryEndpoint: '/v1/responses',
      requestId: 'req_provider_resume_error_1',
      requestMetadata: {},
      acceptsSse: false,
    })).rejects.toBe(thrown);
  });

  it('materializes request context session truth from request body metadata inside the bridge', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [],
      toolsRaw: []
    });

    const prepared = await prepareResponsesHandlerRuntimeForHttp({
      payload: {
        model: 'gpt-5.4',
        metadata: {
          session_id: 'sess_body_bridge_1',
          conversation_id: 'conv_body_bridge_1'
        },
        input: []
      },
      entryEndpoint: '/v1/responses',
      requestId: 'req_body_metadata_bridge_1',
      requestMetadata: {},
      acceptsSse: true
    });

    expect(prepared.kind).toBe('ok');
    if (prepared.kind !== 'ok') {
      throw new Error(`expected ok, got ${prepared.kind}`);
    }
    expect(prepared.requestBodyMetadata).toMatchObject({
      session_id: 'sess_body_bridge_1',
      conversation_id: 'conv_body_bridge_1'
    });
    expect(prepared.requestContext.sessionId).toBe('sess_body_bridge_1');
    expect(prepared.requestContext.conversationId).toBe('conv_body_bridge_1');
    expect(prepared.payload.metadata).toBeUndefined();
  });

  it('strips request body metadata before persisting relay request context payload', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [],
      toolsRaw: []
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.4',
        metadata: { userAgent: 'persisted-context-must-not-leak' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      },
      requestId: 'req_relay_context_strip_metadata_1',
      metadata: { session_id: 'sess_strip_1', conversation_id: 'conv_strip_1' },
    });

    expect(context.payload.metadata).toBeUndefined();
    expect(JSON.stringify(context.payload)).not.toContain('persisted-context-must-not-leak');
  });

  it('keeps relay request context toolsRaw as an empty array when no tools are captured', async () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReturnValue({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });

    const context = await buildResponsesRequestContextForHttp({
      payload: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'hi' }],
      },
      requestId: 'req_relay_context_without_tools_1',
      metadata: { session_id: 'sess_no_tools_1', conversation_id: 'conv_no_tools_1' },
    });

    expect(context.context.toolsRaw).toEqual([]);
    expect(context.payload.tools).toBeUndefined();
  });

  it('does not materialize stopless runtime control into instructions at request bridge stage', () => {
    const payload: Record<string, unknown> = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行当前任务' }]
        }
      ]
    };
    const runtimeMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(runtimeMetadata);
    center.writeRuntimeControl(
      'stopless',
      {
        sessionId: 'sess-stopless-1',
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'stop_schema_missing',
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason', 'reason']
        },
        active: true,
        updatedAt: 123
      },
      {
        module: 'tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts',
        symbol: 'materializes stopless metadata-center runtime control into responses instructions from side-channel metadata',
        stage: 'test'
      }
    );

    const prepared = prepareResponsesRequestBodyForHttp(payload, runtimeMetadata);
    expect(prepared.pipelineBody.instructions).toBeUndefined();
  });

  it('does not read stopless runtime control from request payload metadata', () => {
    const payload: Record<string, unknown> = {
      model: 'gpt-5.4',
      metadata: {},
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行当前任务' }]
        }
      ]
    };
    const center = MetadataCenter.attach(payload.metadata as Record<string, unknown>);
    center.writeRuntimeControl(
      'stopless',
      {
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: 'must-not-materialize-from-payload-metadata',
        active: true
      },
      {
        module: 'tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts',
        symbol: 'does not read stopless runtime control from request payload metadata',
        stage: 'test'
      }
    );

    const prepared = prepareResponsesRequestBodyForHttp(payload);
    expect(prepared.pipelineBody.instructions).toBeUndefined();
    expect(prepared.pipelineBody.metadata).toBeUndefined();
  });
});
