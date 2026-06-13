import { describe, expect, it, jest } from '@jest/globals';

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

const { resolveResponsesRequestContextForHttp } = await import(
  '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
);

describe('responses-response-bridge request-context resolution', () => {
  it('RED: prefers result metadata responsesRequestContext over server fallback context', () => {
    const resolved = resolveResponsesRequestContextForHttp({
      metadata: {
        responsesRequestContext: {
          payload: { model: 'gpt-5.5', store: true },
          context: { input: [{ type: 'message' }] },
          sessionId: 'sess_meta',
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
        sessionId: 'sess_meta',
        payload: expect.objectContaining({ model: 'gpt-5.5' }),
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
