import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildContinueExecutionToolCallPayload(): JsonObject {
  return {
    id: 'chatcmpl-continue-execution-1',
    object: 'chat.completion',
    model: 'kimi-k2.5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_continue_execution_1',
              type: 'function',
              function: {
                name: 'continue_execution',
                arguments: '{}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('continue_execution servertool followup provider pin', () => {
  test('pins followup to original provider key to avoid alias drift', async () => {
    const providerKey = 'iflow.1-186.kimi-k2.5';
    const adapterContext: AdapterContext = {
      requestId: 'req-continue-pin-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey,
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行，不要中断总结。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    let reenterCalled = false;
    const orchestration = await runServerToolOrchestration({
      chat: buildContinueExecutionToolCallPayload(),
      adapterContext,
      requestId: 'req-continue-pin-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async () => {
        reenterCalled = true;
        return {
          body: {
            id: 'chatcmpl-continue-followup-1',
            object: 'chat.completion',
            model: 'kimi-k2.5',
            choices: [{ index: 0, message: { role: 'assistant', content: '继续执行中' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      },
      clientInjectDispatch: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { ok: true } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('continue_execution_flow');
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(providerKey);
    expect(reenterCalled).toBe(false);
  });

  test('keeps followup unpinned when adapter context has no provider key', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-continue-pin-2',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    let reenterCalled = false;
    const orchestration = await runServerToolOrchestration({
      chat: buildContinueExecutionToolCallPayload(),
      adapterContext,
      requestId: 'req-continue-pin-2',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async () => {
        reenterCalled = true;
        return {
          body: {
            id: 'chatcmpl-continue-followup-2',
            object: 'chat.completion',
            model: 'kimi-k2.5',
            choices: [{ index: 0, message: { role: 'assistant', content: '继续' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      },
      clientInjectDispatch: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { ok: true } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('continue_execution_flow');
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBeUndefined();
    expect(reenterCalled).toBe(false);
  });
});
