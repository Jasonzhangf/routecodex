import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-shared-conversion-semantics.js',
  () => ({
    cloneRuntimeMetadataWithNative: (carrier?: Record<string, unknown> | null) => carrier?.__rt,
    ensureRuntimeMetadataCarrierWithNative: (carrier: Record<string, unknown>) => carrier.__rt && typeof carrier.__rt === 'object' ? carrier : { ...carrier, __rt: {} },
    readRuntimeMetadataWithNative: (carrier?: Record<string, unknown> | null) => carrier?.__rt
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js',
  () => ({
    normalizeReqInboundToolCallIdStyleWithNative: (value: unknown) => value === 'fc' || value === 'preserve' ? value : undefined
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    resolveAdapterContextMetadataSignalsWithNative: () => ({}),
    resolveAdapterContextObjectCarriersWithNative: (metadata: Record<string, unknown>) => ({
      runtime: metadata.__rt && typeof metadata.__rt === 'object' ? metadata.__rt : undefined
    }),
    extractAdapterContextMetadataFieldsWithNative: () => ({})
  })
);

const { buildAdapterContextFromNormalized } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.js');

describe('hub pipeline adapter context', () => {
  it('preserves target multimodal flag when metadata runtime carrier is also present', () => {
    const adapterContext = buildAdapterContextFromNormalized(
      {
        id: 'req-adapter-rt-merge',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: false,
        metadata: {
          __rt: {
            serverToolFollowup: true,
            clientProtocol: 'openai-responses',
          },
        },
      },
      {
        providerKey: 'crs.crsa.gpt-5.3-codex',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        supportsMultimodal: false,
      } as any,
    );

    expect((adapterContext.__rt as Record<string, unknown> | undefined)).toMatchObject({
      supportsMultimodal: false,
      serverToolFollowup: true,
      clientProtocol: 'openai-responses',
    });
  });

  it('RED: carries entry port context into snapshot adapter context', () => {
    const adapterContext = buildAdapterContextFromNormalized({
      id: 'req-entry-port-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stream: false,
      metadata: {
        matchedPort: 5555,
        portContext: {
          localPort: 5520,
          matchedPort: 5555,
          routingPolicyGroup: 'gateway_priority_5555'
        }
      }
    });

    expect(adapterContext).toMatchObject({
      matchedPort: 5555,
      entryPort: 5555,
      portContext: {
        localPort: 5520,
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555'
      }
    });
  });
});
