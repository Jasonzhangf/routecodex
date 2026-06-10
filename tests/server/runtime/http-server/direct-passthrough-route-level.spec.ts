import { describe, expect, it, jest } from '@jest/globals';

describe('direct passthrough route-level', () => {
  it('HTTP BLACKBOX: provider-mode keyless chat binding preserves client model', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const runtimeKey = 'opencode-zen-free.key1.deepseek-v4-flash-free';
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          if (payload.model !== 'deepseek-v4-flash') {
            return {
              status: 401,
              data: {
                error: {
                  type: 'ModelError',
                  message: `Model ${String(payload.model)} is not supported`,
                },
              },
            };
          }
          return {
            status: 200,
            data: {
              id: 'chatcmpl_provider_direct_keyless_model_blackbox',
              object: 'chat.completion',
              model: payload.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        }),
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'provider',
      protocolBehavior: 'auto',
      providerBinding: 'opencode-zen-free.deepseek-v4-flash-free',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'chatcmpl_provider_direct_keyless_model_blackbox',
        model: 'deepseek-v4-flash',
      }));
      expect(sentPayload?.model).toBe('deepseek-v4-flash');
    } finally {
      await server.stop();
    }
  }, 15000);

  it('HTTP BLACKBOX: provider-mode chat direct preserves stream flag when stream_options is present', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const runtimeKey = 'opencode-zen-free.key1.deepseek-v4-flash-free';
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          if (payload.stream_options && payload.stream !== true) {
            return {
              status: 400,
              data: {
                error: {
                  message: 'stream_options should be set along with stream = true',
                  type: 'invalid_request_error',
                },
              },
            };
          }
          return {
            status: 200,
            data: {
              id: 'chatcmpl_provider_direct_stream_options_blackbox',
              object: 'chat.completion',
              model: payload.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        }),
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'provider',
      protocolBehavior: 'auto',
      providerBinding: 'opencode-zen-free.deepseek-v4-flash-free',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(200);
      expect(bodyText).not.toContain('stream_options should be set along with stream = true');
      expect(sentPayload?.model).toBe('deepseek-v4-flash');
      expect(sentPayload?.stream).toBe(true);
      expect(sentPayload?.stream_options).toEqual({ include_usage: true });
    } finally {
      await server.stop();
    }
  }, 15000);

  it('provider-mode direct sends current request body and ignores metadata.__raw_request_body', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'dbittai-gpt.key1.gpt-5.3-codex');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    }));

    await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'dbittai-gpt.key1.gpt-5.3-codex',
      },
      {
        requestId: 'req_provider_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_raw',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(sentPayload).toEqual({
      model: 'mutated-model',
      instructions: 'mutated-system-prompt',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
    });
    expect((sentPayload as Record<string, unknown>).previous_response_id).toBeUndefined();
  });

  it('router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };

    const routerRoute = jest.fn(() => ({
      target: {
        providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: providerHandle.runtimeKey,
        modelId: 'gpt-5.3-codex',
      },
      decision: { routeName: 'default', pool: ['dbittai-gpt.key1.gpt-5.3-codex'] },
      diagnostics: {},
    }));
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct must not execute HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({ route: routerRoute })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['default', (server as any).hubPipeline]
    ]);

    const directResult = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'default',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_router',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(directResult.used).toBe(true);
    expect(sentPayload).toEqual({
      model: 'mutated-model',
      instructions: 'mutated-system-prompt',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
    });
    expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
    expect(routerRoute).toHaveBeenCalledTimes(1);
    expect((sentPayload as Record<string, unknown>).previous_response_id).toBeUndefined();
  });

  it('router same-protocol direct does not runtime-reject chat-style function tools', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const directSend = jest.fn(async () => ({
      status: 200,
      body: { object: 'response', id: 'resp_direct_chat_style_tool' },
    }));
    const providerHandle = {
      runtimeKey: 'asxs.crsa.gpt-5.5',
      providerId: 'asxs',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: directSend,
        processIncomingDirect: directSend,
      },
    };
    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct must not execute HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => ({
          target: {
            providerKey: 'asxs.crsa.gpt-5.5',
            providerType: 'responses',
            outboundProfile: 'openai-responses',
            runtimeKey: providerHandle.runtimeKey,
            modelId: 'gpt-5.5',
          },
          decision: { routeName: 'thinking', pool: ['asxs.crsa.gpt-5.5'] },
          diagnostics: {},
        })),
      })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([['gateway_priority_5555', (server as any).hubPipeline]]);

    for (const nestedToolIndex of [0, 3, 11]) {
      directSend.mockClear();
      const tools = Array.from({ length: 12 }, (_, index) => (
        index === nestedToolIndex
          ? { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
          : { type: 'function', name: `tool_${index}`, description: `tool ${index}`, parameters: { type: 'object' } }
      ));

      const outcome = await (server as any).executeRouterDirectPipelineForPort(
        {
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        },
        {
          requestId: `req_router_direct_nested_tool_${nestedToolIndex}`,
          entryEndpoint: '/v1/responses',
          method: 'POST',
          headers: {},
          query: {},
          body: {
            model: 'gpt-5.5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'sample lock' }] }],
            tools,
          },
          metadata: {},
        },
      );

      expect(outcome.used).toBe(true);
      expect(directSend).toHaveBeenCalledTimes(1);
      expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
      expect(outcome.response?.body).toMatchObject({ object: 'response', id: 'resp_direct_chat_style_tool' });
    }
  });

  it('router same-protocol direct relays stop_message followup through Hub before direct send', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort');
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_stop_followup_relay' },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'openai-responses-provider-20260602T213049095-247628-1139:stop_followup',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-5.5',
        instructions: 'continue',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
      },
      metadata: { __rt: { serverToolFollowup: true, followupSource: 'stop_message_auto' } },
    });

    expect(routerDirectSpy).not.toHaveBeenCalled();
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(result?.body).toMatchObject({ object: 'response', id: 'resp_stop_followup_relay' });
  });

  it('provider direct keeps stop_followup on direct path', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerDirectSpy = jest.spyOn(server as any, 'executeProviderDirectPipelineForPort').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_provider_direct_followup' },
      headers: {},
      metadata: {},
    } as any);
    const handle = { providerProtocol: 'openai-responses' };
    jest.spyOn(server as any, 'resolveProviderHandleForBinding').mockReturnValue(handle);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'provider',
          protocolBehavior: 'direct',
          providerBinding: 'direct.key1.gpt-test',
        }],
      },
    };

    const result = await (server as any).executePortAwarePipeline(5520, {
      requestId: 'openai-responses-provider-20260602T213049095-247628-1139:stop_followup',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: { model: 'gpt-5.5', input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true } },
    });

    expect(providerDirectSpy).toHaveBeenCalledTimes(1);
    expect(result?.body).toMatchObject({ object: 'response', id: 'resp_provider_direct_followup' });
  });

  it('router same-protocol direct passes x-route-hint into direct preroute metadata', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    server.seedUserConfigForBootstrap({
      httpserver: {
        ports: [
          {
            port: 5555,
            host: '127.0.0.1',
            mode: 'router',
            routingPolicyGroup: 'gateway_priority_5555',
            sameProtocolBehavior: 'direct',
          },
        ],
      },
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);

    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: true,
      response: { status: 200, body: { ok: true } },
      providerHandle: {} as any,
      auditContext: {} as any,
    } as any);

    await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_route_hint_search',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: { 'x-route-hint': 'search' },
      query: {},
      body: {
        model: 'gpt-5.5',
        instructions: 'hello',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      metadata: {},
    });

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(directSpy.mock.calls[0]?.[1]?.metadata).toEqual(expect.objectContaining({
      routeHint: 'search',
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      __rt: expect.objectContaining({
        sessionDir: expect.stringContaining('ports/gateway_priority_5555'),
      }),
    }));
  });

  it('router port metadata exposes only its routing policy group providers', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'relay',
        }],
      },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5555: { routing: { default: [{ id: 'route-5555', targets: ['mimo.key1.model-a'] }] } },
          gateway_coding_10000: { routing: { default: [{ id: 'route-10000', targets: ['llmgate.key2.model-b'] }] } },
        },
      },
    };
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({ status: 200, body: { ok: true } } as any);

    await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_port_scope_metadata',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: { model: 'gpt-5.5', input: 'hello' },
      metadata: {},
    });

    expect(executePipelineSpy.mock.calls[0]?.[0]?.metadata).toEqual(expect.objectContaining({
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      allowedProviders: ['mimo'],
      __rt: expect.objectContaining({
        sessionDir: expect.stringContaining('ports/gateway_priority_5555'),
      }),
    }));
  });

  it('HTTP BLACKBOX: router-direct emits direct send log for direct success', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const logs: string[] = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const captureLog = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    console.log = (...args: unknown[]) => { captureLog(...args); originalLog(...args); };
    console.info = (...args: unknown[]) => { captureLog(...args); originalInfo(...args); };
    console.warn = (...args: unknown[]) => { captureLog(...args); originalWarn(...args); };
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      logs.push(String(chunk));
      return originalStdoutWrite(chunk as string | Uint8Array, ...(args as []));
    }) as typeof process.stdout.write;

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerKey = 'direct.key1.gpt-test';
    const runtimeKey = 'runtime:direct';
    const directSend = jest.fn(async () => ({
      status: 200,
      data: { id: 'resp_direct_log_blackbox', object: 'response', output_text: 'ok_direct' },
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct must not execute HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({ route: jest.fn(() => ({
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey,
          modelId: 'gpt-test',
        },
        decision: {
          routeName: 'thinking',
          pool: [providerKey],
          poolId: 'gateway-priority-5555-thinking',
          reasoning: 'thinking:user-input',
        },
        diagnostics: {},
      })) })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'direct',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: { modelId: 'gpt-test' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: directSend,
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.4',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'read only question' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: 'resp_direct_log_blackbox' }));
      expect(directSend).toHaveBeenCalledTimes(1);
      expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      await server.stop();
    }
  }, 15000);

  it('router same-protocol direct remains direct when stopless metadata is present', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => ({ status: 200, body: { relayed: true }, metadata: {} })),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => ({
          target: {
            providerKey: 'direct.key1.gpt-test',
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: 'direct.key1.gpt-test',
            modelId: 'gpt-test',
          },
          decision: { routeName: 'search', pool: ['direct.key1.gpt-test'] },
          diagnostics: {},
        })),
      })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    (server as any).providerHandles = new Map([[
      'direct.key1.gpt-test',
      {
        providerProtocol: 'openai-chat',
        instance: {
          processIncomingDirect: jest.fn(async () => ({
            status: 200,
            data: {
              id: 'chatcmpl_direct_stopless_metadata_passthrough',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          })),
        },
      },
    ]]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort');

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_stopless_stays_direct',
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      metadata: {
        stoplessMode: 'on',
        stoplessArmed: true,
      },
    });

    expect(result.body?.id).toBe('chatcmpl_direct_stopless_metadata_passthrough');
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
  });

  it('HTTP BLACKBOX: router-direct passes provider response body through without model rewrite', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerKey = 'cc.key1.gpt-5.5';
    const runtimeKey = 'runtime:cc';
    const directSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_passthrough_model',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.5',
        output_text: 'ok'
      },
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct must not execute HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({ route: jest.fn(() => ({
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'coding', pool: [providerKey], reason: 'coding:user-input' },
        diagnostics: {},
      })) })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'cc',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: { modelId: 'gpt-5.5' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: directSend,
      },
    }]]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'read only question' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_router_direct_passthrough_model',
        model: 'gpt-5.5',
      }));
      expect(JSON.stringify(body)).not.toContain('missing choices');
      expect(directSend).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  }, 15000);

  it('router-direct switches provider request-locally on recoverable 429 without entering relay', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const sentPayloads: Record<string, unknown>[] = [];
    const direct429 = () => Object.assign(new Error('HTTP 429: Concurrency limit exceeded for user'), {
      statusCode: 429,
      status: 429,
      code: 'HTTP_429',
      upstreamCode: 'HTTP_429',
    });
    const firstDirectSend = jest.fn(async (payload: Record<string, unknown>) => {
      sentPayloads.push(payload);
      throw direct429();
    });
    const secondDirectSend = jest.fn(async (payload: Record<string, unknown>) => {
      sentPayloads.push(payload);
      return {
        status: 200,
        data: {
          id: 'resp_router_direct_429_switched',
          object: 'response',
          status: 'completed',
          output_text: 'ok',
        },
      };
    });
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey;
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'thinking', pool: [firstProviderKey, secondProviderKey], reason: 'thinking:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct recoverable retry must not enter HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({ route })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const requestBody = {
      model: 'router-gpt-5.5',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    };
    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_429_switch',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: requestBody,
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(secondProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_429_switched' });
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).toHaveBeenCalledTimes(1);
    expect(sentPayloads).toEqual([requestBody, requestBody]);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[0]?.[1]).toEqual(expect.not.objectContaining({ excludedProviderKeys: expect.anything() }));
    expect(route.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      excludedProviderKeys: [firstProviderKey],
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
    }));
    expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
  });

  it('router-direct switches to alternative provider immediately for recoverable 502 when VR has another target', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'sdfv.key1.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const direct502 = () => Object.assign(new Error('HTTP 502: upstream stream incomplete'), {
      statusCode: 502,
      status: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502',
    });
    const firstDirectSend = jest.fn(async () => { throw direct502(); });
    const secondDirectSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_502_switched_immediately',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn((_payload: unknown, metadata: Record<string, unknown>) => {
      const retryProviderKey = typeof metadata.__routecodexRetryProviderKey === 'string'
        ? metadata.__routecodexRetryProviderKey
        : undefined;
      const excluded = Array.isArray(metadata.excludedProviderKeys) ? metadata.excludedProviderKeys : [];
      const providerKey = retryProviderKey ?? (excluded.includes(firstProviderKey) ? secondProviderKey : firstProviderKey);
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'longcontext', pool: [firstProviderKey, secondProviderKey], reason: 'longcontext:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct recoverable retry must not enter HubPipeline'); }),
      getVirtualRouter: jest.fn(() => ({ route })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'sdfv',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: secondDirectSend,
        },
      }],
    ]);

    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_502_switch_immediately',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(outcome.auditContext.providerKey).toBe(secondProviderKey);
    expect(outcome.response?.data).toMatchObject({ id: 'resp_router_direct_502_switched_immediately' });
    expect(firstDirectSend).toHaveBeenCalledTimes(1);
    expect(secondDirectSend).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[0]?.[1]).toEqual(expect.not.objectContaining({ __routecodexRetryProviderKey: expect.anything() }));
    expect(route.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      excludedProviderKeys: [firstProviderKey],
    }));
    expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
  });

  it('HTTP BLACKBOX: router-direct provider HTTP 401 never enters standard executor', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const firstProviderKey = 'asxs.crsa.gpt-5.5';
    const secondProviderKey = 'llmgate.key1.gpt-5.5';
    const direct401 = Object.assign(new Error('HTTP 401: Upstream authentication failed'), {
      statusCode: 401,
      status: 401,
      code: 'HTTP_401',
    });
    const firstDirectSend = jest.fn(async () => { throw direct401; });
    const secondStandardSend = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_router_direct_401_must_not_relay',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
    }));
    const route = jest.fn(() => {
      const providerKey = firstProviderKey;
      return {
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey,
          modelId: 'gpt-5.5',
        },
        decision: { routeName: 'thinking', pool: [firstProviderKey, secondProviderKey], reason: 'thinking:test' },
        diagnostics: {},
      };
    });

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async () => { throw new Error('router-direct provider error must not enter standard executor'); }),
      getVirtualRouter: jest.fn(() => ({ route })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline]
    ]);
    (server as any).providerHandles = new Map([
      [firstProviderKey, {
        runtimeKey: firstProviderKey,
        providerId: 'asxs',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: firstDirectSend,
        },
      }],
      [secondProviderKey, {
        runtimeKey: secondProviderKey,
        providerId: 'llmgate',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: { modelId: 'gpt-5.5' },
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: secondStandardSend,
          processIncomingDirect: jest.fn(),
        },
      }],
    ]);

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        }),
      });
      const bodyText = await response.text();

      expect(response.status).toBe(401);
      expect(bodyText).toContain('Upstream authentication failed');
      expect(firstDirectSend).toHaveBeenCalledTimes(1);
      expect(secondStandardSend).not.toHaveBeenCalled();
      expect((server as any).hubPipeline.execute).not.toHaveBeenCalled();
      expect(route).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  }, 15000);

});
