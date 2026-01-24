import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function makeCapturedChatRequest(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { temperature: 0.2 }
  } as any;
}

describe('iflow_model_error_retry servertool followup (entry-aware)', () => {
  test('re-enters hub with a canonical chat-like followup body (messages, non-stream)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-iflow-retry-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerKey: 'iflow.key1.test-model',
      capturedChatRequest: makeCapturedChatRequest()
    } as any;

    const chatResponse: JsonObject = {
      error_code: 123,
      msg: 'upstream business error'
    } as any;

    let sawFollowup: any;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-iflow-retry-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowup = opts;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('iflow_model_error_retry');
    const followupMeta = sawFollowup?.metadata as any;
    const followupFlag =
      followupMeta?.serverToolFollowup ?? followupMeta?.__rt?.serverToolFollowup;
    expect(followupFlag).toBe(true);
    expect(sawFollowup?.metadata?.stream).toBe(false);

    const body = sawFollowup?.body as any;
    expect(body).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.stream).toBe(false);
    expect(body.parameters?.stream).toBeUndefined();
  });
});
