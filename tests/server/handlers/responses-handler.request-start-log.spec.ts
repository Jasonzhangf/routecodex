import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-request-bridge.js', () => ({
  buildResponsesConversationPortScopeForHttp: jest.fn(() => ({})),
  buildResponsesPipelineMetadataForHttp: jest.fn(() => ({})),
  captureResponsesInboundToolHistoryErrorsampleForHttp: jest.fn(async () => undefined),
  clearResponsesConversationOnHandlerFailureForHttp: jest.fn(async () => undefined),
  clearResponsesConversationByRequestIdForHttp: jest.fn(),
  captureResponsesRequestContextForHttp: jest.fn(),
  recordResponsesResponseForHttp: jest.fn(),
  finalizeResponsesHandlerPayloadForHttp: jest.fn((args: { payload: Record<string, unknown> }) => args.payload),
  prepareResponsesHandlerEntryForHttp: jest.fn(),
  buildResponsesScopeContinuationExpiredErrorForHttp: jest.fn(() => ({
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  })),
  buildResponsesResumeClientErrorForHttp: jest.fn(() => ({
    status: 422,
    body: { error: { message: 'Unable to resume Responses conversation' } },
  })),
  shouldProjectResponsesResumeClientErrorForHttp: jest.fn(() => true),
  finalizeResponsesPipelineResultForHttp: jest.fn((args: { result: unknown }) => args.result),
  planResponsesHandlerStreamForHttp: jest.fn(() => ({
    originalStream: false,
    outboundStream: false,
    inboundStream: false,
    acceptsSse: false,
    requestStartMeta: {}
  })),
  prepareResponsesRequestBodyForHttp: jest.fn((payload: Record<string, unknown>) => ({
    requestBodyMetadata: undefined,
    pipelineBody: payload,
  })),
  prepareResponsesHandlerRuntimeForHttp: jest.fn(async (args: { entryEndpoint: string; payload: Record<string, unknown> }) => {
    const streamPlan = {
      originalStream: false,
      outboundStream: false,
      inboundStream: false,
      acceptsSse: false,
      requestStartMeta: {},
    };
    if (args.entryEndpoint === '/v1/responses.submit_tool_outputs') {
      return {
        kind: 'client_error',
        status: 400,
        body: { error: { message: 'response_id is required for submit_tool_outputs' } },
        streamPlan,
      };
    }
    return {
      kind: 'ok',
      payload: args.payload,
      requestContext: { payload: args.payload, context: { input: [], toolsRaw: [] } },
      pipelineEntryEndpoint: args.entryEndpoint,
      isSubmitToolOutputs: false,
      plannedEntryMode: 'none',
      streamPlan,
    };
  }),
}));

function makeReq(body: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body,
    headers: {},
    query: {},
    path: '/v1/responses',
    originalUrl: '/v1/responses',
    params: {},
    socket: { localPort: 5555 },
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    removeListener: jest.fn(),
  } as any;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    writeHead: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
    on: jest.fn(),
    once: jest.fn(),
  } as any;
}

describe('responses-handler request start logging', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('RED: logs /v1/responses start before runtime availability checks can return early', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const res = makeRes();

    await handleResponses(
      makeReq({ model: 'gpt-5.5', input: [] }),
      res,
      { errorHandling: null } as any,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('▶ [/v1/responses]'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(' started'));
  });

  it('RED: logs submit_tool_outputs start before validation/resume can return early', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const res = makeRes();

    await handleResponses(
      makeReq({ tool_outputs: [{ call_id: 'call_1', output: 'ok' }] }),
      res,
      { executePipeline: jest.fn(), errorHandling: null } as any,
      { entryEndpoint: '/v1/responses.submit_tool_outputs' },
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('▶ [/v1/responses.submit_tool_outputs]'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(' started'));
  });

  it('passes inbound log session color key into request start and pipeline metadata', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const { resolveSessionAnsiColor } = await import('../../../src/utils/session-log-color.js');
    const turnMetadata = JSON.stringify({
      scope: { tmux_session: 'tmux-responses-log-scope' },
      cwd: '/tmp/responses-log-project'
    });
    const req = makeReq({ model: 'gpt-5.5', input: [] });
    req.headers = {
      'user-agent': 'codex-cli',
      'x-codex-turn-metadata': encodeURIComponent(turnMetadata)
    };
    const res = makeRes();
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: { id: 'resp_1', output: [] },
      metadata: {}
    }));

    await handleResponses(req, res, {
      executePipeline,
      errorHandling: null,
      portContext: { matchedPort: 5555, localPort: 5555 }
    } as any);

    const expectedSessionId = 'rcc-session:codex:tmux-responses-log-scope:tmp_responses-log-project';
    const expectedColor = resolveSessionAnsiColor(expectedSessionId);
    const rendered = String(warnSpy.mock.calls.find((call) => String(call[0] ?? '').includes('▶ [/v1/responses]'))?.[0] ?? '');
    const metadata = (executePipeline.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata;

    expect(expectedColor).toBeDefined();
    expect(rendered.startsWith(String(expectedColor))).toBe(true);
    expect(metadata?.logSessionColorKey).toBe(expectedSessionId);
    expect(metadata?.sessionId).toBe(expectedSessionId);
    expect(metadata?.conversationId).toBe(expectedSessionId);
  });

  it('passes responses client_metadata session id into request start and pipeline metadata', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const { resolveSessionAnsiColor } = await import('../../../src/utils/session-log-color.js');
    const sessionId = '019f34fe-5f32-7c71-8931-9ab3d18422a3';
    const req = makeReq({
      model: 'gpt-5.5',
      input: [],
      client_metadata: {
        session_id: sessionId,
        thread_id: sessionId,
        turn_id: '019f3cdf-9e6c-7ab3-bd5e-336ba07236d3'
      }
    });
    req.headers = {
      'user-agent': 'codex-cli'
    };
    const res = makeRes();
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: { id: 'resp_1', output: [] },
      metadata: {}
    }));

    await handleResponses(req, res, {
      executePipeline,
      errorHandling: null,
      portContext: { matchedPort: 5555, localPort: 5555 }
    } as any);

    const expectedColor = resolveSessionAnsiColor(sessionId);
    const rendered = String(warnSpy.mock.calls.find((call) => String(call[0] ?? '').includes('▶ [/v1/responses]'))?.[0] ?? '');
    const metadata = (executePipeline.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata;

    expect(expectedColor).toBeDefined();
    expect(rendered.startsWith(String(expectedColor))).toBe(true);
    expect(metadata?.logSessionColorKey).toBe(sessionId);
    expect(metadata?.sessionId).toBe(sessionId);
    expect(metadata?.conversationId).toBe(sessionId);
  });
});
