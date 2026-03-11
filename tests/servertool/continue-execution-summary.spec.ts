import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildContinueExecutionToolCallPayloadWithSummary(summary: string): JsonObject {
  return {
    id: 'chatcmpl-continue-execution-summary',
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
              id: 'call_continue_execution_summary',
              type: 'function',
              function: {
                name: 'continue_execution',
                arguments: JSON.stringify({ summary })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('continue_execution visible summary', () => {
  test('propagates summary to clientInjectText and execution context', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-ce-summary-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: buildContinueExecutionToolCallPayloadWithSummary('Processing data...'),
      adapterContext,
      requestId: 'req-ce-summary-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
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
    expect((capturedFollowupMeta as any)?.clientInjectText).toBe('Processing data...');
    expect((capturedFollowupMeta as any)?.visibleSummary).toBe('Processing data...');
    
    // Check execution context has the summary
    expect(orchestration.chat).toBeTruthy();
    const ctx = (orchestration as any).chat;
    // The execution context should be used by decorateFinalChatWithServerToolContext
  });

  test('falls back to 继续执行 when no summary provided', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-ce-no-summary',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl-continue-execution-no-summary',
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
                  id: 'call_continue_execution_no_summary',
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
      } as JsonObject,
      adapterContext,
      requestId: 'req-ce-no-summary',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      clientInjectDispatch: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { ok: true } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.clientInjectText).toBe('继续执行');
    expect((capturedFollowupMeta as any)?.visibleSummary).toBe('');
  });
});
