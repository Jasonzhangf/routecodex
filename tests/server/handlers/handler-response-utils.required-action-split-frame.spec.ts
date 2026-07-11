import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

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

  json(body: unknown): this {
    this.end(JSON.stringify(body));
    return this;
  }
}

async function waitForEndWithTimeout(stream: PassThrough, timeoutMs: number): Promise<boolean> {
  return await Promise.race<boolean>([
    new Promise<boolean>((resolve, reject) => {
      stream.once('end', () => resolve(true));
      stream.once('error', reject);
      stream.resume();
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

describe('handler-response-utils required_action transport-only regression', () => {
  it('projects split response.required_action SSE frames through the Rust client projection owner', async () => {
    const previousProjectionTimeout = process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    const previousTerminalCloseTimeout = process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    const previousTotalTimeout = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = '40';
    process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = '50';
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '1500';
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const requestId = 'openai-responses-router-gpt-5.3-codex-native-sse-required-action-split-frame';
    const responseId = 'resp_native_sse_required_action_split_frame_1';
    const callId = 'call_native_sse_required_action_split_frame_1';

    async function* splitRequiredActionStream(): AsyncGenerator<string> {
      yield 'event: response.required_action\n';
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield `data: ${JSON.stringify({
        type: 'response.required_action',
        response: { id: responseId, object: 'response', status: 'requires_action' },
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
          }
        }
      })}\n\n`;
    }

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from(splitRequiredActionStream()),
        body: {
          id: responseId,
          object: 'response',
          status: 'requires_action',
          output: [
            {
              type: 'function_call',
              call_id: callId,
              id: `fc_${callId}`,
              name: 'update_plan',
              arguments: '{"plan":[{"step":"split-frame"}]}'
            }
          ],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking/gateway-priority-5555-thinking',
          sessionId: 'rcc-native-sse-required-action-split-frame'
        },
        metadata: { outboundStream: true }
      } as any,
      requestId,
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.3-codex',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          context: {
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          sessionId: 'rcc-native-sse-required-action-split-frame'
        }
      }
    );

    const ended = await waitForEndWithTimeout(res, 1500);
    expect(ended).toBe(true);
    const text = chunks.join('');
    expect(text).not.toContain('event: response.required_action');
    expect(text).toContain('event: response.output_item.added');
    expect(text).toContain('event: response.function_call_arguments.delta');
    expect(text).toContain('event: response.function_call_arguments.done');
    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
    expect(text).toContain('data: [DONE]');
    expect(text.indexOf('event: response.output_item.done')).toBeLessThan(text.indexOf('event: response.completed'));
    expect(text.indexOf('event: response.completed')).toBeLessThan(text.indexOf('event: response.done'));
    expect(text.indexOf('event: response.done')).toBeLessThan(text.indexOf('data: [DONE]'));
    if (previousProjectionTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = previousProjectionTimeout;
    }
    if (previousTerminalCloseTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = previousTerminalCloseTimeout;
    }
    if (previousTotalTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = previousTotalTimeout;
    }
  });
});
