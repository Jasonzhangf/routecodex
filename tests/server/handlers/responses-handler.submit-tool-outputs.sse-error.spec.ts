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

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  buildResponsesJsonFromSseStreamWithNative: jest.fn(async () => ({})),
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearAllResponsesConversationState: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: mockClearResponsesConversationByRequestId,
  clearUnresolvedResponsesConversationRequests: jest.fn(async () => undefined),
  finalizeResponsesConversationRequestRetention: mockFinalizeResponsesConversationRequestRetention,
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: mockRecordResponsesResponseForRequest,
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  reportProviderErrorToRouterPolicy: jest.fn(() => undefined),
  reportProviderSuccessToRouterPolicy: jest.fn(() => undefined),
  resetResponsesConversationStateForRestartSimulation: jest.fn(async () => undefined),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
  resumeResponsesConversation: mockResumeResponsesConversation,
  writeSnapshotViaHooks: jest.fn(async () => undefined),
}));

const createResponsesClientProjectionHostMock = () => ({
  buildResponsesPayloadFromChatNative: jest.fn((payload: unknown) => payload),
  planResponsesJsonClientDispatchNative: jest.fn(() => ({ action: 'direct_passthrough' })),
  projectResponsesClientPayloadForClientNative: jest.fn((payload: unknown) => payload),
});

const createSseProjectionHostMock = () => ({
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string; state?: unknown }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: args.state,
  })),
  updateResponsesSseTransportTerminalStateNative: jest.fn((input: { state?: Record<string, unknown>; chunk?: unknown }) => ({
    state: input.state ?? {},
    observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
  })),
});

const createErrorProjectionHostMock = () => ({
  projectSseErrorEventPayloadNative: jest.fn((args: { requestId?: string; status?: number; message?: string; code?: string }) => ({
    type: 'error',
    request_id: args.requestId,
    status: args.status ?? 500,
    message: args.message ?? 'sse error',
    code: args.code ?? 'ERR_SSE_ERROR',
  })),
});

const createConfigIntegrationsHostMock = () => ({
  buildRouteCodexForwarderProfilesSync: jest.fn(() => ({})),
  buildRouteCodexProviderProfilesSync: jest.fn(() => ({})),
  coerceRouteCodexProviderConfigV2: jest.fn(async (input: unknown) => input ?? null),
  coerceRouteCodexProviderConfigV2Sync: jest.fn((input: unknown) => input ?? null),
  collectRouteCodexV2ConfigSourceErrorsSync: jest.fn(() => []),
  compileRouteCodexRuntimeManifest: jest.fn(async (input: unknown) => input ?? {}),
  compileRouteCodexRuntimeManifestSync: jest.fn((input: unknown) => input ?? {}),
  decodeRouteCodexProviderConfigTextSync: jest.fn(() => ({ format: 'toml', raw: '', parsed: {} })),
  decodeRouteCodexUserConfigTextSync: jest.fn(() => ({ format: 'toml', raw: '', parsed: {} })),
  detectRouteCodexProviderConfigFormatSync: jest.fn(() => 'toml'),
  detectRouteCodexUserConfigFormatSync: jest.fn(() => 'toml'),
  extractRouteCodexMaterializedProviderConfigsSync: jest.fn(() => null),
  loadRouteCodexConfigNativeSync: jest.fn(() => ({ configPath: '', userConfig: {}, providerProfiles: {} })),
  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
  materializeRouteCodexUserConfigFromManifestSync: jest.fn((input: unknown) => input ?? {}),
  normalizeRouteCodexV2RuntimeSourceSync: jest.fn((input: unknown) => input ?? {}),
  parseRouteCodexTomlRecordSync: jest.fn(() => ({})),
  planAuthFileResolutionNativeSync: jest.fn(() => ({ candidates: [] })),
  planProviderConfigRootNativeSync: jest.fn(() => ({ rootDir: '/tmp/routecodex-test/provider' })),
  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({ candidates: [] })),
  planRouteCodexProviderConfigV2FilesSync: jest.fn(() => []),
  resolveAuthFileKeyNativeSync: jest.fn(() => undefined),
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: jest.fn(() => undefined),
  resolveRccPathNativeSync: jest.fn((segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  }),
  resolveRccSnapshotsDirNativeSync: jest.fn(() => '/tmp/routecodex-test/codex-samples'),
  resolveRccUserDirNativeSync: jest.fn(() => '/tmp/routecodex-test'),
  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test/config.toml'),
  resolveRouteCodexProviderConfigV2IdentitySync: jest.fn(() => ({ providerId: 'mock' })),
  serializeRouteCodexTomlRecordSync: jest.fn(() => ''),
  updateRouteCodexTomlStringScalarInTableSync: jest.fn(() => ''),
  updateRouteCodexUserConfigStringScalarNativeSync: jest.fn(() => ''),
  writeRouteCodexProviderConfigFileNativeSync: jest.fn(() => undefined),
  writeRouteCodexUserConfigFileNativeSync: jest.fn(() => undefined),
});

const createExecutorMetadataHostMock = () => ({
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  extractSessionIdentifiersFromMetadataNative: jest.fn((metadata?: Record<string, unknown>) => ({
    sessionId: metadata?.sessionId ?? metadata?.session_id,
    conversationId: metadata?.conversationId ?? metadata?.conversation_id,
  })),
});

jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/responses-client-projection-host.js',
  createResponsesClientProjectionHostMock,
);
jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/sse-projection-host.js',
  createSseProjectionHostMock,
);
jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/error-projection-host.js',
  createErrorProjectionHostMock,
);
jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/config-integrations.js',
  createConfigIntegrationsHostMock,
);
jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/executor-metadata-host.js',
  createExecutorMetadataHostMock,
);

jest.unstable_mockModule('../../../src/debug/diag/index.js', () => ({
  writeDebugErrorDiagArtifact: jest.fn(async () => '/tmp/routecodex-test/debug-error.json'),
}));

jest.unstable_mockModule('../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
  getSystemPromptOverride: jest.fn(() => null),
}));

jest.unstable_mockModule('../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../../src/server/utils/request-log-color.js', () => ({
  colorizeRequestLog: jest.fn((line: string) => line),
  formatHighlightedFinishReasonLabel: jest.fn((label?: string) => label),
  registerRequestLogContext: jest.fn(),
  resolveRequestLogColorToken: jest.fn(() => undefined),
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
  buildResponsesScopeContinuationExpiredErrorForHttp: jest.fn(() => ({
    error: { message: 'continuation expired', code: 'continuation_expired' },
  })),
  buildResponsesConversationPortScopeForHttp: jest.fn(() => undefined),
  buildResponsesPipelineMetadataForHttp: jest.fn((args: {
    streamPlan?: { outboundStream?: boolean };
    requestContext?: unknown;
  }) => ({
    stream: args.streamPlan?.outboundStream === true,
    responsesRequestContext: args.requestContext,
  })),
  clearResponsesConversationByRequestIdForHttp: mockClearResponsesConversationByRequestId,
  captureResponsesInboundToolHistoryErrorsampleForHttp: jest.fn(async () => undefined),
  clearResponsesConversationOnHandlerFailureForHttp: jest.fn(async () => undefined),
  finalizeResponsesHandlerPayloadForHttp: jest.fn((args: { payload?: Record<string, unknown> }) => args.payload ?? {}),
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
  prepareResponsesHandlerEntryForHttp: jest.fn(async (args: {
    payload: Record<string, unknown>;
    responseIdFromPath?: string;
  }) => ({
    mode: 'submit_tool_outputs',
    payload: {
      ...args.payload,
      ...(args.responseIdFromPath ? { response_id: args.responseIdFromPath } : {}),
    },
    responseId: args.responseIdFromPath,
  })),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-request-bridge.js', createResponsesRequestBridgeMock);

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
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
