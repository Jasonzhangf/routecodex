import { runServerSideToolEngine } from '../../src/conversion/hub/response/server-side-tools.js';
import type { ProviderInvoker } from '../../src/conversion/hub/response/server-side-tools.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';

describe('ServerSideToolEngine web_search loop', () => {
  test('passthrough when no web_search tool call', async () => {
    const chatResponse = {
      id: 'chatcmpl-test',
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

    const ctx: AdapterContext = {
      requestId: 'req-test',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-test',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.finalChatResponse).toBe(chatResponse);
  });

  test('detects web_search tool call but remains passthrough without invoker', async () => {
    const chatResponse = {
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
                  arguments: JSON.stringify({ query: 'today news' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const ctx: AdapterContext = {
      requestId: 'req-web',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web',
      providerProtocol: 'openai-chat'
      // no providerInvoker → should be no-op
    });

    expect(result.mode).toBe('passthrough');
    expect(result.finalChatResponse).toBe(chatResponse);
  });


  test('normalizes websearch alias to canonical web_search handler', async () => {
    const chatResponse = {
      id: 'chatcmpl-web-alias',
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
                id: 'call_web_alias_1',
                type: 'function',
                function: {
                  name: 'websearch',
                  arguments: JSON.stringify({ query: 'today news' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const ctx: AdapterContext = {
      requestId: 'req-web-alias',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      webSearch: {
        engines: [
          {
            id: 'stub',
            providerKey: 'stub-backend',
            description: 'stub backend',
            default: true
          }
        ],
        injectPolicy: 'always'
      } as any,
      target: {
        providerKey: 'main-backend',
        modelId: 'gpt-4o-mini'
      } as any
    };

    const providerInvoker: ProviderInvoker = async (options) => ({
      providerResponse: options.providerKey === 'stub-backend'
        ? {
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
          }
        : {
            id: 'final-resp',
            model: options.modelId ?? 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'final answer from main model'
                },
                finish_reason: 'stop'
              }
            ]
          }
    });

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web-alias',
      providerProtocol: 'openai-chat',
      providerInvoker
    });

    expect(result.mode).toBe('web_search_flow');
  });

  test('uses providerInvoker hook when supplied (stubbed roundtrip)', async () => {
    const chatResponse = {
      id: 'chatcmpl-web2',
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
                id: 'call_web_2',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'today news' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const ctx: AdapterContext = {
      requestId: 'req-web2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      webSearch: {
        engines: [
          {
            id: 'stub',
            providerKey: 'stub-backend',
            description: 'stub backend',
            default: true
          }
        ],
        injectPolicy: 'always'
      } as any,
      target: {
        providerKey: 'main-backend',
        modelId: 'gpt-4o-mini'
      } as any
    };

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      if (options.providerKey === 'stub-backend') {
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
          }
        };
      }
      return {
        providerResponse: {
          id: 'final-resp',
          model: options.modelId ?? 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer from main model'
              },
              finish_reason: 'stop'
            }
          ]
        }
      };
    };

    // enable server-side tools for this test
    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: ctx,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-web2',
      providerProtocol: 'openai-chat',
      providerInvoker
    });

    expect(result.mode).toBe('web_search_flow');
    expect(invocations.length).toBe(2); // backend + follow-up
    const finalChoices = (result.finalChatResponse as any).choices || [];
    const finalContent = finalChoices[0]?.message?.content;
    expect(finalContent).toBe('final answer from main model');
  });

  test('uses Gemini backend and maps search summary for web_search', async () => {
    const chatResponse = {
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
      target: {
        providerKey: 'gemini-cli.gemini-2.5-pro',
        modelId: 'gemini-2.5-pro'
      } as any
    };

    const invocations: any[] = [];
    const providerInvoker: ProviderInvoker = async (options) => {
      invocations.push(options);
      if (options.providerKey === 'gemini-cli.gemini-2.5-flash-lite') {
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
      }

      return {
        providerResponse: {
          id: 'chatcmpl-main-gemini',
          model: options.modelId ?? 'gemini-2.5-pro',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer with web search'
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
      requestId: 'req-web-gemini',
      providerProtocol: 'gemini-chat',
      providerInvoker
    });

    expect(result.mode).toBe('web_search_flow');
    expect(invocations.length).toBe(2);

    const backendCall = invocations[0];
    expect(backendCall.providerKey).toBe('gemini-cli.gemini-2.5-flash-lite');
    expect(backendCall.payload.model).toBe('gemini-2.5-flash-lite');

    const finalChoices = (result.finalChatResponse as any).choices || [];
    const finalContent = finalChoices[0]?.message?.content;
    expect(finalContent).toBe('final answer with web search');
  });

  test('web_search server tool works across GLM, Gemini and IFlow backends (providerInvoker loop)', async () => {
    const engines = [
      {
        label: 'glm',
        adapterProtocol: 'openai-chat',
        engineConfig: {
          id: 'glm-4.7',
          providerKey: 'glm-search.backend',
          description: 'GLM 4.7 web search backend'
        },
        target: {
          providerKey: 'openai-primary',
          modelId: 'gpt-4o-mini'
        }
      },
      {
        label: 'gemini',
        adapterProtocol: 'gemini-chat',
        engineConfig: {
          id: 'gemini-2.5-flash-lite',
          providerKey: 'gemini-cli.gemini-2.5-flash-lite',
          description: 'Gemini 2.5 Flash Lite web search backend'
        },
        target: {
          providerKey: 'gemini-cli.gemini-2.5-pro',
          modelId: 'gemini-2.5-pro'
        }
      },
      {
        label: 'iflow',
        adapterProtocol: 'openai-chat',
        engineConfig: {
          id: 'iFlow-ROME-30BA3B',
          providerKey: 'iflow.iFlow-ROME-30BA3B',
          description: 'IFlow ROME 30B web search backend'
        },
        target: {
          providerKey: 'iflow-primary',
          modelId: 'iFlow-ROME-30BA3B'
        }
      }
    ] as const;

    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';

    for (const { label, adapterProtocol, engineConfig, target } of engines) {
      const chatResponse = {
        id: `chatcmpl-web-${label}`,
        object: 'chat.completion',
        model: target.modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_web_${label}`,
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'today news' })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      };

      const ctx: AdapterContext = {
        requestId: `req-web-${label}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: adapterProtocol,
        webSearch: {
          engines: [
            {
              id: engineConfig.id,
              providerKey: engineConfig.providerKey,
              description: engineConfig.description,
              default: true
            }
          ],
          injectPolicy: 'always'
        } as any,
        target: {
          providerKey: target.providerKey,
          modelId: target.modelId
        } as any
      };

      const invocations: any[] = [];
      const providerInvoker: ProviderInvoker = async (options) => {
        invocations.push(options);
        if (options.providerKey === engineConfig.providerKey) {
          if (label === 'gemini') {
            const payload = options.payload as any;
            expect(payload.model).toBe(engineConfig.id);
            expect(Array.isArray(payload.tools)).toBe(true);
            expect(payload.tools[0].googleSearch).toBeDefined();
            return {
              providerResponse: {
                id: `search-resp-${label}`,
                model: engineConfig.id,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: `search-summary-${label}`
                    },
                    finish_reason: 'stop'
                  }
                ]
              } as any
            };
          }

          if (label === 'iflow') {
            const payload = options.payload as any;
            expect(payload).toHaveProperty('data');
            expect(payload).toHaveProperty('metadata');
            expect(payload.metadata.iflowWebSearch).toBe(true);
            expect(payload.metadata.entryEndpoint).toBe('/chat/retrieve');
            expect(options.entryEndpoint).toBe('/v1/chat/retrieve');

            const body = payload.data;
            expect(body.query).toBe('today news');

            return {
              providerResponse: {
                data: [
                  {
                    title: 'hit-1',
                    url: 'https://example.com/hit-1',
                    time: '2024-01-01',
                    abstractInfo: 'iflow web search hit'
                  }
                ],
                success: true,
                message: 'ok-from-iflow'
              } as any
            };
          }

          const payload = options.payload as any;
          expect(payload.model).toBe(engineConfig.id);
          expect(payload.web_search).toBeDefined();
          expect(payload.web_search.query).toBe('today news');

          return {
            providerResponse: {
              id: `search-resp-${label}`,
              model: engineConfig.id,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: `search-summary-${label}`
                  },
                  finish_reason: 'stop'
                }
              ]
            } as any
          };
        }

        expect(options.providerKey).toBe(target.providerKey);
        return {
          providerResponse: {
            id: `final-resp-${label}`,
            model: options.modelId ?? target.modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `final answer from main model (${label})`
                },
                finish_reason: 'stop'
              }
            ]
          } as any
        };
      };

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext: ctx,
        entryEndpoint: '/v1/chat/completions',
        requestId: ctx.requestId,
        providerProtocol: adapterProtocol,
        providerInvoker
      });

      expect(result.mode).toBe('web_search_flow');
      expect(invocations.length).toBe(2);

      const finalChoices = (result.finalChatResponse as any).choices || [];
      const finalContent = finalChoices[0]?.message?.content;
      expect(finalContent).toBe(
        `final answer from main model (${label})`
      );
    }
  });
});
