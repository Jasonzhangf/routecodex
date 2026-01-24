import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
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
  test('re-enters hub with a canonical chat-like followup body (messages, non-stream)', async () => {
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

    let sawFollowup: any;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          sawFollowup = opts;
          return {
            body: {
              id: 'chatcmpl-vision-followup-1',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop'
                }
              ]
            } as JsonObject
          };
        }
        // backend :vision analysis hop
        return {
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
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('vision_flow');
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
    expect(JSON.stringify(body.messages)).toContain('[Vision] vision summary');
  });
});
