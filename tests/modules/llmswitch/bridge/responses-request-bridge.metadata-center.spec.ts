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
  materializeProviderOwnedSubmitContext: jest.fn(),
  planResponsesRequestContext: jest.fn(),
  planResponsesContinuationRequestAction: jest.fn(),
  planResponsesHandlerEntry: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/server/utils/finish-reason.js', () => ({
  deriveFinishReason: jest.fn(() => 'stop'),
}));

jest.unstable_mockModule('../../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(),
}));

let buildResponsesPipelineMetadataForHttp: any;
let planResponsesHandlerStreamForHttp: any;
let attachResponsesRequestContextToResultForHttp: any;
let MetadataCenter: any;
let readRuntimeControlProjection: any;

beforeAll(async () => {
  ({
    buildResponsesPipelineMetadataForHttp,
    planResponsesHandlerStreamForHttp,
    attachResponsesRequestContextToResultForHttp
  } = await import('../../../../src/modules/llmswitch/bridge/responses-request-bridge.js'));
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({ readRuntimeControlProjection } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.ts'
  ));
});

describe('responses-request-bridge metadata center projection', () => {
  it('keeps responses submit without stream and without SSE accept on JSON outbound path', () => {
    const streamPlan = planResponsesHandlerStreamForHttp({
      payload: { model: 'gpt-5.4', tool_outputs: [] },
      acceptsSse: false
    });
    expect(streamPlan.originalStream).toBe(false);
    expect(streamPlan.outboundStream).toBe(false);
    expect(streamPlan.inboundStream).toBe(false);
    expect(streamPlan.requestStartMeta).toMatchObject({
      inboundStream: false,
      outboundStream: false,
      clientAcceptsSse: false,
      originalStream: false
    });
  });

  it('writes request-side responses continuation control into metadata center', () => {
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
      responsesResume: resumeMeta
    });
    expect(center?.readRuntimeControl()).toMatchObject({
      providerProtocol: 'openai-responses',
      streamIntent: 'stream',
      clientAbort: false
    });
    expect(metadata.responsesRequestContext).toBeUndefined();
    expect(metadata.inboundStream).toBeUndefined();
    expect(metadata.outboundStream).toBeUndefined();
    expect(metadata.clientAbortSignal).toBeUndefined();
    expect(center?.readRequestTruth()).toEqual({});
    expect(readRuntimeControlProjection(metadata)).toMatchObject({
      providerProtocol: 'openai-responses',
      streamIntent: 'stream',
      clientAbort: false
    });
  });

  it('does not write response-side request context attachment into metadata center', () => {
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
    expect(center).toBeUndefined();
    expect(nextMetadata?.responsesRequestContext).toBeUndefined();
  });

  it('relay submit_tool_outputs pipeline metadata must not carry route pin in continuation context', () => {
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
      responsesResume: {
        responseId: 'resp_stopless_live_1',
        continuationOwner: 'relay'
      }
    });
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('providerKey');
    expect(readRuntimeControlProjection(metadata).routeHint).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).retryProviderKey).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).providerProtocol).toBe('openai-responses');
    expect(center?.readRequestTruth()).toEqual({});
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
      responsesResume: {
        responseId: 'resp_resume_only_1',
        continuationOwner: 'relay'
      }
    });
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(center?.readRequestTruth()).toEqual({});
    expect(readRuntimeControlProjection(metadata).routeHint).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).retryProviderKey).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).providerProtocol).toBe('openai-responses');
  });

  it('keeps current-turn stopless tool output evidence in responses resume control only', () => {
    const requestContext = {
      payload: { model: 'gpt-5.5', input: [] },
      context: { input: [] },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };
    const stoplessStdout = JSON.stringify({
      ok: true,
      kind: 'stop_message_auto',
      tool: 'reasoningStop',
      repeatCount: 1,
      maxRepeats: 3,
      schemaFeedback: {
        reasonCode: 'stop_schema_next_step_missing',
        missingFields: ['next_step']
      }
    });
    const resumeMeta = {
      responseId: 'resp_stopless_tool_output_1',
      continuationOwner: 'relay',
      routeHint: 'search',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      sessionId: 'sess-from-resume-meta',
      conversationId: 'conv-from-resume-meta',
      fullInput: [{ type: 'message', content: 'must not be copied' }],
      toolOutputsDetailed: [
        {
          callId: 'call_stopless_1',
          originalId: 'call_stopless_original_1',
          outputText: stoplessStdout,
          output: { must: 'not be copied' },
          rawPayload: { must: 'not be copied' }
        },
        {
          callId: 'call_blank_output',
          outputText: '   '
        },
        {
          outputText: 'missing call id'
        }
      ]
    };

    const metadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: {
        originalStream: true,
        outboundStream: true,
        inboundStream: true,
        acceptsSse: true,
        requestStartMeta: {}
      },
      clientRequestId: 'client-stopless-tool-output-1',
      requestContext,
      resumeMeta
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readContinuationContext()).toMatchObject({
      responsesResume: {
        responseId: 'resp_stopless_tool_output_1',
        continuationOwner: 'relay',
        toolOutputsDetailed: [
          {
            callId: 'call_stopless_1',
            originalId: 'call_stopless_original_1',
            outputText: stoplessStdout
          }
        ]
      }
    });
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('providerKey');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('sessionId');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('conversationId');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('fullInput');
    expect(center?.readContinuationContext().responsesResume.toolOutputsDetailed?.[0]).not.toHaveProperty('output');
    expect(center?.readContinuationContext().responsesResume.toolOutputsDetailed?.[0]).not.toHaveProperty('rawPayload');
    expect(center?.readRequestTruth()).toEqual({});
    expect(readRuntimeControlProjection(metadata).routeHint).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).retryProviderKey).toBeUndefined();
  });
});
