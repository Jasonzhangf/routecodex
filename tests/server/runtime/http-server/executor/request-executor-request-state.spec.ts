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
  it('registers request log context from initial metadata request fields', async () => {
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
      sessionId: 'flat-session-should-not-win',
      session_id: 'flat-session-should-not-win',
      conversationId: 'flat-conversation-should-not-win',
      conversation_id: 'flat-conversation-should-not-win'
    }));
  });

  it('returns projectPath from initial metadata raw workdir fields', async () => {
    jest.resetModules();
    mockRegisterRequestLogContext.mockReset();
    mockWriteInboundClientSnapshot.mockReset();

    mockBuildRequestMetadata.mockReturnValue({
      clientWorkdir: '/tmp/raw-project-workdir',
      client_workdir: '/tmp/raw-project-workdir'
    });

    const { initializeRequestExecutorRequestState } = await loadRequestStateModule();
    const result = await initializeRequestExecutorRequestState({
      input: {
        requestId: 'req-request-state-project',
        entryEndpoint: '/v1/responses',
        body: { input: [] },
        headers: {},
        metadata: {}
      } as any,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(result.projectPath).toBe('/tmp/raw-project-workdir');
  });

  it('does not synthesize request log session context when initial metadata omits it', async () => {
    jest.resetModules();
    mockRegisterRequestLogContext.mockReset();
    mockWriteInboundClientSnapshot.mockReset();

    mockBuildRequestMetadata.mockReturnValue({});

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
