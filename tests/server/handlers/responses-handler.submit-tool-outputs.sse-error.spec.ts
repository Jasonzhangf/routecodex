import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockResumeResponsesConversation = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();
const mockClearResponsesConversationByRequestId = jest.fn(async () => undefined);
const mockFinalizeResponsesConversationRequestRetention = jest.fn(async () => undefined);
const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockMaterializeLatestResponsesContinuationByScope = jest.fn(async () => null);
const mockRecordResponsesResponseForRequest = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  extractSessionIdentifiersFromMetadata: jest.fn(() => ({})),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId: mockClearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention: mockFinalizeResponsesConversationRequestRetention,
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest: mockRecordResponsesResponseForRequest,
  resumeResponsesConversation: mockResumeResponsesConversation,
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({})),
  captureReqInboundResponsesContextSnapshotJson: jest.fn((args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  captureReqInboundResponsesContextSnapshot: jest.fn(async (args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  planResponsesHandlerEntry: jest.fn(async (payload: Record<string, unknown>, _entryEndpoint: string, responseIdFromPath?: string) => ({
    mode: 'submit_tool_outputs',
    payload: {
      ...payload,
      ...(responseIdFromPath ? { response_id: responseIdFromPath } : {}),
    },
    responseId: responseIdFromPath,
  })),
  materializeProviderOwnedSubmitContext: jest.fn((payload: Record<string, unknown>) => payload),
  planResponsesRequestContext: jest.fn(() => ({ shouldCapture: false, context: {} })),
  planResponsesContinuationRequestAction: jest.fn(() => ({ action: 'none' })),
  buildResponsesPayloadFromChatNative: jest.fn((payload: unknown) => payload),
  planResponsesJsonClientDispatchNative: jest.fn((args: { body?: unknown }) => ({ clientBody: args.body, sanitizedBody: args.body })),
  projectResponsesClientPayloadForClientNative: jest.fn((payload: unknown) => payload),
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
  updateResponsesSseTransportTerminalStateNative: jest.fn((input: { state?: Record<string, unknown>; chunk?: unknown }) => ({
    state: input.state ?? {},
    observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
  })),
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: undefined,
  })),
  projectSseErrorEventPayloadNative: jest.fn((args: { requestId?: string; status?: number; message?: string; code?: string }) => ({
    type: 'error',
    request_id: args.requestId,
    status: args.status ?? 500,
    message: args.message ?? 'sse error',
    code: args.code ?? 'ERR_SSE_ERROR',
  })),
  shouldRecordSnapshotsNative: jest.fn(() => false),
  writeSnapshotViaHooksNative: jest.fn(() => undefined),
  detectToolExecutionFailuresNative: jest.fn(() => []),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.ts', () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({})),
  captureReqInboundResponsesContextSnapshotJson: jest.fn((args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  captureReqInboundResponsesContextSnapshot: jest.fn(async (args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  planResponsesHandlerEntry: jest.fn(async (payload: Record<string, unknown>, _entryEndpoint: string, responseIdFromPath?: string) => ({
    mode: 'submit_tool_outputs',
    payload: {
      ...payload,
      ...(responseIdFromPath ? { response_id: responseIdFromPath } : {}),
    },
    responseId: responseIdFromPath,
  })),
  materializeProviderOwnedSubmitContext: jest.fn((payload: Record<string, unknown>) => payload),
  planResponsesRequestContext: jest.fn(() => ({ shouldCapture: false, context: {} })),
  planResponsesContinuationRequestAction: jest.fn(() => ({ action: 'none' })),
  buildResponsesPayloadFromChatNative: jest.fn((payload: unknown) => payload),
  planResponsesJsonClientDispatchNative: jest.fn((args: { body?: unknown }) => ({ clientBody: args.body, sanitizedBody: args.body })),
  projectResponsesClientPayloadForClientNative: jest.fn((payload: unknown) => payload),
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
  updateResponsesSseTransportTerminalStateNative: jest.fn((input: { state?: Record<string, unknown>; chunk?: unknown }) => ({
    state: input.state ?? {},
    observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
  })),
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: undefined,
  })),
  projectSseErrorEventPayloadNative: jest.fn((args: { requestId?: string; status?: number; message?: string; code?: string }) => ({
    type: 'error',
    request_id: args.requestId,
    status: args.status ?? 500,
    message: args.message ?? 'sse error',
    code: args.code ?? 'ERR_SSE_ERROR',
  })),
  shouldRecordSnapshotsNative: jest.fn(() => false),
  writeSnapshotViaHooksNative: jest.fn(() => undefined),
  detectToolExecutionFailuresNative: jest.fn(() => []),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));
jest.unstable_mockModule('../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../../src/server/utils/request-log-color.js', () => ({
  colorizeRequestLog: jest.fn((line: string) => line),
  formatHighlightedFinishReasonLabel: jest.fn((label?: string) => label),
  registerRequestLogContext: jest.fn(),
}));

jest.unstable_mockModule('../../../src/server/utils/finish-reason.js', () => ({
  STREAM_LOG_FINISH_REASON_KEY: '__routecodex_finish_reason',
  deriveFinishReason: jest.fn((body: Record<string, unknown> | undefined) => {
    const output = Array.isArray(body?.output) ? body.output : [];
    if (output.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call')) {
      return 'tool_calls';
    }
    return body?.status === 'completed' ? 'stop' : undefined;
  }),
}));

const createResponsesRequestBridgeMock = () => ({
  buildResponsesConversationPortScopeForHttp: jest.fn(() => undefined),
  buildResponsesPipelineMetadataForHttp: jest.fn((args: {
    streamPlan?: { outboundStream?: boolean };
    requestContext?: unknown;
  }) => ({
    stream: args.streamPlan?.outboundStream === true,
    responsesRequestContext: args.requestContext,
  })),
  captureResponsesInboundToolHistoryErrorsampleForHttp: jest.fn(async () => undefined),
  clearResponsesConversationOnHandlerFailureForHttp: jest.fn(async () => undefined),
  finalizeResponsesPipelineResultForHttp: jest.fn(async (args: { resultMetadata?: Record<string, unknown> }) => args.resultMetadata ?? {}),
  planResponsesHandlerStreamForHttp: jest.fn((args: {
    payload?: Record<string, unknown>;
    forceStream?: boolean;
    acceptsSse?: boolean;
  }) => ({
    outboundStream: args.forceStream === true || args.acceptsSse === true || args.payload?.stream === true,
    requestStartMeta: {},
  })),
  prepareResponsesRequestBodyForHttp: jest.fn((payload: Record<string, unknown>) => ({ pipelineBody: payload })),
  prepareResponsesHandlerRuntimeForHttp: jest.fn(async (args: {
    payload: Record<string, unknown>;
    entryEndpoint: string;
    responseIdFromPath?: string;
    forceStream?: boolean;
    acceptsSse?: boolean;
  }) => {
    const resumed = await mockResumeResponsesConversation({
      payload: args.payload,
      responseId: args.responseIdFromPath,
    });
    const payload = (resumed && typeof resumed === 'object' && 'payload' in resumed)
      ? (resumed as { payload?: Record<string, unknown> }).payload ?? args.payload
      : args.payload;
    const streamPlan = {
      outboundStream: args.forceStream === true || args.acceptsSse === true || payload.stream === true,
      requestStartMeta: {},
    };
    return {
      kind: 'ok',
      payload,
      isSubmitToolOutputs: args.entryEndpoint === '/v1/responses.submit_tool_outputs',
      pipelineEntryEndpoint: '/v1/responses',
      plannedEntryMode: 'submit_tool_outputs',
      requestBodyMetadata: {},
      requestContext: {
        payload,
        context: { input: Array.isArray(payload.input) ? payload.input : [] },
      },
      resumeMeta: (resumed && typeof resumed === 'object' && 'meta' in resumed)
        ? (resumed as { meta?: Record<string, unknown> }).meta
        : undefined,
      streamPlan,
    };
  }),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-request-bridge.js', createResponsesRequestBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-request-bridge.ts', createResponsesRequestBridgeMock);

const createResponsesBridgeMock = () => ({
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(() => undefined),
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp: jest.fn(() => undefined),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\n'),
  buildResponsesMissingSseBridgeErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' },
  })),
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  buildResponsesSseErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'Upstream provider error', code: 'INTERNAL_ERROR' },
  })),
  buildResponsesStreamIncompleteErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'stream closed before response.completed', code: 'upstream_stream_incomplete' },
  })),
  buildResponsesStructuredSseErrorPayloadForHttp: jest.fn((_error: unknown, args?: { status?: number }) => ({
    type: 'error',
    status: args?.status ?? 500,
    error: { message: 'Upstream provider error', code: 'INTERNAL_ERROR' },
  })),
  buildResponsesTerminalSseFramesFromProbeForHttp: jest.fn(() => []),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  createResponsesJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  createChatJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  createResponsesSseClientProjectionStateForHttp: jest.fn(() => ({})),
  sanitizeDirectPassthroughResponsesSseFrameForHttp: jest.fn((frame: string) => frame),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  inspectResponsesTerminalStateFromSseChunkForHttp: jest.fn(() => ({ sawTerminalChunk: false })),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn(() => false),
  normalizeChatUsagePayloadForHttp: jest.fn((body: unknown) => ({
    payload: body,
    normalized: false,
    source: undefined,
  })),
  normalizeResponsesSseFrameForClientForHttp: jest.fn((frame: string) => frame),
  planResponsesContinuationCloseActionForHttp: jest.fn(() => ({ action: 'none' })),
  planResponsesStreamEndRepairForHttp: jest.fn(() => ({ shouldRepair: false })),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn((body: unknown) => body),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(async (args: { body: unknown }) => ({
    clientBody: args.body,
    sanitizedBody: args.body,
    finishReason: undefined,
  })),
  projectResponsesSseFrameForClientForHttp: jest.fn((args: { frame?: string; state?: unknown }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: args.state,
  })),
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn(() => undefined),
  resolveResponsesRequestContextForHttp: jest.fn((args: { fallback?: unknown }) => args.fallback),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => undefined),
  resolveResponsesTerminalProbeFinishReasonForHttp: jest.fn(() => undefined),
  shouldClearResponsesConversationOnClientCloseForHttp: jest.fn(() => false),
  shouldClearResponsesConversationOnFailureForHttp: jest.fn(() => false),
  shouldDispatchResponsesSseToClientForHttp: jest.fn(() => false),
  shouldRequireResponsesTerminalEventForHttp: jest.fn(() => false),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => ({ kind: 'sse_frame' })),
  updateResponsesSseTransportTerminalStateForHttp: jest.fn((input: { chunk?: unknown; state?: Record<string, unknown> }) => ({
    state: input.state ?? {},
    observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
  })),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', createResponsesBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', createResponsesBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.ts', createResponsesBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.ts', createResponsesBridgeMock);

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('responses-handler submit_tool_outputs SSE error regression', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResumeResponsesConversation.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockReset();
    mockClearResponsesConversationByRequestId.mockReset();
    mockFinalizeResponsesConversationRequestRetention.mockReset();
    mockMaterializeLatestResponsesContinuationByScope.mockReset();
    mockRecordResponsesResponseForRequest.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockResolvedValue(undefined);
    mockClearResponsesConversationByRequestId.mockResolvedValue(undefined);
    mockFinalizeResponsesConversationRequestRetention.mockResolvedValue(undefined);
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValue(null);
    mockRecordResponsesResponseForRequest.mockResolvedValue(undefined);
  });

  it('keeps submit_tool_outputs relay error on SSE path instead of degrading to JSON', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.5',
        previous_response_id: 'resp_submit_sse_err_1',
        stream: true,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs relay 错误仍保持 SSE' }],
          },
        ],
        tool_outputs: [{ call_id: 'call_submit_sse_err_1', output: 'ok' }],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_sse_err_1',
        routeHint: 'coding',
      },
    });

    const app = express();
    app.use(express.json());
    app.post('/v1/responses/:id/submit_tool_outputs', async (req, res) => {
      await handleResponses(
        req as any,
        res as any,
        {
          executePipeline: async () => {
            throw Object.assign(new Error('submit_tool_outputs relay followup failed'), {
              code: 'INTERNAL_ERROR',
              upstreamCode: 'INTERNAL_ERROR',
              status: 500
            });
          },
          errorHandling: null,
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: req.params.id,
        },
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses/resp_submit_sse_err_1/submit_tool_outputs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          stream: true,
          tool_outputs: [{ call_id: 'call_submit_sse_err_1', output: 'ok' }],
        })
      });
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('Upstream provider error');
      expect(text).not.toContain('{"error":');
    });
  });
});
