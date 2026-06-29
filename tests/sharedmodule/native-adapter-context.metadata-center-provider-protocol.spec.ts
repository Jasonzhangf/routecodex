import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/native-adapter-context.js';

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/native-adapter-context.metadata-center-provider-protocol.spec.ts',
  symbol: 'bindProviderProtocol',
  stage: 'test_runtime_control_provider_protocol'
} as const;

describe('native adapter context metadata center providerProtocol contract', () => {
  it('prefers bound MetadataCenter runtimeControl.providerProtocol over flat adapterContext field', () => {
    const adapterContext: Record<string, unknown> = {
      providerProtocol: 'openai-chat',
      requestId: 'req_native_adapter_context',
      entryEndpoint: '/v1/responses'
    };
    const center = MetadataCenter.attach(adapterContext);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      TEST_METADATA_WRITER,
      'test-provider-protocol'
    );

    const result = buildNativeReqOutboundCompatAdapterContext(adapterContext as any);

    expect(result.providerProtocol).toBe('openai-responses');
  });

  it('ignores flat adapterContext shadows and carries only MetadataCenter families', () => {
    const adapterContext: Record<string, unknown> = {
      providerProtocol: 'openai-chat',
      providerKey: 'flat.key1',
      requestId: 'flat-request',
      entryEndpoint: '/flat',
      routeId: 'flat-route',
      sessionId: 'flat-session',
      modelId: 'flat-model',
      capturedChatRequest: { messages: [{ role: 'user', content: 'flat' }] }
    };
    const center = MetadataCenter.attach(adapterContext);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      TEST_METADATA_WRITER,
      'test-provider-protocol'
    );
    center.writeRuntimeControl(
      'routeId',
      'center-route',
      TEST_METADATA_WRITER,
      'test-route-id'
    );
    center.writeRequestTruth(
      'requestId',
      'center-request',
      TEST_METADATA_WRITER,
      'test-request-id'
    );
    center.writeRequestTruth(
      'entryEndpoint',
      '/v1/responses',
      TEST_METADATA_WRITER,
      'test-entry-endpoint'
    );
    center.writeRequestTruth(
      'sessionId',
      'center-session',
      TEST_METADATA_WRITER,
      'test-session-id'
    );
    center.writeProviderObservation(
      'providerKey',
      'center.key1',
      TEST_METADATA_WRITER,
      'test-provider-key'
    );
    center.writeProviderObservation(
      'assignedModelId',
      'center-model',
      TEST_METADATA_WRITER,
      'test-model-id'
    );
    center.writeProviderObservation(
      'target',
      { providerId: 'center-provider' },
      TEST_METADATA_WRITER,
      'test-provider-id'
    );

    const result = buildNativeReqOutboundCompatAdapterContext(adapterContext as any);

    expect(result).toMatchObject({
      providerProtocol: 'openai-responses',
      providerKey: 'center.key1',
      providerId: 'center-provider',
      requestId: 'center-request',
      entryEndpoint: '/v1/responses',
      routeId: 'center-route',
      sessionId: 'center-session',
      modelId: 'center-model'
    });
    expect(result.capturedChatRequest).toBeUndefined();
    expect(result.originalModelId).toBeUndefined();
    expect(result.runtimeKey).toBeUndefined();
  });
});
