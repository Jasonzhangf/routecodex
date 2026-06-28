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
beforeAll(async () => {
  ({ resolveResponsesRequestContextForHttp } = await import(
    '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
  ));
});

describe('responses-response-bridge request-context resolution', () => {
  it('uses explicit fallback request context', () => {
    const resolved = resolveResponsesRequestContextForHttp({
      fallback: {
        payload: { model: 'fallback-model', store: true },
        context: { input: [{ type: 'message', role: 'user' }] },
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

  it('does not read top-level metadata.responsesRequestContext without explicit fallback', () => {
    const resolved = resolveResponsesRequestContextForHttp({
      metadata: {
        responsesRequestContext: {
          payload: { model: 'top-level-only' },
          context: { input: [] },
          sessionId: 'sess_top_level_only',
        },
      },
    });

    expect(resolved).toBeUndefined();
  });

  it('returns fallback even when metadata exists', () => {
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
