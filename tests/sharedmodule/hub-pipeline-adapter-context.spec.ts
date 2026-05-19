import { describe, expect, it } from '@jest/globals';
import { buildAdapterContextFromNormalized } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.js';

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
});
