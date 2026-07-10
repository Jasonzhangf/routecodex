import { afterEach, describe, expect, it, jest } from '@jest/globals';

const writeDebugErrorDiagArtifact = jest.fn(async () => '/tmp/fake-diag.json');

jest.unstable_mockModule('../../../src/debug/diag/index.js', () => ({
  writeDebugErrorDiagArtifact,
}));

jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/responses-request-bridge.js',
  () => ({
    buildResponsesConversationPortScopeForHttp: jest.fn(),
    buildResponsesPipelineMetadataForHttp: jest.fn(() => ({})),
    captureResponsesInboundToolHistoryErrorsampleForHttp: jest.fn(async () => undefined),
    clearResponsesConversationOnHandlerFailureForHttp: jest.fn(async () => undefined),
    finalizeResponsesPipelineResultForHttp: jest.fn((result) => result),
    planResponsesHandlerStreamForHttp: jest.fn(() => ({ outboundStream: false })),
    prepareResponsesRequestBodyForHttp: jest.fn((payload) => ({ payload, responseIdFromPayload: undefined })),
    prepareResponsesHandlerRuntimeForHttp: jest.fn((args) => ({
      kind: 'ok',
      payload: args.payload,
      requestContext: {},
      pipelineEntryEndpoint: args.entryEndpoint,
      isSubmitToolOutputs: false,
      plannedEntryMode: 'none',
      streamPlan: {
        originalStream: false,
        outboundStream: false,
        inboundStream: false,
        acceptsSse: false,
        requestStartMeta: {},
      },
    })),
  }),
);

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

describe('responses-handler debug diag artifact M1', () => {
  afterEach(() => {
    writeDebugErrorDiagArtifact.mockClear();
  });

  it('routes handler failures through the unified debug diag writer instead of ad hoc fs writes', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const error = Object.assign(new Error('pipeline exploded'), {
      code: 'HTTP_HANDLER_ERROR',
      statusCode: 502,
    });
    const res = makeRes();

    await handleResponses(
      makeReq({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      }),
      res,
      {
        executePipeline: async () => {
          throw error;
        },
        errorHandling: null,
      } as any,
    );

    expect(writeDebugErrorDiagArtifact).toHaveBeenCalledTimes(1);
    expect(writeDebugErrorDiagArtifact).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/v1/responses',
      error,
      requestBody: expect.objectContaining({
        model: 'gpt-5.5',
      }),
    }));
  });
});
