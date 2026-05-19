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

function makeCapturedChatRequestWithTwoImages(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '比较这两张图的版本号' },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          { type: 'image_url', image_url: { url: 'https://example.com/2.png' } }
        ]
      }
    ],
    parameters: { temperature: 0.2 }
  } as any;
}

function makeCapturedChatRequestWithVideoUrl(partType: 'video_url' | 'image_url'): JsonObject {
  const part =
    partType === 'video_url'
      ? { type: 'video_url', video_url: { url: 'https://example.com/test.mp4' } }
      : { type: 'image_url', image_url: { url: 'https://example.com/test.mp4' } };

  return {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this video' },
          part
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
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: '图片内容为：\n[Image]:\nvision summary\n\n用户请求：\nwhat is in this image?'
      }
    ]);
  });

  test('vision analysis request uses dedicated prompt with raw user prompt and image only', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-prompt-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-prompt-1',
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

    let analysisHop: any;
    await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-prompt-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          return { body: {} as JsonObject };
        }
        analysisHop = opts;
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

    expect(analysisHop?.body?.messages).toHaveLength(2);
    expect(analysisHop.body.messages[0].role).toBe('system');
    expect(String(analysisHop.body.messages[0].content)).toContain('只是描述图片内容');
    const userContent = analysisHop.body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0]?.type).toBe('input_text');
    expect(String(userContent[0]?.text)).toContain('用户原始提示词如下');
    expect(String(userContent[0]?.text)).toContain('what is in this image?');
    expect(userContent).toHaveLength(2);
  });

  test('vision analysis hop pins exact routed provider and model from adapter context', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-pin-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      providerKey: 'mini27.key1.minimax',
      targetProviderKey: 'mini27.key1.MiniMax-M2.7',
      routecodexPortMode: 'router',
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7'
      },
      capturedChatRequest: {
        ...makeCapturedChatRequestWithImage(),
        model: 'minimax'
      }
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-pin-1',
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

    let analysisHop: any;
    await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-pin-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          return { body: {} as JsonObject };
        }
        analysisHop = opts;
        return {
          body: {
            id: 'chatcmpl-vision-analysis',
            object: 'chat.completion',
            model: 'MiniMax-M2.7',
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

    expect(analysisHop?.body?.model).toBe('MiniMax-M2.7');
    expect(analysisHop?.metadata?.__shadowCompareForcedProviderKey).toBe('mini27.key1.MiniMax-M2.7');
    expect(analysisHop?.metadata?.targetProviderKey).toBe('mini27.key1.MiniMax-M2.7');
    expect(analysisHop?.metadata?.assignedModelId).toBe('MiniMax-M2.7');
    expect(analysisHop?.metadata?.routeHint).toBe('vision');
  });

  test('multi-image followup preserves numbered placeholders and raw prompt', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-multi-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithTwoImages()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-multi-1',
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
    await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-multi-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          sawFollowup = opts;
          return { body: {} as JsonObject };
        }
        return {
          body: {
            id: 'chatcmpl-vision-analysis',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '[Image 1]:\n- 第一张版本号 v1.2.3\n\n[Image 2]:\n- 第二张版本号 v1.2.4'
                },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        };
      }
    });

    expect(sawFollowup?.body?.messages).toEqual([
      {
        role: 'user',
        content: '图片内容为：\n[Image 1]:\n- 第一张版本号 v1.2.3\n\n[Image 2]:\n- 第二张版本号 v1.2.4\n\n用户请求：\n比较这两张图的版本号'
      }
    ]);
  });

  test('routeHint=vision still runs vision two-hop flow', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-route-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      routeHint: 'vision',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-route-1',
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

    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-route-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        if (String(opts.requestId).includes(':vision_followup')) {
          return { body: {} as JsonObject };
        }
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
  });

  test('routeHint=multimodal skips vision two-hop flow', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-multimodal-route-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      routeHint: 'multimodal',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-multimodal-route-1',
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

    let reentered = false;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-multimodal-route-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reentered = true;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reentered).toBe(false);
  });

  test('target supportsMultimodal skips legacy vision two-hop flow even on default route', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-multimodal-target-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      routeHint: 'default',
      supportsMultimodal: true,
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
        supportsMultimodal: true
      },
      __rt: {
        supportsMultimodal: true
      },
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-multimodal-target-1',
      object: 'chat.completion',
      model: 'MiniMax-M2.7',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reentered = false;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-multimodal-target-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reentered = true;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reentered).toBe(false);
  });

  test('does not run vision flow when latest user message uses video_url', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-video-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithVideoUrl('video_url')
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-video-1',
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

    let reenterCalled = 0;
    const reenterPipeline = async () => {
      reenterCalled += 1;
      return { body: {} as JsonObject };
    };
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-video-1',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when latest user image_url is an mp4 url', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-video-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithVideoUrl('image_url')
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-video-2',
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

    let reenterCalled = 0;
    const reenterPipeline = async () => {
      reenterCalled += 1;
      return { body: {} as JsonObject };
    };
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-video-2',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('routeId=vision still runs explicit vision two-hop flow', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-route-bypass',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      routeId: 'vision',
      hasImageAttachment: true,
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-route-bypass',
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

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-vision-route-bypass',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        reenterCalled += 1;
        if (String(opts.requestId).includes(':vision_followup')) {
          return { body: {} as JsonObject };
        }
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
    expect(reenterCalled).toBeGreaterThan(0);
  });

  test('does not run vision flow when runtime metadata marks qwen image generation', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-vision-imagegen-rt',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      __rt: {
        qwenImageGeneration: {
          enabled: true,
          mode: 'edit'
        }
      },
      capturedChatRequest: makeCapturedChatRequestWithImage()
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-imagegen-rt',
      object: 'chat.completion',
      model: 'qwenchat.qwen3.6-plus',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-vision-imagegen-rt',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalled += 1;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });

  test('does not run vision flow when captured request metadata marks qwen image generation', async () => {
    const captured = makeCapturedChatRequestWithImage();
    (captured as any).metadata = {
      qwenImageGeneration: {
        enabled: true,
        mode: 'generate'
      }
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-vision-imagegen-captured',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      hasImageAttachment: true,
      capturedChatRequest: captured
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-vision-imagegen-captured',
      object: 'chat.completion',
      model: 'qwenchat.qwen3.6-plus',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    } as any;

    let reenterCalled = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-vision-imagegen-captured',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalled += 1;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(false);
    expect(reenterCalled).toBe(0);
  });
});
