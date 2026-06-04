import { describe, expect, it, jest } from '@jest/globals';

describe('direct passthrough route-level', () => {
  it('HTTP BLACKBOX: provider-mode keyless chat binding sends bound provider model', async () => {
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
          if (payload.model !== 'deepseek-v4-flash-free') {
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
              model: 'deepseek-v4-flash-free',
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
      expect(sentPayload?.model).toBe('deepseek-v4-flash-free');
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
              model: 'deepseek-v4-flash-free',
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
      expect(sentPayload?.model).toBe('deepseek-v4-flash-free');
      expect(sentPayload?.stream).toBe(true);
      expect(sentPayload?.stream_options).toEqual({ include_usage: true });
    } finally {
      await server.stop();
    }
  }, 15000);

  it('provider-mode direct sends metadata.__raw_request_body instead of mutated body', async () => {
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
      model: 'raw-model',
      previous_response_id: 'resp_prev_raw',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    });
    expect((sentPayload as Record<string, unknown>).instructions).toBeUndefined();
  });

  it('router same-protocol direct keeps ingress payload transparent and preserves previous_response_id for responses providers', async () => {
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

    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => ({
        providerPayload: {
          model: 'gpt-5.3-codex',
          reasoning: { effort: 'high' },
          instructions: 'must-not-copy',
        },
        target: {
          providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
          providerType: 'responses',
          outboundProfile: 'openai-responses',
          runtimeKey: providerHandle.runtimeKey,
          processMode: 'chat',
        },
        routingDecision: { routeName: 'default', pool: ['dbittai-gpt.key1.gpt-5.3-codex'] },
        metadata: { processMode: 'chat' },
      })),
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
      model: 'gpt-5.3-codex',
      previous_response_id: 'resp_prev_router',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      reasoning: { effort: 'high' },
    });
    expect((sentPayload as Record<string, unknown>).instructions).toBeUndefined();
  });

  it('router same-protocol direct is skipped when apply_patch servertool mode is enabled', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { object: 'response', id: 'resp_relay' },
      headers: {},
      metadata: {},
    } as any);
    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: true,
      response: { status: 200, body: { object: 'response', id: 'resp_direct' } },
      providerHandle: {} as any,
      auditContext: {} as any,
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 5520,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'default',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['default', (server as any).hubPipeline]
    ]);

    const result = await (server as any).executePortAwarePipeline(
      5520,
      {
        requestId: 'req_router_skip_direct_apply_patch_servertool',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'edit file' }] }],
          tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
        },
        metadata: {
          __rt: { applyPatch: { mode: 'servertool' } },
        },
      },
    );

    expect(routerDirectSpy).not.toHaveBeenCalled();
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(result?.body).toMatchObject({ object: 'response', id: 'resp_relay' });
  });

  it('router same-protocol direct keeps stop_followup on direct path', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const routerDirectSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: true,
      response: { status: 200, data: { object: 'response', id: 'resp_stop_followup_direct' } },
      providerHandle: {} as any,
      auditContext: {} as any,
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
      body: { model: 'gpt-5.5', input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true } },
    });

    expect(routerDirectSpy).toHaveBeenCalledTimes(1);
    expect(result?.body).toMatchObject({ object: 'response', id: 'resp_stop_followup_direct' });
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
      body: { model: 'gpt-5.5', input: 'hello' },
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
      execute: jest.fn(async () => ({
        providerPayload: { model: 'gpt-test' },
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey,
          processMode: 'chat',
        },
        routingDecision: {
          routeName: 'thinking',
          pool: [providerKey],
          poolId: 'gateway-priority-5555-thinking',
          reasoning: 'thinking:user-input',
        },
        processMode: 'chat',
        metadata: {},
      })),
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
      expect(logs.some((line) => line.includes('[router-direct.send]'))).toBe(true);
      expect(logs.some((line) => line.includes('completed'))).toBe(true);
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      await server.stop();
    }
  }, 15000);

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
      execute: jest.fn(async () => ({
        providerPayload: { model: 'gpt-5.5' },
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey,
          processMode: 'chat',
        },
        routingDecision: { routeName: 'coding', pool: [providerKey], reason: 'coding:user-input' },
        processMode: 'chat',
        metadata: {},
      })),
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

});
