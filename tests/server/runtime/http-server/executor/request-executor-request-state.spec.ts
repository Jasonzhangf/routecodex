import { describe, expect, it, jest } from '@jest/globals';

const mockRegisterRequestLogContext = jest.fn();
const mockBuildRequestMetadata = jest.fn();
const mockCloneClientHeaders = jest.fn(() => undefined);
const mockResolveClientRequestId = jest.fn(() => 'client-req-1');
const mockWriteInboundClientSnapshot = jest.fn(async () => undefined);
const mockGetClientConnectionAbortSignal = jest.fn(() => undefined);

jest.unstable_mockModule('../../../../../src/server/utils/request-log-color.js', () => ({
  registerRequestLogContext: mockRegisterRequestLogContext
}));

jest.unstable_mockModule('../../../../../src/server/runtime/http-server/executor-metadata.js', () => ({
  buildRequestMetadata: mockBuildRequestMetadata,
  cloneClientHeaders: mockCloneClientHeaders,
  resolveClientRequestId: mockResolveClientRequestId
}));

jest.unstable_mockModule('../../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js', () => ({
  writeInboundClientSnapshot: mockWriteInboundClientSnapshot
}));

jest.unstable_mockModule('../../../../../src/server/utils/client-connection-state.js', () => ({
  getClientConnectionAbortSignal: mockGetClientConnectionAbortSignal
}));

async function loadRequestStateModule() {
  return import('../../../../../src/server/runtime/http-server/executor/request-executor-request-state.js');
}

describe('request-executor-request-state', () => {
  it('registers request log context from metadata center request truth instead of flat metadata fields', async () => {
    jest.resetModules();
    mockRegisterRequestLogContext.mockReset();
    mockWriteInboundClientSnapshot.mockReset();

    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );
    const metadata: Record<string, unknown> = {
      sessionId: 'flat-session-should-not-win',
      conversationId: 'flat-conversation-should-not-win'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'truth-session',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts',
        symbol: 'registers request log context from metadata center request truth instead of flat metadata fields',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'truth-conversation',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-request-state.spec.ts',
        symbol: 'registers request log context from metadata center request truth instead of flat metadata fields',
        stage: 'test'
      }
    );
    mockBuildRequestMetadata.mockReturnValue(metadata);

    const { initializeRequestExecutorRequestState } = await loadRequestStateModule();
    await initializeRequestExecutorRequestState({
      input: {
        requestId: 'req-request-state-truth',
        entryEndpoint: '/v1/responses',
        body: { input: [] },
        headers: {},
        metadata: {}
      } as any,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(mockRegisterRequestLogContext).toHaveBeenCalledWith('req-request-state-truth', expect.objectContaining({
      sessionId: 'truth-session',
      session_id: 'truth-session',
      conversationId: 'truth-conversation',
      conversation_id: 'truth-conversation'
    }));
  });

  it('does not synthesize request log session context from flat metadata when request truth is absent', async () => {
    jest.resetModules();
    mockRegisterRequestLogContext.mockReset();
    mockWriteInboundClientSnapshot.mockReset();

    mockBuildRequestMetadata.mockReturnValue({
      sessionId: 'flat-session-only',
      conversationId: 'flat-conversation-only'
    });

    const { initializeRequestExecutorRequestState } = await loadRequestStateModule();
    await initializeRequestExecutorRequestState({
      input: {
        requestId: 'req-request-state-no-truth',
        entryEndpoint: '/v1/responses',
        body: { input: [] },
        headers: {},
        metadata: {}
      } as any,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(mockRegisterRequestLogContext).toHaveBeenCalledWith('req-request-state-no-truth', expect.objectContaining({
      sessionId: undefined,
      session_id: undefined,
      conversationId: undefined,
      conversation_id: undefined
    }));
  });
});
