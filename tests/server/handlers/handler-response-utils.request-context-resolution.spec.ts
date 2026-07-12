import { beforeEach, describe, expect, it, jest } from '@jest/globals';

function createMockResponse() {
  const response = {
    headers: new Map<string, string>(),
    statusCode: 200,
    setHeader: jest.fn((key: string, value: string) => {
      response.headers.set(key.toLowerCase(), value);
    }),
    status: jest.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: jest.fn(() => response),
    end: jest.fn(() => response),
  };
  return response;
}

function mockNativeExports(overrides: Record<string, unknown> = {}) {
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-client-projection-host.js', () => ({
    buildResponsesPayloadFromChatNative: jest.fn((payload: unknown) => payload),
    planResponsesJsonClientDispatchNative: jest.fn(() => ({ action: 'direct_passthrough' })),
    projectResponsesClientPayloadForClientNative: jest.fn((args: { payload?: unknown }) => args.payload ?? {}),
    ...overrides,
  }));
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/sse-projection-host.js', () => ({
    projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string; state?: unknown }) => ({
      emit: true,
      frame: args.frame ?? '',
      state: args.state,
    })),
    updateResponsesSseTransportTerminalStateNative: jest.fn((input: { chunk?: unknown; state?: Record<string, unknown> }) => ({
      state: input.state ?? {},
      observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
    })),
  }));
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/error-projection-host.js', () => ({
    projectSseErrorEventPayloadNative: jest.fn((args: unknown) => args),
  }));
}

describe('responses handler request-context resolution', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('registers metadata session id as the request log color identity when usage has only a log key', async () => {
    const registerRequestLogContext = jest.fn();
    mockNativeExports();
    jest.unstable_mockModule('../../../src/server/utils/request-log-color.js', () => ({
      colorizeRequestLog: jest.fn((line: string) => line),
      colorizeVirtualRouterHitLogLine: jest.fn((line: string) => line),
      extractLeadingAnsiColor: jest.fn(() => undefined),
      registerRequestLogContext,
      resolveRequestLogColorToken: jest.fn(() => undefined),
      resolveSessionLogColor: jest.fn(() => ''),
      stripAnsiCodes: jest.fn((line: string) => line),
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined,
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = createMockResponse();

    await sendPipelineResponse(
      res as any,
      {
        status: 204,
        body: null,
        metadata: {
          sessionId: 'visible-session-color',
          conversationId: 'visible-conversation-color',
          logSessionColorKey: 'metadata-log-key',
        },
        usageLogInfo: {
          requestStartedAtMs: Date.now(),
          logSessionColorKey: 'usage-route-color-key',
        },
      } as any,
      'req-response-log-context',
      { entryEndpoint: '/v1/responses' }
    );

    expect(registerRequestLogContext).toHaveBeenCalledWith(
      'req-response-log-context',
      expect.objectContaining({
        sessionId: 'visible-session-color',
        session_id: 'visible-session-color',
        conversationId: 'visible-conversation-color',
        conversation_id: 'visible-conversation-color',
        logSessionColorKey: 'usage-route-color-key',
      })
    );
  });

  it('fails client JSON projection if requestContext.context.toolsRaw is absent', async () => {
    mockNativeExports({
      planResponsesJsonClientDispatchNative: jest.fn(() => ({ action: 'project_client_payload' })),
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined,
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = createMockResponse();

    await expect(
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: {
            id: 'resp_bridge_tools_raw_contract',
            object: 'response',
            status: 'completed',
            output: [],
          },
          metadata: {},
        } as any,
        'req-response-tools-raw',
        {
          entryEndpoint: '/v1/responses',
          responsesRequestContext: {
            payload: {
              model: 'gpt-5.4',
              tools: [{ type: 'function', function: { name: 'exec_command' } }],
            },
            context: {
              clientToolsRaw: [{ type: 'function', function: { name: 'apply_patch' } }],
            },
          } as any,
        }
      )
    ).rejects.toThrow('Responses client projection requires requestContext.context.toolsRaw');
  });
});
