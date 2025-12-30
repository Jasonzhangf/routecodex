import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
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

    const ctx: AdapterContext = {
      ...baseCtx,
      requestId: 'req-web-stub',
      webSearch: {
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
      } as any
    };

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
      } as any
    };

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
