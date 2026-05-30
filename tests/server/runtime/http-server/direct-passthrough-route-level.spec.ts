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
    }));
  });

  it.each([502, 503])(
    'router direct recoverable %i exits direct path and re-enters unified executor entry',
    async (statusCode) => {
      jest.resetModules();
      const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

      const server = new RouteCodexHttpServer({
        configPath: '/tmp/routecodex-test-config.json',
        server: { host: '127.0.0.1', port: 5555 },
        pipeline: {},
        logging: { level: 'error', enableConsole: false },
        providers: {},
      } as any);

      const providerA = 'sdfv.key1.gpt-5.3-codex';
      const providerB = 'mimo.mimo-v2.5-pro';
      const runtimeA = 'runtime:A';
      const runtimeB = 'runtime:B';

      const hubExecute = jest.fn(async (input: any) => {
        const excluded = Array.isArray(input?.metadata?.excludedProviderKeys)
          ? input.metadata.excludedProviderKeys
          : [];
        if (excluded.includes(providerA)) {
          return {
            providerPayload: { model: 'mimo-v2.5-pro' },
            target: {
              providerKey: providerB,
              providerType: 'openai',
              outboundProfile: 'openai-responses',
              runtimeKey: runtimeB,
              processMode: 'chat',
            },
            routingDecision: { routeName: 'coding', pool: [providerA, providerB] },
            processMode: 'chat',
            metadata: {}
          };
        }
        return {
          providerPayload: { model: 'gpt-5.3-codex' },
          target: {
            providerKey: providerA,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: runtimeA,
            processMode: 'chat',
          },
          routingDecision: { routeName: 'coding', pool: [providerA, providerB] },
          processMode: 'chat',
          metadata: {}
        };
      });
      (server as any).hubPipeline = { execute: hubExecute, updateVirtualRouterConfig: jest.fn() };

      (server as any).providerHandles = new Map([
        [runtimeA, {
          runtimeKey: runtimeA,
          providerId: 'sdfv',
          providerType: 'openai',
          providerFamily: 'openai',
          providerProtocol: 'openai-responses',
          runtime: {},
          instance: {
            initialize: async () => {},
            cleanup: async () => {},
            processIncoming: async () => ({
              status: statusCode,
              data: {
                error: {
                  code: `HTTP_${statusCode}`,
                  message: statusCode === 503 ? 'Service temporarily unavailable' : 'Upstream request failed',
                },
              },
            }),
            processIncomingDirect: async () => ({
              status: statusCode,
              data: {
                error: {
                  code: `HTTP_${statusCode}`,
                  message: statusCode === 503 ? 'Service temporarily unavailable' : 'Upstream request failed',
                },
              },
            }),
          },
        }],
        [runtimeB, {
          runtimeKey: runtimeB,
          providerId: 'mimo',
          providerType: 'openai',
          providerFamily: 'openai',
          providerProtocol: 'openai-responses',
          runtime: {},
          instance: {
            initialize: async () => {},
            cleanup: async () => {},
            processIncoming: async () => ({ status: 200, data: { id: 'ok_b' } }),
            processIncomingDirect: async () => ({ status: 200, data: { id: 'ok_b' } }),
          },
        }]
      ]);

      const directOutcome = await (server as any).executeRouterDirectPipelineForPort(
        {
          port: 5555,
          host: '0.0.0.0',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        },
        {
          requestId: `req_direct_${statusCode}_trip_should_reroute`,
          entryEndpoint: '/v1/responses',
          method: 'POST',
          headers: {},
          query: {},
          body: {
            model: 'router-gpt-5.4',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
            stream: false
          },
          metadata: { stream: false, inboundStream: false },
        },
      );

      expect(directOutcome.used).toBe(false);
      expect(directOutcome.reason).toBe('recoverable_direct_5xx_reenter_executor');

      let nestedMetadata: Record<string, unknown> | undefined;
      const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockImplementation(async (nestedInput: any) => {
        nestedMetadata = nestedInput?.metadata;
        return {
          status: 200,
          body: { id: 'ok_from_unified_executor' },
          metadata: {},
        } as any;
      });

      const finalResult = await (server as any).executePortAwarePipeline(
        5555,
        {
          requestId: `req_direct_${statusCode}_trip_should_reroute_portaware`,
          entryEndpoint: '/v1/responses',
          method: 'POST',
          headers: {},
          query: {},
          body: {
            model: 'router-gpt-5.4',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
            stream: false
          },
          metadata: { stream: false, inboundStream: false },
        },
      );

      expect(finalResult.status).toBe(200);
      expect(executePipelineSpy).toHaveBeenCalledTimes(1);
      expect(nestedMetadata?.routecodexSameProtocolDirectDisabled).toBe(true);
    },
  );


  it('BLACKBOX: router direct thrown HTTP 503 disables direct and re-enters unified executor', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerA = 'sdfv.key1.gpt-5.5';
    const runtimeA = 'runtime:sdfv';
    (server as any).hubPipeline = {
      execute: jest.fn(async () => ({
        providerPayload: { model: 'gpt-5.5' },
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: runtimeA,
          processMode: 'chat',
        },
        routingDecision: { routeName: 'coding', pool: [providerA, 'mimo.mimo-v2.5-pro'] },
        processMode: 'chat',
        metadata: {},
      })),
      updateVirtualRouterConfig: jest.fn(),
    };

    const directError = Object.assign(new Error('HTTP 503: Service temporarily unavailable'), {
      status: 503,
      statusCode: 503,
      code: 'HTTP_503',
      response: { data: { error: { code: 'HTTP_503', message: 'Service temporarily unavailable' } } },
    });
    (server as any).providerHandles = new Map([[runtimeA, {
      runtimeKey: runtimeA,
      providerId: 'sdfv',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async () => ({ status: 200, data: { id: 'relay_ok' } }),
        processIncomingDirect: async () => { throw directError; },
      },
    }]]);

    let nestedMetadata: Record<string, unknown> | undefined;
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockImplementation(async (nestedInput: any) => {
      nestedMetadata = nestedInput?.metadata;
      return { status: 200, body: { id: 'ok_from_unified_executor' }, metadata: {} } as any;
    });

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_direct_throw_503_reenter',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'router-gpt-5.4',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        stream: false,
      },
      metadata: { stream: false, inboundStream: false },
    });

    expect(result.status).toBe(200);
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(nestedMetadata?.routecodexSameProtocolDirectDisabled).toBe(true);
  });

  it('HTTP BLACKBOX: /v1/responses direct thrown HTTP 503 reroutes to backup and returns captured response', async () => {
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS = '5';
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const providerA = 'sdfv.key1.gpt-5.5';
    const providerB = 'mimo.mimo-v2.5-pro';
    const runtimeA = 'runtime:sdfv';
    const runtimeB = 'runtime:mimo';
    const directA = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 503: Service temporarily unavailable'), {
        status: 503,
        statusCode: 503,
        code: 'HTTP_503',
        response: { data: { error: { code: 'HTTP_503', message: 'Service temporarily unavailable' } } },
      });
    });
    const relayA = jest.fn(async () => ({ status: 503, data: { error: { code: 'HTTP_503', message: 'still unavailable' } } }));
    const relayB = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'resp_http_blackbox_backup',
        object: 'response',
        output_text: 'ok_from_backup',
        metadata: { actualProvider: providerB },
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
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input?.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const directDisabled = input?.metadata?.routecodexSameProtocolDirectDisabled === true;
        const providerKey = directDisabled || excluded.has(providerA) ? providerB : providerA;
        return {
          providerPayload: { model: providerKey === providerA ? 'gpt-5.5' : 'mimo-v2.5-pro' },
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey === providerA ? runtimeA : runtimeB,
            processMode: 'chat',
          },
          routingDecision: { routeName: 'coding', pool: [providerA, providerB] },
          processMode: 'chat',
          metadata: {},
        };
      }),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).providerHandles = new Map([
      [runtimeA, {
        runtimeKey: runtimeA,
        providerId: 'sdfv',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: {},
        instance: { initialize: async () => {}, cleanup: async () => {}, processIncoming: relayA, processIncomingDirect: directA },
      }],
      [runtimeB, {
        runtimeKey: runtimeB,
        providerId: 'mimo',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-responses',
        runtime: {},
        instance: { initialize: async () => {}, cleanup: async () => {}, processIncoming: relayB, processIncomingDirect: jest.fn() },
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
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.4',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: 'resp_http_blackbox_backup' }));
      expect(directA).toHaveBeenCalledTimes(1);
      expect(relayA).toHaveBeenCalledTimes(0);
      expect(relayB).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
      if (previousBase === undefined) {
        delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousBase;
      }
      if (previousMax === undefined) {
        delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS = previousMax;
      }
    }
  }, 15000);


  it('HTTP BLACKBOX: router-direct emits virtual-router-hit for direct success before provider send', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
      originalLog(...args);
    };

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
      expect(logs.some((line) => line.includes('[virtual-router-hit][rt]'))).toBe(true);
      expect(logs.some((line) => line.includes('thinking/gateway-priority-5555-thinking -> direct.key1.gpt-test.gpt-test'))).toBe(true);
      expect(logs.some((line) => line.includes('reason=thinking:user-input'))).toBe(true);
    } finally {
      console.log = originalLog;
      await server.stop();
    }
  }, 15000);

  // NOTE:
  // We intentionally keep request-level blackbox coverage bounded to the
  // direct->executor re-entry contract in this file. Exclusion/cooldown policy
  // is verified in request-executor blackbox suite.
});
