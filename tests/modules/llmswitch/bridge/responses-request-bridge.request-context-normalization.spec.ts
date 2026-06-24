import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockCaptureReqInboundResponsesContextSnapshot = jest.fn();
const mockPlanResponsesHandlerEntry = jest.fn();

jest.unstable_mockModule('../../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  lookupResponsesContinuationByResponseId: jest.fn(),
  materializeLatestResponsesContinuationByScope: jest.fn(),
  recordResponsesResponseForRequest: jest.fn(),
  resumeResponsesConversation: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  captureReqInboundResponsesContextSnapshot: mockCaptureReqInboundResponsesContextSnapshot,
  planResponsesHandlerEntry: mockPlanResponsesHandlerEntry,
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(),
}));

const {
  buildResponsesRequestContextForHttp,
  prepareResponsesHandlerRuntimeForHttp,
  prepareResponsesRequestBodyForHttp
} = await import(
  '../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts'
);

describe('responses-request-bridge relay request-context normalization', () => {
  beforeEach(() => {
    mockCaptureReqInboundResponsesContextSnapshot.mockReset();
    mockPlanResponsesHandlerEntry.mockReset();
    mockPlanResponsesHandlerEntry.mockResolvedValue({
      payload: undefined,
      mode: 'none',
      responseId: undefined
    });
  });

  it('RED: relay request context uses normalized native input instead of raw duplicate tool history', async () => {
    mockCaptureReqInboundResponsesContextSnapshot.mockResolvedValue({
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

    expect(mockCaptureReqInboundResponsesContextSnapshot).toHaveBeenCalledWith(
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
    mockCaptureReqInboundResponsesContextSnapshot.mockResolvedValue({
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
    mockCaptureReqInboundResponsesContextSnapshot.mockRejectedValue(
      new Error(
        'orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_JyD0R31sWoSfsvEtKsqHJkRh'
      )
    );

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

    expect(mockCaptureReqInboundResponsesContextSnapshot).not.toHaveBeenCalled();
    expect(context).toEqual({
      payload: {
        response_id: 'resp_submit_direct_1',
        tool_outputs: [
          {
            call_id: 'call_submit_direct_1',
            output: '{"ok":true}'
          }
        ]
      },
      context: {
        input: []
      },
      sessionId: 'sess_submit_direct_1',
      conversationId: 'conv_submit_direct_1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });

  it('normalizes relay fullInput stopless history into provider-facing reasoningStop pair', async () => {
    mockCaptureReqInboundResponsesContextSnapshot.mockResolvedValue({
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
        fullInput: [
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
        ],
        restoredTools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(mockCaptureReqInboundResponsesContextSnapshot).toHaveBeenCalledWith(
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

  it('materializes request context session truth from factual Codex client headers', async () => {
    mockCaptureReqInboundResponsesContextSnapshot.mockResolvedValue({
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

  it('strips request body metadata before persisting relay request context payload', async () => {
    mockCaptureReqInboundResponsesContextSnapshot.mockResolvedValue({
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
