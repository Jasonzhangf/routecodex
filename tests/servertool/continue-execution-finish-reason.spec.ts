import { runServerToolOrchestrationShell as runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const metadataCenterSymbol = Symbol.for('routecodex.metadataCenter');

function bindProviderProtocol(adapterContext: AdapterContext): AdapterContext {
  Reflect.set(adapterContext as any, metadataCenterSymbol, {
    readRuntimeControl: () => ({ providerProtocol: 'anthropic-messages' }),
    readRequestTruth: () => ({ sessionId: (adapterContext as any).sessionId })
  });
  return adapterContext;
}

describe('continue_execution finish_reason handling', () => {
  test('does not rewrite finish_reason when summary is provided', async () => {
    const adapterContext: AdapterContext = bindProviderProtocol({
      requestId: 'req-ce-finish-1',
      entryEndpoint: '/v1/messages',
      sessionId: 'sess-ce-finish-1',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any);

    await expect(runServerToolOrchestration({
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
    })).rejects.toThrow('planServertoolEngineRuntimeActionJson native returned invalid action');
  });
});
