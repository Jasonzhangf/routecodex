import { describe, expect, it, jest } from '@jest/globals';

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
  planResponsesHandlerEntry: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(),
}));

const {
  buildResponsesPipelineMetadataForHttp,
  attachResponsesRequestContextToResultForHttp
} = await import('../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts');
const { MetadataCenter } = await import(
  '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
);

describe('responses-request-bridge metadata center projection', () => {
  it('writes request-side responses continuation context into metadata center', () => {
    const requestContext = {
      payload: { model: 'gpt-5.4', input: [] },
      context: { input: [] },
      sessionId: 'sess-resp-1',
      conversationId: 'conv-resp-1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };
    const resumeMeta = {
      responseId: 'resp_1',
      continuationOwner: 'relay'
    };

    const metadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: {
        originalStream: true,
        outboundStream: true,
        inboundStream: true,
        acceptsSse: true,
        requestStartMeta: {}
      },
      clientRequestId: 'client-req-1',
      requestContext,
      resumeMeta
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readContinuationContext()).toMatchObject({
      responsesRequestContext: requestContext,
      responsesResume: resumeMeta
    });
    expect(center?.readRequestTruth().sessionId).toBeUndefined();
  });

  it('writes response-side responsesRequestContext attachment into metadata center', () => {
    const requestContext = {
      payload: { model: 'gpt-5.4', input: [] },
      context: { input: [] },
      sessionId: 'sess-resp-2',
      conversationId: 'conv-resp-2'
    };

    const nextMetadata = attachResponsesRequestContextToResultForHttp({
      entryEndpoint: '/v1/responses',
      resultMetadata: {},
      requestContext
    });

    expect(nextMetadata?.responsesRequestContext).toBe(requestContext);
    const center = MetadataCenter.read(nextMetadata);
    expect(center?.readContinuationContext().responsesRequestContext).toBe(requestContext);
    expect(center?.readRequestTruth().sessionId).toBeUndefined();
  });
});
