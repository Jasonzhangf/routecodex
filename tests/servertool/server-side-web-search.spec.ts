import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { executeWebSearchBackendPlan } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/web-search.js';
import type {
  ProviderInvoker,
  ServerSideToolEngineOptions
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { applyGeminiWebSearchCompat } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-web-search.js';

describe('ServerTool web_search engine (generic)', () => {
  const baseCtx: AdapterContext = {
    requestId: 'req-base',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat'
  } as any;

  function makeCapturedChatRequest(): JsonObject {
    return {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search',
            parameters: { type: 'object' }
          }
        }
      ],
      parameters: { temperature: 0.2 }
    } as any;
  }

  function buildChatWithToolCall(query: string): JsonObject {
    return {
      id: 'chatcmpl-web',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_web_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    } as JsonObject;
  }

  test('passthrough when no web_search tool call', async () => {
    const chatResponse: JsonObject = {
      id: 'chatcmpl-no-tool',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const options: ServerSideToolEngineOptions = {
      chatResponse,
      adapterContext: baseCtx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-no-tool',
      providerProtocol: 'openai-chat'
    };

    const result = await runServerSideToolEngine(options);

    expect(result.mode).toBe('passthrough');
    expect(result.finalChatResponse).toBe(chatResponse);
  });

  test('detects web_search tool call but remains passthrough without invoker or config', async () => {
    const chatResponse = buildChatWithToolCall('today news');

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-no-invoker'
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-no-invoker',
      providerProtocol: 'openai-chat'
      // no providerInvoker + no webSearch config → no-op
    });

    expect(result.mode).toBe('passthrough');
    expect(result.finalChatResponse).toBe(chatResponse);
  });

  test('performs search via providerInvoker and injects tool_outputs', async () => {
    const chatResponse = buildChatWithToolCall('today news');

    const webSearch = {
      engines: [
        {
          id: 'stub',
          providerKey: 'stub-backend',
          description: 'stub backend',
          default: true
        }
      ],
      injectPolicy: 'always',
      force: true
    } as any;

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-stub',
      capturedChatRequest: makeCapturedChatRequest(),
      webSearch,
      __rt: {
        webSearch
      }
    } as any;

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      return {
        providerResponse: {
          id: 'search-resp',
          model: 'stub-backend-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'stub search result'
              },
              finish_reason: 'stop'
            }
          ]
        } as any
      };
    };

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-stub',
      providerProtocol: 'openai-chat',
      providerInvoker
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('web_search_flow');
    expect(Array.isArray((result.execution as any)?.followup?.injection?.ops)).toBe(true);
    expect(invocations.length).toBe(1);

    const patched = result.finalChatResponse as any;
    const outputs = Array.isArray(patched.tool_outputs) ? patched.tool_outputs : [];
    expect(outputs.length).toBe(1);
    expect(outputs[0].name).toBe('web_search');
    expect(outputs[0].tool_call_id).toBe('call_web_1');

    const contentObj = JSON.parse(outputs[0].content);
    expect(contentObj.summary).toBe('stub search result');
    expect(contentObj.engine).toBe('stub');
  });

  test('builds entry-aware followup payload for /v1/responses', async () => {
    const chatResponse = buildChatWithToolCall('today news');

    const webSearch = {
      engines: [
        {
          id: 'stub',
          providerKey: 'stub-backend',
          description: 'stub backend',
          default: true
        }
      ],
      injectPolicy: 'always',
      force: true
    } as any;

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-responses',
      entryEndpoint: '/v1/responses',
      capturedChatRequest: makeCapturedChatRequest(),
      webSearch,
      __rt: {
        webSearch
      }
    } as any;

    const providerInvoker: ProviderInvoker = async () => {
      return {
        providerResponse: {
          id: 'search-resp',
          model: 'stub-backend-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'stub search result'
              },
              finish_reason: 'stop'
            }
          ]
        } as any
      };
    };

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    let sawFollowup: any;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/responses',
      requestId: 'req-web-responses',
      providerProtocol: 'openai-chat',
      providerInvoker,
      reenterPipeline: async (opts: any) => {
        sawFollowup = opts;
        return { body: {} as JsonObject };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('web_search_flow');
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
    const payloadText = JSON.stringify(body.messages);
    expect(payloadText).toContain('web_search');
    expect(payloadText).toContain('call_web_1');
  });

  test('falls back to next engine on backend failure', async () => {
    const chatResponse = buildChatWithToolCall('fallback search');

    const webSearch = {
      engines: [
        {
          id: 'bad',
          providerKey: 'backend.bad',
          description: 'bad backend',
          default: true
        },
        {
          id: 'good',
          providerKey: 'backend.good',
          description: 'good backend'
        }
      ],
      injectPolicy: 'always',
      force: true
    } as any;

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-fallback',
      webSearch,
      __rt: {
        webSearch
      }
    } as any;

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      if (options.providerKey === 'backend.bad') {
        throw new Error('backend crashed');
      }
      return {
        providerResponse: {
          id: 'search-resp-good',
          model: 'backend.good',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'good backend search result'
              },
              finish_reason: 'stop'
            }
          ]
        } as any
      };
    };

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-fallback',
      providerProtocol: 'openai-chat',
      providerInvoker
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('web_search_flow');
    expect(invocations.length).toBe(2);
    expect(invocations[0].providerKey).toBe('backend.bad');
    expect(invocations[1].providerKey).toBe('backend.good');

    const patched = result.finalChatResponse as any;
    const outputs = Array.isArray(patched.tool_outputs) ? patched.tool_outputs : [];
    expect(outputs.length).toBe(1);
    const contentObj = JSON.parse(outputs[0].content);
    expect(contentObj.engine).toBe('good');
    expect(contentObj.summary).toBe('good backend search result');
  });

  test('skips engines with serverToolsDisabled', async () => {
    const chatResponse = buildChatWithToolCall('skip disabled engine');

    const webSearch = {
      engines: [
        {
          id: 'disabled',
          providerKey: 'backend.disabled',
          description: 'disabled backend',
          default: true,
          serverToolsDisabled: true
        },
        {
          id: 'enabled',
          providerKey: 'backend.enabled',
          description: 'enabled backend'
        }
      ],
      injectPolicy: 'always',
      force: true
    } as any;

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-disabled',
      webSearch,
      __rt: {
        webSearch
      }
    } as any;

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      return {
        providerResponse: {
          id: 'search-resp-enabled',
          model: 'backend.enabled',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'enabled backend search result'
              },
              finish_reason: 'stop'
            }
          ]
        } as any
      };
    };

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-disabled',
      providerProtocol: 'openai-chat',
      providerInvoker
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('web_search_flow');
    expect(invocations.length).toBe(1);
    expect(invocations[0].providerKey).toBe('backend.enabled');

    const patched = result.finalChatResponse as any;
    const outputs = Array.isArray(patched.tool_outputs) ? patched.tool_outputs : [];
    expect(outputs.length).toBe(1);
    const contentObj = JSON.parse(outputs[0].content);
    expect(contentObj.engine).toBe('enabled');
    expect(contentObj.summary).toBe('enabled backend search result');
  });

  test('iflow web_search backend uses retrieve route and does not bind model', async () => {
    const invocations: any[] = [];
    const result = await executeWebSearchBackendPlan({
      plan: {
        kind: 'web_search',
        requestIdSuffix: ':web_search',
        query: 'routecodex',
        recency: 'day',
        resultCount: 5,
        engines: [
          {
            id: 'iflow-engine',
            providerKey: 'iflow.1-186.minimax-m2.5',
            searchEngineList: ['GOOGLE']
          }
        ]
      } as any,
      options: {
        chatResponse: {},
        adapterContext: { requestId: 'req-iflow-web', providerProtocol: 'openai-chat' } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-iflow-web',
        providerProtocol: 'openai-chat',
        providerInvoker: async (options: any) => {
          invocations.push(options);
          return {
            providerResponse: {
              success: true,
              data: [
                {
                  title: 'RouteCodex',
                  link: 'https://example.com',
                  content: 'result'
                }
              ]
            }
          };
        }
      } as any
    });

    expect(result.kind).toBe('web_search');
    expect(invocations.length).toBe(1);
    const call = invocations[0];
    expect(call.entryEndpoint).toBe('/v1/chat/retrieve');
    expect(call.modelId).toBeUndefined();
    expect(call.payload?.model).toBeUndefined();
    expect(call.payload?.metadata?.iflowWebSearch).toBe(true);
    expect(call.payload?.data?.query).toBe('routecodex');
  });
});

describe('ServerTool web_search engine (Gemini backend)', () => {
  test('invokes Gemini search backend via providerInvoker', async () => {
    const chatResponse: JsonObject = {
      id: 'chatcmpl-web-gemini',
      object: 'chat.completion',
      model: 'gemini-2.5-pro',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_web_gemini_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: '今天的国际新闻' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const ctx: AdapterContext = {
      requestId: 'req-web-gemini',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      webSearch: {
        engines: [
          {
            id: 'gemini-2.5-flash-lite',
            providerKey: 'gemini-cli.gemini-2.5-flash-lite',
            description: 'Gemini 2.5 Flash Lite web search backend',
            default: true
          }
        ],
        injectPolicy: 'always'
      } as any,
      __rt: {
        webSearch: {
        engines: [
          {
            id: 'gemini-2.5-flash-lite',
            providerKey: 'gemini-cli.gemini-2.5-flash-lite',
            description: 'Gemini 2.5 Flash Lite web search backend',
            default: true
          }
        ],
        injectPolicy: 'always'
        } as any
      }
    } as any;

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      return {
        providerResponse: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'search-summary-from-gemini' }]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
          }
        } as any
      };
    };

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-gemini',
      providerProtocol: 'gemini-chat',
      providerInvoker
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('web_search_flow');
    expect(invocations.length).toBe(1);

    const backendCall = invocations[0];
    expect(backendCall.providerKey).toBe('gemini-cli.gemini-2.5-flash-lite');
    expect(backendCall.providerProtocol).toBe('gemini-chat');
    expect(backendCall.entryEndpoint).toBe('/v1/models/gemini:generateContent');

    const payload = backendCall.payload as any;
    expect(payload.model).toBe('gemini-2.5-flash-lite');
    expect(Array.isArray(payload.contents)).toBe(true);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools[0]).toHaveProperty('googleSearch');

    const patched = result.finalChatResponse as any;
    const outputs = Array.isArray(patched.tool_outputs) ? patched.tool_outputs : [];
    expect(outputs.length).toBe(1);
    const contentObj = JSON.parse(outputs[0].content);
    expect(contentObj.summary).toBe('search-summary-from-gemini');
  });
});

describe('Gemini web_search compat (googleSearch injection)', () => {
  test('injects googleSearch tool when none present on web_search route', () => {
    const payload: JsonObject = {
      model: 'gemini-2.5-flash-lite',
      web_search: {
        query: 'test',
        recency: 'oneDay',
        count: 5
      }
    } as any;

    const ctx: AdapterContext = {
      requestId: 'req-compat-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      routeId: 'web_search'
    } as any;

    const result = applyGeminiWebSearchCompat(payload, ctx);

    expect((result as any).web_search).toBeUndefined();
    expect(Array.isArray((result as any).tools)).toBe(true);
    const tools = (result as any).tools as any[];
    expect(tools.length).toBe(1);
    expect(tools[0]).toHaveProperty('googleSearch');
  });

  test('preserves existing googleSearch tool and does not duplicate', () => {
    const payload: JsonObject = {
      model: 'gemini-2.5-flash-lite',
      tools: [{ googleSearch: { foo: 'bar' } }]
    } as any;

    const ctx: AdapterContext = {
      requestId: 'req-compat-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      routeId: 'web_search'
    } as any;

    const result = applyGeminiWebSearchCompat(payload, ctx);

    const tools = (result as any).tools as any[];
    expect(tools.length).toBe(1);
    expect(tools[0].googleSearch).toEqual({ foo: 'bar' });
  });

  test('drops non-web_search functionDeclarations and falls back to googleSearch', () => {
    const payload: JsonObject = {
      model: 'gemini-2.5-flash-lite',
      tools: [
        {
          functionDeclarations: [
            { name: 'exec_command', parameters: {} }
          ]
        }
      ]
    } as any;

    const ctx: AdapterContext = {
      requestId: 'req-compat-3',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      routeId: 'web_search'
    } as any;

    const result = applyGeminiWebSearchCompat(payload, ctx);

    const tools = (result as any).tools as any[];
    expect(tools.length).toBe(1);
    expect(tools[0]).toHaveProperty('googleSearch');
  });
});
