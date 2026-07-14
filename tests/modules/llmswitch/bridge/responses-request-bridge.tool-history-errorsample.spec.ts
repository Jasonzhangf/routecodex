import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  buildResponsesPipelineMetadataForHttpFake,
  buildResponsesResumeControlForContinuationContextForHttpFake,
  finalizeResponsesHandlerPayloadForHttpFake,
} from './responses-request-handler-host-fake.js';

const mockWriteErrorsampleJson = jest.fn(async () => '/tmp/errorsample.json');

jest.unstable_mockModule('../../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
  getSystemPromptOverride: jest.fn(() => null),
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

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/responses-request-handler-host.js', () => ({
  captureReqInboundResponsesContextSnapshotJson: jest.fn(),
  extractSessionIdentifiersFromMetadataNative: jest.fn(() => ({})),
  materializeProviderOwnedSubmitContext: jest.fn(),
  planResponsesRequestBodyForHttpNative: jest.fn((payload: Record<string, unknown>) => ({ pipelineBody: payload })),
  planResponsesRequestContext: jest.fn(),
  planResponsesContinuationRequestAction: jest.fn(),
  planResponsesHandlerEntry: jest.fn(),
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
  planResponsesResumeErrorForHttpNative: jest.fn(() => ({ action: 'rethrow' })),
  planResponsesInboundToolHistoryErrorsampleForHttpNative: jest.fn((input: {
    requestId: string;
    entryEndpoint: string;
    body: unknown;
    error: Record<string, unknown>;
  }) => {
    if (
      input.error?.code !== 'MALFORMED_REQUEST'
      || (
        typeof input.error?.message === 'string'
          && !input.error.message.includes('Tool history contract violated')
          && !(input.error.details as Record<string, unknown> | undefined)?.toolHistoryContractViolation
      )
    ) {
      return { action: 'none' };
    }
    return {
      action: 'write_errorsample',
      write: {
        group: 'payload-contract-error',
        kind: 'responses.inbound_tool_history_contract',
        payload: {
          kind: 'responses.inbound_tool_history_contract',
          requestId: input.requestId,
          entryEndpoint: input.entryEndpoint,
          body: input.body,
          error: input.error,
        },
      },
    };
  }),
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
