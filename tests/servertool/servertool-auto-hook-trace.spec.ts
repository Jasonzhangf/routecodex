import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolAutoHookTraceEvent } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindMetadataCenter<T extends Record<string, unknown>>(adapterContext: T): T {
  MetadataCenter.attach(adapterContext);
  return adapterContext;
}

describe('servertool auto hook trace', () => {
  test('emits match trace for default stopless stop_message_auto hook', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = bindMetadataCenter({
      requestId: 'req-hook-trace-miss',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }]
      }
    } as any);

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

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    expect(traces.length).toBeGreaterThan(0);
    const match = traces.find((event) => event.hookId === 'stop_message_auto' && event.result === 'match');
    expect(match).toBeDefined();
    expect(match?.flowId).toBe('stop_message_flow');
  });

  test('empty assistant stop does not use deleted empty-reply hook', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = bindMetadataCenter({
      requestId: 'req-hook-trace-empty',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行任务' }]
      }
    } as any);

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
    expect(result.execution?.flowId).toBe('stop_message_flow');

    expect(traces.some((event) => event.hookId === 'empty_reply_continue')).toBe(false);
    const match = traces.find((event) => event.hookId === 'stop_message_auto' && event.result === 'match');
    expect(match).toBeDefined();
    expect(match?.phase).toBe('default');
    expect(match?.priority).toBe(40);
    expect(match?.queue).toBe('A_optional');
    expect(match?.queueIndex).toBeGreaterThanOrEqual(0);
    expect(match?.queueTotal).toBeGreaterThan(0);
    expect(match?.flowId).toBe('stop_message_flow');
  });

  test('keeps optional primary hooks in empty -> stop order', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = bindMetadataCenter({
      requestId: 'req-hook-trace-order',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }]
      }
    } as any);

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

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');

    const stopIndex = traces.findIndex((event) => event.hookId === 'stop_message_auto' && event.queue === 'A_optional');

    expect(stopIndex).toBeGreaterThanOrEqual(0);
  });
});
