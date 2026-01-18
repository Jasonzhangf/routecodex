import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
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
  test('builds followup payload compatible with /v1/responses', async () => {
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

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-iflow-retry-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('iflow_model_error_retry');
    const followup = (result.execution as any)?.followup;
    expect(followup).toBeTruthy();
    const payload = followup.payload as any;
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.messages).toBeUndefined();
    expect(payload.stream).toBe(false);
    expect(payload.parameters?.stream).toBeUndefined();
  });
});

