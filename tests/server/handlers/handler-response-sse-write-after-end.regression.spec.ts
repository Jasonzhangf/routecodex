import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  flushHeaders(): void {
    // no-op for tests
  }
}

describe('handler-response SSE write-after-end regression', () => {
  const originalVerbose = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const originalStageLog = process.env.ROUTECODEX_STAGE_LOG;
  const originalStageVerbose = process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    process.env.ROUTECODEX_STAGE_LOG = '1';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';
    jest.resetModules();
  });

  afterAll(() => {
    if (originalVerbose === undefined) {
      delete process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_HTTP_LOG_VERBOSE = originalVerbose;
    }
    if (originalStageLog === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG;
    } else {
      process.env.ROUTECODEX_STAGE_LOG = originalStageLog;
    }
    if (originalStageVerbose === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_STAGE_LOG_VERBOSE = originalStageVerbose;
    }
  });

  it('does not raise uncaughtException when upstream writes late after response.completed', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const upstream = new PassThrough();
    let output = '';
    let uncaught: Error | undefined;
    const onUncaught = (error: Error) => {
      uncaught = error;
    };
    process.prependOnceListener('uncaughtException', onUncaught);
    res.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('event: response.completed')) {
        res.destroy();
      }
    });

    try {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true,
          },
          usageLogInfo: {
            providerKey: 'XLC.key1.glm-5.2',
            finishReason: 'stop',
          }
        } as any,
        'req_terminal_done_client_close_no_uncaught',
        { forceSSE: true, entryEndpoint: '/v1/responses.submit_tool_outputs' }
      );

      upstream.write('event: response.completed\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_terminal_done_close',
            object: 'response',
            status: 'completed',
            output: [
              {
                id: 'msg_terminal_done_close',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'terminal stop text' }]
              }
            ]
          }
        })}\n\n`
      );
      upstream.write('event: response.done\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.done',
          response: {
            id: 'resp_terminal_done_close',
            object: 'response',
            status: 'completed',
            output: [
              {
                id: 'msg_terminal_done_close',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'terminal stop text' }]
              }
            ]
          }
        })}\n\n`
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      upstream.write('event: response.output_text.delta\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'late after done'
        })}\n\n`
      );
      upstream.end();

      await new Promise<void>((resolve) => setTimeout(resolve, 120));

      expect(output).toContain('event: response.completed');
      expect(uncaught?.message ?? '').not.toContain('write after end');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      upstream.destroy();
      res.destroy();
    }
  });

  it('does not raise uncaughtException when submit_tool_outputs stream closes after response.done and upstream writes late', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const upstream = new PassThrough();
    let output = '';
    let uncaught: Error | undefined;
    const onUncaught = (error: Error) => {
      uncaught = error;
    };
    process.prependOnceListener('uncaughtException', onUncaught);
    res.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('event: response.done')) {
        res.destroy();
      }
    });

    try {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true,
          },
          continuationOwner: 'relay',
          usageLogInfo: {
            providerKey: 'minimonth.key1.MiniMax-M2.7',
            finishReason: 'tool_calls',
          }
        } as any,
        'req_submit_tool_outputs_done_client_close_no_uncaught',
        { forceSSE: true, entryEndpoint: '/v1/responses.submit_tool_outputs' }
      );

      upstream.write('event: response.completed\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_submit_tool_outputs_done_close',
            object: 'response',
            status: 'requires_action',
            output: [
              {
                id: 'fc_submit_tool_outputs_done_close',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_submit_tool_outputs_done_close',
                name: 'exec_command',
                arguments: '{"cmd":"true"}'
              }
            ],
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [
                  {
                    id: 'call_submit_tool_outputs_done_close',
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: '{"cmd":"true"}'
                  }
                ]
              }
            }
          },
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_submit_tool_outputs_done_close',
                  type: 'function_call',
                  name: 'exec_command',
                  arguments: '{"cmd":"true"}'
                }
              ]
            }
          }
        })}\n\n`
      );
      upstream.write('event: response.done\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.done',
          response: {
            id: 'resp_submit_tool_outputs_done_close',
            object: 'response',
            status: 'requires_action',
            output: [
              {
                id: 'fc_submit_tool_outputs_done_close',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_submit_tool_outputs_done_close',
                name: 'exec_command',
                arguments: '{"cmd":"true"}'
              }
            ],
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [
                  {
                    id: 'call_submit_tool_outputs_done_close',
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: '{"cmd":"true"}'
                  }
                ]
              }
            }
          }
        })}\n\n`
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      upstream.write('event: response.output_text.delta\n');
      upstream.write(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'late after submit_tool_outputs done'
        })}\n\n`
      );
      upstream.end();

      await new Promise<void>((resolve) => setTimeout(resolve, 120));

      expect(output).toContain('event: response.done');
      expect(uncaught?.message ?? '').not.toContain('write after end');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      upstream.destroy();
      res.destroy();
    }
  });
});
