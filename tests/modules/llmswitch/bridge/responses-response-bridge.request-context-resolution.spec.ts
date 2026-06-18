import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/index.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  importCoreDist: jest.fn(),
  isToolCallContinuationResponseNative: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  requireCoreDist: jest.fn(),
  updateResponsesContractProbeFromSseChunkNative: jest.fn(),
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  clearAllResponsesConversationState: jest.fn(),
  clearUnresolvedResponsesConversationRequests: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  createResponsesSseToJsonConverter: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  lookupResponsesContinuationByResponseId: jest.fn(),
  materializeLatestResponsesContinuationByScope: jest.fn(),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({})),
  recordResponsesResponseForRequest: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  reportProviderErrorToRouterPolicy: jest.fn(),
  reportProviderSuccessToRouterPolicy: jest.fn(),
  resetResponsesConversationStateForRestartSimulation: jest.fn(),
  resumeLatestResponsesContinuationByScope: jest.fn(),
  resumeResponsesConversation: jest.fn(),
  writeSnapshotViaHooks: jest.fn(),
}));

let resolveResponsesRequestContextForHttp: any;
let MetadataCenter: any;

beforeAll(async () => {
  ({ resolveResponsesRequestContextForHttp } = await import(
    '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
  ));
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
});

describe('responses-response-bridge request-context resolution', () => {
  it('prefers MetadataCenter continuation_context responsesRequestContext over server fallback context', () => {
    const metadata: Record<string, unknown> = {};
    const requestContext = {
      payload: { model: 'gpt-5.5', store: true },
      context: { input: [{ type: 'message' }] },
      sessionId: 'sess_meta',
    };
    const center = MetadataCenter.attach(metadata);
    center.writeContinuationContext(
      'responsesRequestContext',
      requestContext,
      {
        module: 'tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts',
        symbol: 'prefers MetadataCenter continuation_context responsesRequestContext over server fallback context',
        stage: 'test',
      }
    );

    const resolved = resolveResponsesRequestContextForHttp({
      metadata,
      fallback: {
        payload: { model: 'fallback-model' },
        context: { input: [] },
        sessionId: 'sess_fallback',
      },
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        sessionId: 'sess_meta',
        payload: expect.objectContaining({ model: 'gpt-5.5' }),
      }),
    );
  });

  it('does not read top-level metadata.responsesRequestContext without MetadataCenter binding', () => {
    const resolved = resolveResponsesRequestContextForHttp({
      metadata: {
        responsesRequestContext: {
          payload: { model: 'top-level-only' },
          context: { input: [] },
          sessionId: 'sess_top_level_only',
        },
      },
      fallback: {
        payload: { model: 'fallback-model' },
        context: { input: [] },
        sessionId: 'sess_fallback',
      },
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        sessionId: 'sess_fallback',
        payload: expect.objectContaining({ model: 'fallback-model' }),
      }),
    );
  });

  it('falls back only when result metadata does not carry responsesRequestContext', () => {
    const resolved = resolveResponsesRequestContextForHttp({
      metadata: { outboundStream: true },
      fallback: {
        payload: { model: 'gpt-5.4-mini' },
        context: { input: [] },
        conversationId: 'conv_fallback',
      },
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        conversationId: 'conv_fallback',
        payload: expect.objectContaining({ model: 'gpt-5.4-mini' }),
      }),
    );
  });
});
