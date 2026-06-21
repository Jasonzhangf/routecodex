import { describe, expect, test } from '@jest/globals';
import { runAutoHookExecutionQueue } from '../../sharedmodule/llmswitch-core/src/servertool/execution-shell.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolAutoHookTraceEvent,
  ServerToolHandlerContext,
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('execution-shell auto hook failfast', () => {
  test('does not swallow optional auto-hook errors during primary attempt', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const options: ServerSideToolEngineOptions = {
      chatResponse: {
        id: 'chatcmpl-auto-hook-failfast',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }
        ]
      } as JsonObject,
      adapterContext: {
        requestId: 'req-auto-hook-failfast',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-auto-hook-failfast',
      providerProtocol: 'openai-responses',
      primaryAutoHookAttempt: true,
      onAutoHookTrace: (event) => traces.push(event)
    };

    const contextBase: ServerToolHandlerContext = {
      base: options.chatResponse,
      toolCalls: [],
      adapterContext: options.adapterContext,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      capabilities: {
        reenterPipeline: false,
        providerInvoker: false
      }
    };

    await expect(
      runAutoHookExecutionQueue({
        queueName: 'A_optional',
        hooks: [
          {
            id: 'failing_primary_optional_hook',
            phase: 'default',
            priority: 1,
            handler: async () => {
              throw new Error('optional-hook-boom');
            }
          }
        ],
        options,
        contextBase
      })
    ).rejects.toThrow('optional-hook-boom');

    expect(traces).toContainEqual(
      expect.objectContaining({
        hookId: 'failing_primary_optional_hook',
        queue: 'A_optional',
        result: 'error',
        reason: expect.stringContaining('optional-hook-boom')
      })
    );
  });
});
