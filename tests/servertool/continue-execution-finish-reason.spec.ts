import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('continue_execution finish_reason handling', () => {
  test('sets finish_reason to stop when summary is provided', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-ce-finish-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl-continue-execution-finish',
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
                  id: 'call_continue_execution_finish',
                  type: 'function',
                  function: {
                    name: 'continue_execution',
                    arguments: JSON.stringify({ summary: 'Processing step 1 complete' })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as JsonObject,
      adapterContext,
      requestId: 'req-ce-finish-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      clientInjectDispatch: async () => ({ ok: true } as any)
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('continue_execution_flow');
    
    // Check the decorated chat response
    const chat = orchestration.chat as any;
    expect(chat.choices).toBeTruthy();
    expect(chat.choices[0]).toBeTruthy();
    
    // finish_reason should be changed to 'stop' by decorateFinalChatWithServerToolContext
    expect(chat.choices[0].finish_reason).toBe('stop');
    
    // content should have the summary prepended
    expect(chat.choices[0].message.content).toContain('Processing step 1 complete');
  });
});
