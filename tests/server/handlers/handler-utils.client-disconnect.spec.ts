import { beforeAll, describe, expect, it, jest } from '@jest/globals';

const mockReportRouteError = jest.fn();

jest.unstable_mockModule('../../../src/error-handling/route-error-hub.js', () => ({
  reportRouteError: mockReportRouteError,
}));

let respondWithPipelineError: typeof import('../../../src/server/handlers/handler-utils.js').respondWithPipelineError;
let writeStartedSsePipelineError: typeof import('../../../src/server/handlers/handler-utils.js').writeStartedSsePipelineError;

function buildClientDisconnectError() {
  return Object.assign(
    new Error('HTTP 499: {"error":{"code":"HTTP_499","status":499}}'),
    {
      code: 'HTTP_499',
      status: 499,
      statusCode: 499,
      requestId: 'req_client_disconnect',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      response: {
        data: {
          error: {
            code: 'HTTP_499',
            status: 499,
            message: 'client abort request',
          },
        },
      },
      details: {
        upstreamCode: 'HTTP_499',
        upstreamMessage: 'client abort request',
        providerKey: 'asxs.crsa.gpt-5.4-mini',
      },
    },
  );
}

describe('handler-utils client_disconnect projection boundary', () => {
  beforeAll(async () => {
    const mod = await import('../../../src/server/handlers/handler-utils.js');
    respondWithPipelineError = mod.respondWithPipelineError;
    writeStartedSsePipelineError = mod.writeStartedSsePipelineError;
  });

  it('[forward] respondWithPipelineError ends response without JSON body for client_disconnect', async () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn().mockReturnThis();
    const write = jest.fn().mockReturnValue(true);
    const end = jest.fn().mockReturnThis();
    const setHeader = jest.fn().mockReturnThis();
    const res = {
      statusCode: 200,
      status,
      json,
      write,
      end,
      setHeader,
    };

    await respondWithPipelineError(
      res as never,
      {} as never,
      buildClientDisconnectError(),
      '/v1/responses',
      'req_client_disconnect',
    );

    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(mockReportRouteError).not.toHaveBeenCalled();
  });

  it('[forward] writeStartedSsePipelineError closes started SSE without error frame for client_disconnect', async () => {
    const write = jest.fn().mockReturnValue(true);
    const end = jest.fn().mockReturnThis();
    const res = {
      write,
      end,
    };

    await writeStartedSsePipelineError(
      res as never,
      {} as never,
      buildClientDisconnectError(),
      '/v1/responses',
      'req_client_disconnect_started',
    );

    expect(write).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(mockReportRouteError).not.toHaveBeenCalled();
  });
});
