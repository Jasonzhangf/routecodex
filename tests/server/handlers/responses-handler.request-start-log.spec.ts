import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  captureResponsesRequestContextForRequest: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  importCoreDist: jest.fn(),
  recordResponsesResponseForRequest: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  resumeResponsesConversation: jest.fn(),
  requireCoreDist: jest.fn(() => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: () => ({}),
  })),
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
});
