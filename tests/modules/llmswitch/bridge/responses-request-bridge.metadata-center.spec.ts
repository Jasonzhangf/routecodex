import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  buildResponsesResumeControlForContinuationContextForHttpFake,
  finalizeResponsesHandlerPayloadForHttpFake,
} from '../../../providers/helpers/llmswitch-native-exports-fake.js';

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
  buildResponsesConversationPortScopeForHttpNative: jest.fn((portContext?: {
    matchedPort?: unknown;
    localPort?: unknown;
    routingPolicyGroup?: unknown;
  } | null) => {
    const matchedPort = typeof portContext?.matchedPort === 'number'
      ? portContext.matchedPort
      : typeof portContext?.localPort === 'number'
        ? portContext.localPort
        : undefined;
    const routingPolicyGroup = typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()
      ? portContext.routingPolicyGroup.trim()
      : undefined;
    return {
      ...(typeof matchedPort === 'number' ? { matchedPort } : {}),
      ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
    };
  }),
  buildResponsesScopeContinuationExpiredErrorForHttpNative: jest.fn(() => ({
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  })),
  buildResponsesResumeClientErrorForHttpNative: jest.fn((args: {
    status?: number;
    code?: string;
    origin?: string;
    message?: string;
  }) => ({
    status: typeof args.status === 'number' ? args.status : 422,
    body: {
      error: {
        message:
          typeof args.message === 'string' && args.message.trim()
            ? args.message
            : 'Unable to resume Responses conversation',
        type: 'invalid_request_error',
        code:
          typeof args.code === 'string' && args.code.trim()
            ? args.code
            : 'responses_resume_failed',
        origin:
          typeof args.origin === 'string' && args.origin.trim()
            ? args.origin
            : 'client',
      },
    },
  })),
  shouldProjectResponsesResumeClientErrorForHttpNative: jest.fn(
    (origin?: string) => typeof origin === 'string' && origin.trim() === 'client'
  ),
  buildResponsesResumeControlForContinuationContextForHttpNative: jest.fn(
    buildResponsesResumeControlForContinuationContextForHttpFake
  ),
  finalizeResponsesHandlerPayloadForHttpNative: jest.fn(finalizeResponsesHandlerPayloadForHttpFake),
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

let buildResponsesPipelineMetadataForHttp: any;
let planResponsesHandlerStreamForHttp: any;
let buildResponsesConversationPortScopeForHttp: any;
let finalizeResponsesPipelineResultForHttp: any;
let MetadataCenter: any;
let readRuntimeControlProjection: any;
let runtimeIntegrations: any;

beforeAll(async () => {
  ({
    buildResponsesPipelineMetadataForHttp,
    planResponsesHandlerStreamForHttp,
    buildResponsesConversationPortScopeForHttp,
    finalizeResponsesPipelineResultForHttp
  } = await import('../../../../src/modules/llmswitch/bridge/responses-request-bridge.js'));
  runtimeIntegrations = await import('../../../../src/modules/llmswitch/bridge/runtime-integrations.js');
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

  it('treats non-boolean stream as absent when planning outbound stream', () => {
    const streamPlan = planResponsesHandlerStreamForHttp({
      payload: { model: 'gpt-5.4', stream: 'false' },
      acceptsSse: true
    });
    expect(streamPlan.originalStream).toBe(false);
    expect(streamPlan.outboundStream).toBe(true);
    expect(streamPlan.inboundStream).toBe(true);
  });

  it('builds port scope through the native bridge surface', () => {
    expect(buildResponsesConversationPortScopeForHttp({
      matchedPort: 5555,
      localPort: 5520,
      routingPolicyGroup: ' longcontext '
    })).toEqual({
      matchedPort: 5555,
      routingPolicyGroup: 'longcontext',
    });
    expect(buildResponsesConversationPortScopeForHttp({
      localPort: 5520,
      routingPolicyGroup: ' '
    })).toEqual({
      matchedPort: 5520,
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

  it('does not write response-side request context attachment into metadata center during finalize', async () => {
    runtimeIntegrations.captureResponsesRequestContextForRequest.mockClear();
    runtimeIntegrations.recordResponsesResponseForRequest.mockClear();
    const requestContext = {
      payload: { model: 'gpt-5.4', input: [] },
      context: { input: [] },
      sessionId: 'sess-resp-2',
      conversationId: 'conv-resp-2'
    };

    const nextMetadata = await finalizeResponsesPipelineResultForHttp({
      entryEndpoint: '/v1/responses',
      requestId: 'req-no-context-attach',
      body: { id: 'resp-no-context-attach', status: 'completed' },
      resultMetadata: {},
      requestContext
    });

    const center = MetadataCenter.read(nextMetadata);
    expect(center).toBeUndefined();
    expect(nextMetadata?.responsesRequestContext).toBeUndefined();
    expect(runtimeIntegrations.captureResponsesRequestContextForRequest).not.toHaveBeenCalled();
    expect(runtimeIntegrations.recordResponsesResponseForRequest).not.toHaveBeenCalled();
  });

  it('does not let handler finalize overwrite router-direct continuation state', async () => {
    runtimeIntegrations.captureResponsesRequestContextForRequest.mockClear();
    runtimeIntegrations.recordResponsesResponseForRequest.mockClear();
    const requestContext = {
      payload: { model: 'gpt-5.4', input: [] },
      context: { input: [] },
      sessionId: 'sess-direct-finalize',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };

    await finalizeResponsesPipelineResultForHttp({
      entryEndpoint: '/v1/responses',
      requestId: 'req-direct-finalize',
      body: {
        id: 'resp-direct-finalize',
        output: [
          {
            type: 'function_call',
            call_id: 'call_direct_finalize',
            name: 'lookup',
            arguments: '{}'
          }
        ]
      },
      resultMetadata: {},
      requestContext,
      providerKey: 'p1.key1',
      continuationOwner: 'direct'
    });

    expect(runtimeIntegrations.captureResponsesRequestContextForRequest).not.toHaveBeenCalled();
    expect(runtimeIntegrations.recordResponsesResponseForRequest).not.toHaveBeenCalled();
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

  it('promotes direct continuation provider pin into runtime control', () => {
    const requestContext = {
      payload: { model: 'gpt-5.5', input: [] },
      context: { input: [] },
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    };
    const resumeMeta = {
      responseId: 'resp_direct_resume_1',
      continuationOwner: 'direct',
      providerKey: 'provider.key1.gpt-5.4',
      routeHint: 'search',
      sessionId: 'sess-direct-resume-1',
      conversationId: 'conv-direct-resume-1'
    };

    const metadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: {
        originalStream: false,
        outboundStream: false,
        inboundStream: false,
        acceptsSse: false,
        requestStartMeta: {}
      },
      clientRequestId: 'client-direct-resume-1',
      requestContext,
      resumeMeta
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readContinuationContext()).toMatchObject({
      responsesResume: {
        responseId: 'resp_direct_resume_1',
        continuationOwner: 'direct',
        providerKey: 'provider.key1.gpt-5.4'
      }
    });
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('sessionId');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('conversationId');
    expect(center?.readRequestTruth()).toEqual({});
    expect(readRuntimeControlProjection(metadata).routeHint).toBeUndefined();
    expect(readRuntimeControlProjection(metadata).retryProviderKey).toBe('provider.key1.gpt-5.4');
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
