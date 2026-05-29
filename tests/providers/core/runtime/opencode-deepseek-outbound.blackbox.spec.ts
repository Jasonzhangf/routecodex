import { afterEach, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpRequestExecutor } from '../../../../src/providers/core/runtime/http-request-executor.js';
import { finalizeProviderRequestHeaders } from '../../../../src/providers/core/runtime/provider-request-header-orchestrator.js';
import type { ProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';
import { VercelAiSdkOpenAiTransport } from '../../../../src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.js';
import type { UnknownObject } from '../../../../src/types/common-types.js';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.js', () => ({
  getLastCamoufoxLaunchFailureReason: jest.fn(() => undefined),
  openAuthInCamoufox: jest.fn(async () => undefined)
}));

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('opencode DeepSeek outbound request blackbox', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it('does not replay opencode session when assistant tool-call history lacks original reasoning_content', async () => {
    let capturedHeaders: http.IncomingHttpHeaders | undefined;
    let capturedBody: UnknownObject | undefined;

    server = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UnknownObject;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl_blackbox_deepseek_1',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash-free',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    const runtimeMetadata: ProviderRuntimeMetadata = {
      requestId: 'req_blackbox_deepseek_1',
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.key1.deepseek-v4-flash-free',
      providerType: 'openai',
      routeName: 'longcontext',
      metadata: { sessionId: 'sess-from-client' }
    };
    const transport = new VercelAiSdkOpenAiTransport();
    const executor = new HttpRequestExecutor({} as any, {
      wantsUpstreamSse: () => false,
      getEffectiveEndpoint: () => '/v1/chat/completions',
      resolveRequestEndpoint: (_request, endpoint) => endpoint,
      buildRequestHeaders: async () => ({
        'content-type': 'application/json',
        authorization: 'Bearer test',
        'x-opencode-session': 'sess-from-client'
      }),
      finalizeRequestHeaders: (headers, request) => finalizeProviderRequestHeaders({
        headers,
        request,
        finalizeHeaders: (next) => next,
        runtimeMetadata,
        providerType: 'openai'
      }),
      applyStreamModeHeaders: (headers) => headers,
      getEffectiveBaseUrl: () => `http://127.0.0.1:${address.port}`,
      getBaseUrlCandidates: () => undefined,
      buildHttpRequestBody: (request) => request,
      prepareSseRequestBody: () => undefined,
      getEntryEndpointFromPayload: () => '/v1/responses',
      getClientRequestIdFromContext: () => 'req_blackbox_deepseek_1',
      wrapUpstreamSseResponse: async () => ({}),
      executePreparedRequest: (requestInfo, context, captureSse) => transport.executePreparedRequest(requestInfo, context, captureSse),
      getHttpRetryLimit: () => 1,
      shouldRetryHttpError: () => false,
      delayBeforeHttpRetry: async () => undefined,
      resolveBusinessResponseError: () => undefined,
      normalizeHttpError: async (error) => { throw error; }
    });

    await executor.execute({
      model: 'deepseek-v4-flash-free',
      max_tokens: 32,
      messages: [
        { role: 'user', content: 'run pwd' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        { role: 'user', content: 'continue' }
      ],
      tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }]
    }, {
      requestId: 'req_blackbox_deepseek_1',
      providerType: 'openai' as any,
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.key1.deepseek-v4-flash-free',
      routeName: 'longcontext',
      startTime: Date.now(),
      profile: {} as any,
      metadata: runtimeMetadata.metadata,
      runtimeMetadata
    });

    expect(capturedHeaders?.['x-opencode-session']).toBeUndefined();
    expect(capturedBody?.enable_thinking).toBe(true);
    expect(JSON.stringify(capturedBody)).not.toContain('I need to call');
    expect(runtimeMetadata.metadata?.opencodeSuppressSession).toBe(true);
  });
});
