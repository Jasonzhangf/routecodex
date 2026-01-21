import { jest } from '@jest/globals';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('servertool progress logging', () => {
  test('prints yellow progress steps when a servertool followup executes', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId: 'sess-progress-1',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any;

      const responsesPayload: JsonObject = {
        id: 'resp-progress-1',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      };

      // stop_message_flow triggers followup whenever stopMessage is active and finish_reason maps to stop;
      // easiest path is to supply a stopMessageState snapshot directly on adapterContext.
      (adapterContext as any).stopMessageState = {
        stopMessageText: '继续',
        stopMessageMaxRepeats: 1,
        stopMessageUsed: 0
      };

      await runServerToolOrchestration({
        chat: responsesPayload,
        adapterContext,
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        reenterPipeline: async () => {
          return {
            body: {
              id: 'resp-progress-followup-1',
              object: 'response',
              model: 'gpt-test',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
            } as JsonObject
          };
        }
      });

      const lines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      // 38;5;214 = bright yellow/orange used in other logs (e.g. stopMessage tag)
      expect(lines.some((l) => l.includes('\u001b[38;5;214m[servertool][progress 1/5]'))).toBe(true);
      expect(lines.some((l) => l.includes('[servertool][progress 5/5]'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

