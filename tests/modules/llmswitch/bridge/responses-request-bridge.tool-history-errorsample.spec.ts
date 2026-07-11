import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockWriteErrorsampleJson = jest.fn(async () => '/tmp/errorsample.json');

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
  captureReqInboundResponsesContextSnapshot: jest.fn(),
  captureReqInboundResponsesContextSnapshotJson: jest.fn(),
  extractSessionIdentifiersFromMetadataNative: jest.fn(() => ({})),
  materializeProviderOwnedSubmitContext: jest.fn(),
  planResponsesRequestBodyForHttpNative: jest.fn((payload: Record<string, unknown>) => ({ pipelineBody: payload })),
  planResponsesRequestContext: jest.fn(),
  planResponsesContinuationRequestAction: jest.fn(),
  planResponsesHandlerEntry: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: mockWriteErrorsampleJson,
}));

const { captureResponsesInboundToolHistoryErrorsampleForHttp } = await import(
  '../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts'
);

describe('responses-request-bridge inbound tool-history errorsample facade', () => {
  beforeEach(() => {
    mockWriteErrorsampleJson.mockClear();
  });

  it('RED: writes payload-contract-error errorsample for Responses tool-history contract violations', async () => {
    await captureResponsesInboundToolHistoryErrorsampleForHttp({
      requestId: 'req_tool_history_bridge_1',
      entryEndpoint: '/v1/responses',
      body: {
        previous_response_id: 'resp_tool_history_bridge_1',
        tool_outputs: [{ call_id: 'call_tool_history_bridge_1', output: 'ok' }],
      },
      error: Object.assign(new Error('Tool history contract violated: tool_result must reference an open tool call'), {
        code: 'MALFORMED_REQUEST',
      }),
    });

    expect(mockWriteErrorsampleJson).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'payload-contract-error',
        kind: 'responses.inbound_tool_history_contract',
        payload: expect.objectContaining({
          requestId: 'req_tool_history_bridge_1',
          entryEndpoint: '/v1/responses',
          body: expect.objectContaining({
            previous_response_id: 'resp_tool_history_bridge_1',
          }),
          error: expect.objectContaining({
            code: 'MALFORMED_REQUEST',
          }),
        }),
      }),
    );
  });

  it('RED: does not write tool-history errorsample for unrelated malformed requests', async () => {
    await captureResponsesInboundToolHistoryErrorsampleForHttp({
      requestId: 'req_tool_history_bridge_2',
      entryEndpoint: '/v1/responses',
      body: {
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      error: Object.assign(new Error('model is required'), {
        code: 'MALFORMED_REQUEST',
        details: {},
      }),
    });

    expect(mockWriteErrorsampleJson).not.toHaveBeenCalled();
  });
});
