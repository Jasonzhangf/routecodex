import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockResumeResponsesConversation = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(),
  deriveFinishReasonNative: jest.fn(() => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  importCoreDist: jest.fn(),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  materializeLatestResponsesContinuationByScope: jest.fn(),
  planResponsesHandlerEntry: jest.fn(async (payload: Record<string, unknown>, entryEndpoint: string, responseIdFromPath?: string) => ({
    mode: 'submit_tool_outputs',
    payload: {
      ...payload,
      ...(responseIdFromPath ? { response_id: responseIdFromPath } : {})
    },
    responseId: responseIdFromPath,
  })),
  recordResponsesResponseForRequest: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  requireCoreDist: jest.fn(() => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: () => ({}),
  })),
  resumeResponsesConversation: mockResumeResponsesConversation,
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
}));

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('responses-handler submit_tool_outputs SSE error regression', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResumeResponsesConversation.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockResolvedValue(undefined);
  });

  it('keeps submit_tool_outputs relay error on SSE path instead of degrading to JSON', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.5',
        previous_response_id: 'resp_submit_sse_err_1',
        stream: true,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs relay 错误仍保持 SSE' }],
          },
        ],
        tool_outputs: [{ call_id: 'call_submit_sse_err_1', output: 'ok' }],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_sse_err_1',
        routeHint: 'coding',
      },
    });

    const app = express();
    app.use(express.json());
    app.post('/v1/responses/:id/submit_tool_outputs', async (req, res) => {
      await handleResponses(
        req as any,
        res as any,
        {
          executePipeline: async () => {
            throw Object.assign(new Error('submit_tool_outputs relay followup failed'), {
              code: 'INTERNAL_ERROR',
              upstreamCode: 'INTERNAL_ERROR',
              status: 500
            });
          },
          errorHandling: null,
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: req.params.id,
        },
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses/resp_submit_sse_err_1/submit_tool_outputs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          stream: true,
          tool_outputs: [{ call_id: 'call_submit_sse_err_1', output: 'ok' }],
        })
      });
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('Upstream provider error');
      expect(text).toContain('INTERNAL_ERROR');
      expect(text).not.toContain('{"error":');
    });
  });
});
