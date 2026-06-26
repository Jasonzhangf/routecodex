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
});
