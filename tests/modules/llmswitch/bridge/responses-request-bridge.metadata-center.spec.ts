import { beforeAll, describe, expect, it, jest } from '@jest/globals';

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

let buildResponsesPipelineMetadataForHttp: any;
let attachResponsesRequestContextToResultForHttp: any;
let MetadataCenter: any;
let readRuntimeControlProjection: any;

beforeAll(async () => {
  ({
    buildResponsesPipelineMetadataForHttp,
    attachResponsesRequestContextToResultForHttp
  } = await import('../../../../src/modules/llmswitch/bridge/responses-request-bridge.ts'));
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({ readRuntimeControlProjection } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.ts'
  ));
});

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
    expect(center?.readRuntimeControl()).toMatchObject({
      streamIntent: 'stream',
      clientAbort: false
    });
    expect(metadata.responsesRequestContext).toBeUndefined();
    expect(metadata.inboundStream).toBeUndefined();
    expect(metadata.outboundStream).toBeUndefined();
    expect(metadata.clientAbortSignal).toBeUndefined();
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-resp-1',
      conversationId: 'conv-resp-1'
    });
    expect(readRuntimeControlProjection(metadata)).toMatchObject({
      streamIntent: 'stream',
      clientAbort: false
    });
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

    const center = MetadataCenter.read(nextMetadata);
    expect(center?.readContinuationContext().responsesRequestContext).toBe(requestContext);
    expect(nextMetadata?.responsesRequestContext).toBeUndefined();
    expect(center?.readRequestTruth()).toEqual({});
  });

  it('RED: relay submit_tool_outputs pipeline metadata must expose resumed session scope and route pin through metadata center truth', () => {
    const requestContext = {
      payload: { model: 'gpt-5.5', input: [] },
      context: { input: [] },
      sessionId: 'sess-stopless-live-1',
      conversationId: 'conv-stopless-live-1',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };
    const resumeMeta = {
      responseId: 'resp_stopless_live_1',
      continuationOwner: 'relay',
      routeHint: 'search',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      sessionId: 'sess-stopless-live-1',
      conversationId: 'conv-stopless-live-1'
    };

    const metadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: {
        originalStream: true,
        outboundStream: true,
        inboundStream: true,
        acceptsSse: true,
        requestStartMeta: {}
      },
      clientRequestId: 'client-stopless-live-1',
      requestContext,
      resumeMeta
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readContinuationContext()).toMatchObject({
      responsesRequestContext: requestContext,
      responsesResume: resumeMeta
    });
    expect(readRuntimeControlProjection(metadata)).toMatchObject({
      routeHint: 'search'
    });
    expect(readRuntimeControlProjection(metadata).retryProviderKey).toBeUndefined();
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-stopless-live-1',
      conversationId: 'conv-stopless-live-1'
    });
  });

  it('does not upgrade resumeMeta-only session scope into request truth', () => {
    const requestContext = {
      payload: { model: 'gpt-5.5', input: [] },
      context: { input: [] },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };
    const resumeMeta = {
      responseId: 'resp_resume_only_1',
      continuationOwner: 'relay',
      routeHint: 'thinking',
      sessionId: 'sess-resume-only-1',
      conversationId: 'conv-resume-only-1'
    };

    const metadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: {
        originalStream: true,
        outboundStream: true,
        inboundStream: true,
        acceptsSse: true,
        requestStartMeta: {}
      },
      clientRequestId: 'client-resume-only-1',
      requestContext,
      resumeMeta
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readContinuationContext()).toMatchObject({
      responsesResume: resumeMeta
    });
    expect(center?.readRequestTruth()).toEqual({});
    expect(readRuntimeControlProjection(metadata)).toMatchObject({
      routeHint: 'thinking'
    });
  });
});
