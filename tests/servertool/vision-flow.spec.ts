import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function makeCapturedChatRequestWithImage(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
        ]
      }
    ],
    parameters: { temperature: 0.2 }
  } as any;
}

describe('vision_auto servertool followup (entry-aware)', () => {
  test('builds followup payload compatible with /v1/responses', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({
        body: {
          id: 'chatcmpl-vision-analysis',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'vision summary' },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject
      })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('vision_flow');
    const followup = (result.execution as any)?.followup;
    expect(followup).toBeTruthy();
    const payload = followup.payload as any;
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.messages).toBeUndefined();
    expect(payload.stream).toBe(false);
    expect(payload.parameters?.stream).toBeUndefined();
  });
});

