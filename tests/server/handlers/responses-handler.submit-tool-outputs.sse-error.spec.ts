import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBridgeHttpServerMock } from '../../helpers/bridge-http-server-mock.js';

const mockResumeResponsesConversation = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();
const mockClearResponsesConversationByRequestId = jest.fn(async () => undefined);
const mockFinalizeResponsesConversationRequestRetention = jest.fn(async () => undefined);
const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockMaterializeLatestResponsesContinuationByScope = jest.fn(async () => null);
const mockRecordResponsesResponseForRequest = jest.fn(async () => undefined);

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
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: undefined,
  })),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.ts', () => ({
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
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: undefined,
  })),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));

jest.unstable_mockModule('../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(async () => undefined),
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

const createResponsesBridgeMock = () => ({
  ...createBridgeHttpServerMock(),
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
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn(() => undefined),
  resolveResponsesRequestContextForHttp: jest.fn((args: { fallback?: unknown }) => args.fallback),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => undefined),
  resolveResponsesTerminalProbeFinishReasonForHttp: jest.fn(() => undefined),
  shouldClearResponsesConversationOnClientCloseForHttp: jest.fn(() => false),
  shouldClearResponsesConversationOnFailureForHttp: jest.fn(() => false),
  shouldDispatchResponsesSseToClientForHttp: jest.fn(() => false),
  shouldDropClientSseFrameForHttp: jest.fn(() => false),
  shouldRequireResponsesTerminalEventForHttp: jest.fn(() => false),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => ({ kind: 'sse_frame' })),
  updateResponsesContractProbeFromSseChunkForHttp: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', createResponsesBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', createResponsesBridgeMock);

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
