import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolAutoHookTraceEvent } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';

describe('servertool auto hook trace', () => {
  test('emits miss traces when no auto hook matches', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-hook-trace-miss',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }]
      }
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-hook-trace-miss',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'done'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-hook-trace-miss',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => ({ body: {} as JsonObject }),
      onAutoHookTrace: (event) => traces.push(event)
    });

    expect(result.mode).toBe('passthrough');
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((event) => event.result === 'match')).toBe(false);
    expect(
      traces.some(
        (event) =>
          event.hookId === 'recursive_detection_guard' &&
          event.result === 'miss' &&
          event.reason === 'predicate_false'
      )
    ).toBe(true);
  });

  test('emits match trace for empty_reply_continue hook', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-hook-trace-empty',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行任务' }]
      }
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-hook-trace-empty',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: ''
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-hook-trace-empty',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => ({ body: {} as JsonObject }),
      onAutoHookTrace: (event) => traces.push(event)
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('empty_reply_continue');

    const match = traces.find((event) => event.hookId === 'empty_reply_continue' && event.result === 'match');
    expect(match).toBeDefined();
    expect(match?.phase).toBe('default');
    expect(match?.priority).toBe(20);
    expect(match?.queue).toBe('A_optional');
    expect(match?.queueIndex).toBeGreaterThan(0);
    expect(match?.queueTotal).toBeGreaterThan(0);
    expect(match?.flowId).toBe('empty_reply_continue');
  });

  test('keeps optional primary hooks in empty -> stop -> clock order', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-hook-trace-order',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }]
      }
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-hook-trace-order',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'done'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-hook-trace-order',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => ({ body: {} as JsonObject }),
      onAutoHookTrace: (event) => traces.push(event)
    });

    expect(result.mode).toBe('passthrough');

    const emptyIndex = traces.findIndex((event) => event.hookId === 'empty_reply_continue' && event.queue === 'A_optional');
    const stopIndex = traces.findIndex((event) => event.hookId === 'stop_message_auto' && event.queue === 'A_optional');
    const clockIndex = traces.findIndex((event) => event.hookId === 'clock_auto' && event.queue === 'A_optional');

    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(clockIndex).toBeGreaterThanOrEqual(0);
    expect(emptyIndex).toBeLessThan(stopIndex);
    expect(stopIndex).toBeLessThan(clockIndex);
  });
});
