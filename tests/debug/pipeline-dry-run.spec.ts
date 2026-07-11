import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const writeProviderSnapshot = jest.fn(async () => {});
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);
const shouldCaptureProviderStreamSnapshots = jest.fn(() => false);

jest.unstable_mockModule('../../src/providers/core/utils/snapshot-writer.js', () => ({
  writeProviderSnapshot,
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots
}));

const {
  PIPELINE_DRY_RUN_METADATA_KEY,
  attachPipelineDryRunControl,
  propagatePipelineDryRunControl,
  readPipelineDryRunControl,
  resolvePipelineDryRunControlFromHeaders
} = await import('../../src/debug/pipeline-dry-run.js');
const { HttpRequestExecutor } = await import('../../src/providers/core/runtime/http-request-executor.js');
const { handleChatCompletions } = await import('../../src/server/handlers/chat-handler.js');

function buildHttpExecutor(post: ReturnType<typeof jest.fn>): InstanceType<typeof HttpRequestExecutor> {
  return new HttpRequestExecutor({
    post,
    postStream: jest.fn(),
  } as any, {
    wantsUpstreamSse: () => false,
    getEffectiveEndpoint: () => '/v1/chat/completions',
    resolveRequestEndpoint: (_request: any, endpoint: string) => endpoint,
    buildRequestHeaders: async () => ({ Authorization: 'Bearer secret-token', 'x-safe': 'visible' }),
    finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
    applyStreamModeHeaders: (headers: Record<string, string>) => headers,
    getEffectiveBaseUrl: () => 'https://provider.example.test',
    buildHttpRequestBody: () => ({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
    prepareSseRequestBody: () => undefined,
    getEntryEndpointFromPayload: () => '/v1/chat/completions',
    getClientRequestIdFromContext: () => 'client_req_dry_run',
    wrapUpstreamSseResponse: async () => ({}),
    resolveBusinessResponseError: () => undefined,
    normalizeHttpError: async (error: unknown) => error as any,
  });
}

describe('pipeline dry-run control and provider request cut point', () => {
  it('accepts provider-request dry-run only for local diagnostic requests', () => {
    const local = resolvePipelineDryRunControlFromHeaders({
      headers: { 'x-routecodex-dry-run': 'provider-request' },
      isLocal: true
    });
    expect('control' in local ? local.control?.kind : undefined).toBe('provider_request');

    const remote = resolvePipelineDryRunControlFromHeaders({
      headers: { 'x-routecodex-dry-run': 'provider-request' },
      isLocal: false
    });
    expect('error' in remote ? remote.error.status : undefined).toBe(403);
  });

  it('keeps dry-run control as a non-enumerable metadata carrier and propagates it across clones', () => {
    const source: Record<string, unknown> = { requestId: 'req_dry_run_meta' };
    attachPipelineDryRunControl(source, {
      enabled: true,
      kind: 'provider_request',
      source: 'local_header',
      requestedAtMs: 1
    });
    expect(Object.keys(source)).toEqual(['requestId']);
    expect(JSON.stringify(source)).not.toContain(PIPELINE_DRY_RUN_METADATA_KEY);
    expect(readPipelineDryRunControl(source)?.kind).toBe('provider_request');

    const clone = { ...source };
    expect(readPipelineDryRunControl(clone)).toBeUndefined();
    propagatePipelineDryRunControl(source, clone);
    expect(readPipelineDryRunControl(clone)?.kind).toBe('provider_request');
  });

  it('returns final provider request without calling provider HTTP transport', async () => {
    writeProviderSnapshot.mockClear();
    const post = jest.fn(async () => ({ choices: [{ message: { role: 'assistant', content: 'should-not-run' } }] }));
    const executor = buildHttpExecutor(post);
    const metadata: Record<string, unknown> = { entryPort: 5555 };
    attachPipelineDryRunControl(metadata, {
      enabled: true,
      kind: 'provider_request',
      source: 'local_header',
      requestedAtMs: 1
    });

    const response = await executor.execute(
      { model: 'gpt-test' } as any,
      {
        requestId: 'req_provider_request_dry_run',
        providerType: 'mock',
        providerId: 'mock-provider',
        providerKey: 'mock.key1.gpt-test',
        providerProtocol: 'openai-chat',
        startTime: Date.now(),
        runtimeMetadata: {
          runtimeKey: 'mock.key1.gpt-test',
          providerProtocol: 'openai-chat',
          metadata
        }
      } as any
    ) as any;

    expect(post).not.toHaveBeenCalled();
    expect(writeProviderSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'provider-request',
      requestId: 'req_provider_request_dry_run'
    }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      object: 'routecodex.pipeline_dry_run',
      kind: 'provider_request',
      dryRun: true,
      entryPort: 5555,
      provider: {
        providerKey: 'mock.key1.gpt-test',
        providerProtocol: 'openai-chat',
        runtimeKey: 'mock.key1.gpt-test'
      },
      providerRequest: {
        method: 'POST',
        endpoint: '/v1/chat/completions',
        url: 'https://provider.example.test/v1/chat/completions',
        wantsSse: false,
        headers: {
          Authorization: '[REDACTED]',
          'x-safe': 'visible'
        },
        body: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      },
      evidence: {
        stoppedBeforeProviderSend: true,
        providerRequestSnapshotWritten: true
      }
    });
  });

  it('injects dry-run control through the chat handler and returns JSON even when the request asks for stream', async () => {
    const executePipeline = jest.fn(async (input: any) => {
      expect(readPipelineDryRunControl(input.metadata)?.kind).toBe('provider_request');
      return {
        status: 200,
        body: {
          object: 'routecodex.pipeline_dry_run',
          kind: 'provider_request',
          dryRun: true
        }
      };
    });
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => {
      void handleChatCompletions(req as any, res as any, {
        executePipeline,
        errorHandling: null,
        portContext: { localPort: 5555, matchedPort: 5555 }
      });
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-routecodex-dry-run': 'provider-request'
        },
        body: JSON.stringify({
          model: 'gpt-test',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({
        object: 'routecodex.pipeline_dry_run',
        kind: 'provider_request',
        dryRun: true
      });
      expect(executePipeline).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
