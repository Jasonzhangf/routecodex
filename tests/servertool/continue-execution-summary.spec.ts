import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
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
  test('rejects residual continue_execution reenter instead of carrying execution context', async () => {
    const adapterContext: AdapterContext = bindProviderProtocol({
      requestId: 'req-ce-summary-1',
      entryEndpoint: '/v1/messages',
      sessionId: 'sess-ce-summary-1',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any);

    await expect(runServerToolOrchestration({
      chat: buildContinueExecutionToolCallPayloadWithSummary('Processing data...'),
      adapterContext,
      requestId: 'req-ce-summary-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      clientInjectDispatch: async () => ({ ok: true } as any)
    })).rejects.toThrow('planServertoolEngineRuntimeActionJson native returned invalid action');
  });

  test('rejects no-summary continue_execution residual reenter', async () => {
    const adapterContext: AdapterContext = bindProviderProtocol({
      requestId: 'req-ce-no-summary',
      entryEndpoint: '/v1/messages',
      sessionId: 'sess-ce-no-summary',
      stream: false,
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any);

    await expect(runServerToolOrchestration({
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
      clientInjectDispatch: async () => ({ ok: true } as any)
    })).rejects.toThrow('planServertoolEngineRuntimeActionJson native returned invalid action');
  });
});
