import { describe, expect, it } from '@jest/globals';

import { RouteCodexHttpServer } from '../../../../src/server/runtime/http-server/index.js';

describe('http-server direct result metadata propagation', () => {
  it('router-direct result preserves input metadata for downstream SSE restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const result = await server.buildRouterDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } }
    }, {
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }
    });

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
  });

  it('provider-direct result preserves input metadata for downstream SSE restore', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    server.extractProviderModel = () => 'gpt-5.4';
    const result = await server.buildProviderDirectResult({
      response: {
        status: 200,
        data: { __sse_responses: { pipe: () => undefined }, model: 'gpt-5.4' }
      },
      providerProtocol: 'openai-responses',
      providerHandle: { providerType: 'openai' }
    }, {
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex',
        __raw_request_body: { model: 'gpt-5.3-codex', reasoning: { effort: 'high' } }
      }
    }, {}, 'test.key1');

    expect(result.metadata).toMatchObject({
      clientModelId: 'gpt-5.3-codex',
      originalModelId: 'gpt-5.3-codex'
    });
  });
});


  it('router-direct result preserves recoverable upstream 502 status for retry gate work', async () => {
    const server = Object.create(RouteCodexHttpServer.prototype) as any;
    const result = await server.buildRouterDirectResult({
      response: {
        status: 502,
        data: { error: { code: 'HTTP_502' } }
      },
      providerHandle: { providerProtocol: 'openai-responses', providerType: 'openai' },
      auditContext: { providerKey: 'test.key1', routingDecision: { routeName: 'thinking' } }
    }, {
      body: { model: 'gpt-5.3-codex', stream: true },
      metadata: {
        clientModelId: 'gpt-5.3-codex',
        originalModelId: 'gpt-5.3-codex'
      }
    });

    expect(result.status).toBe(502);
    expect((result.body as any)?.error?.code).toBe('HTTP_502');
  });
