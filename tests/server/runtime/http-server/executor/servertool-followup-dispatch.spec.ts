import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockRunClientInjectionFlowBeforeReenter = jest.fn();

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/client-injection-flow.js',
  () => ({
    runClientInjectionFlowBeforeReenter: mockRunClientInjectionFlowBeforeReenter
  })
);

describe('servertool followup dispatch helper', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRunClientInjectionFlowBeforeReenter.mockReset();
  });

  it('reenter path reuses normalized nested metadata and executes nested request once', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({ status: 200, body: { echoed: input.metadata } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/messages',
      fallbackEntryEndpoint: '/v1/messages',
      requestId: 'req_followup_dispatch_1',
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'anthropic-session-id': 'sess_1',
          'anthropic-conversation-id': 'conv_1',
          authorization: 'Bearer should-not-forward'
        },
        clientRequestId: 'client_req_1'
      },
      baseMetadata: {
        someBase: 'value'
      },
      executeNested
    });

    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    expect(executeNested).toHaveBeenCalledTimes(1);

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata).toMatchObject({
      someBase: 'value',
      sessionId: 'sess_1',
      conversationId: 'conv_1',
      clientHeaders: {
        'anthropic-session-id': 'sess_1',
        'anthropic-conversation-id': 'conv_1'
      }
    });
    expect(nestedInput?.headers).toEqual({
      'anthropic-session-id': 'sess_1',
      'anthropic-conversation-id': 'conv_1',
      authorization: 'Bearer should-not-forward'
    });
    expect(nestedInput?.metadata?.clientRequestId).toBeUndefined();
    expect((result.body as Record<string, any>)?.echoed?.sessionId).toBe('sess_1');
  });

  it('reenter path short-circuits to client inject only outcome before nested execute', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: true });
    const executeNested = jest.fn(async () => ({ status: 200, body: { unexpected: true } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_2',
      body: { input: 'continue' },
      metadata: {
        clientInjectOnly: true,
        clientInjectText: '继续执行'
      },
      executeNested
    });

    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    expect(executeNested).not.toHaveBeenCalled();
    expect(result).toEqual({
      body: { ok: true, mode: 'client_inject_only' }
    });
  });

  it('client inject dispatch uses the same normalized metadata builder', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: true });

    const { executeServerToolClientInjectDispatch } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolClientInjectDispatch({
      entryEndpoint: '/v1/messages',
      fallbackEntryEndpoint: '/v1/messages',
      requestId: 'req_followup_dispatch_3',
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'x-routecodex-session-daemon-id': 'daemon_1',
          'x-routecodex-client-tmux-session-id': 'tmux_1'
        }
      }
    });

    expect(result).toEqual({ ok: true });
    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    const injectArgs = mockRunClientInjectionFlowBeforeReenter.mock.calls[0]?.[0] as Record<string, any>;
    expect(injectArgs?.nestedMetadata?.clientDaemonId).toBe('daemon_1');
    expect(injectArgs?.nestedMetadata?.clientTmuxSessionId).toBe('tmux_1');
  });

  it('reenter path preserves full client headers for normal request metadata rebuild', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({ status: 200, body: { headers: input.headers } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_4',
      body: { input: 'continue' },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'user-agent': 'Codex/1.0',
          authorization: 'Bearer test-token',
          'anthropic-session-id': 'sess_1'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.headers).toEqual({
      'user-agent': 'Codex/1.0',
      authorization: 'Bearer test-token',
      'anthropic-session-id': 'sess_1'
    });
    expect((result.body as Record<string, any>)?.headers?.authorization).toBe('Bearer test-token');
  });
});
