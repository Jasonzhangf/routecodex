import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshot = jest.fn(async () => undefined);
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);

describe('http-request-executor snapshot entryPort', () => {
  beforeEach(() => {
    jest.resetModules();
    writeProviderSnapshot.mockClear();
    attachProviderSseSnapshotStream.mockClear();
  });

  it('reads request_truth.portScope from runtimeMetadata.metadata for provider-response snapshots', async () => {
    jest.unstable_mockModule('../../../../src/providers/core/utils/snapshot-writer.js', () => ({
      writeProviderSnapshot,
      attachProviderSseSnapshotStream,
      shouldCaptureProviderStreamSnapshots: () => false
    }));
    const { HttpRequestExecutor } = await import(
      '../../../../src/providers/core/runtime/http-request-executor.ts'
    );
    const { MetadataCenter } = await import(
      '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
    );

    const runtimeMetadataCarrier = { requestId: 'req-http-executor-entry-port' } as Record<string, unknown>;
    MetadataCenter.attach(runtimeMetadataCarrier).writeRequestTruth(
      'portScope',
      '5520',
      {
        module: 'tests/providers/core/runtime/http-request-executor.snapshot-entry-port.spec.ts',
        symbol: 'reads request_truth.portScope from runtimeMetadata.metadata for provider-response snapshots',
        stage: 'ServerReqInbound01ClientRaw'
      }
    );

    let sentBody: Record<string, unknown> | undefined;
    const executor = new HttpRequestExecutor(
      {
        post: async (_url: string, body: Record<string, unknown>) => {
          sentBody = body;
          return {
          data: { ok: true },
          status: 200,
          headers: { 'content-type': 'application/json' }
          };
        }
      } as any,
      {
        wantsUpstreamSse: () => false,
        getEffectiveEndpoint: () => '/v1/responses',
        resolveRequestEndpoint: () => '/v1/responses',
        buildHttpRequestBody: (payload: unknown) => payload as Record<string, unknown>,
        prepareSseRequestBody: () => undefined,
        getEntryEndpointFromPayload: () => '/v1/responses',
        getClientRequestIdFromContext: () => 'req-http-executor-entry-port',
        buildRequestHeaders: async () => ({ 'content-type': 'application/json' }),
        finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
        applyStreamModeHeaders: (headers: Record<string, string>) => headers,
        getEffectiveBaseUrl: () => 'https://example.invalid',
        sanitizeProviderWireBody: async (body: Record<string, unknown>) => body,
        wrapUpstreamSseResponse: async () => ({}),
        resolveBusinessResponseError: () => undefined,
        normalizeHttpError: async (error: unknown) => error as any,
        shouldCaptureProviderStreamSnapshots: () => false
      } as any
    );

    await executor.execute(
      { model: 'gpt-5.4' } as any,
      ({
        requestId: 'req-http-executor-entry-port',
        providerKey: 'XL.key1.gpt-5.4-mini',
        providerId: 'XL',
        metadata: {},
        runtimeMetadata: {
          metadata: runtimeMetadataCarrier
        }
      }) as any
    );

    const calls = writeProviderSnapshot.mock.calls.map((call) => call[0]);
    expect(sentBody).toMatchObject({ model: 'gpt-5.4' });
    expect(calls).toContainEqual(expect.objectContaining({
      phase: 'provider-request',
      requestId: 'req-http-executor-entry-port',
      entryPort: 5520,
      data: sentBody
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      phase: 'provider-response',
      requestId: 'req-http-executor-entry-port',
      entryPort: 5520
    }));
  });
});
