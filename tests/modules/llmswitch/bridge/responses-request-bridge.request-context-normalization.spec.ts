import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCaptureReqInboundResponsesContextSnapshotJson = jest.fn();

jest.unstable_mockModule('../../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  materializeLatestResponsesContinuationByScope: jest.fn(),
  recordResponsesResponseForRequest: jest.fn(),
  resumeResponsesConversation: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  captureReqInboundResponsesContextSnapshotJson: mockCaptureReqInboundResponsesContextSnapshotJson,
  planResponsesHandlerEntry: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(),
}));

const { buildResponsesRequestContextForHttp } = await import(
  '../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts'
);

describe('responses-request-bridge relay request-context normalization', () => {
  beforeEach(() => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockReset();
  });

  it('RED: relay request context uses normalized native input instead of raw duplicate tool history', () => {
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

    const context = buildResponsesRequestContextForHttp({
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

  it('RED: relay request context does not fall back to raw input when native capture rejects orphan tool_result', () => {
    mockCaptureReqInboundResponsesContextSnapshotJson.mockImplementation(() => {
      throw new Error(
        'orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_JyD0R31sWoSfsvEtKsqHJkRh'
      );
    });

    expect(() =>
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
    ).toThrow(
      'orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_JyD0R31sWoSfsvEtKsqHJkRh'
    );
  });
});
