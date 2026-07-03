import { describe, expect, it } from '@jest/globals';

import { buildDirectProviderRuntimeMetadata } from '../../../../src/server/runtime/http-server/direct-runtime-metadata.js';

describe('direct-runtime-metadata', () => {
  it('projects only provider runtime primitive controls from cyclic live metadata', () => {
    const metadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      clientRequestId: 'client-1',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      entryPort: 5520,
      providerStreamNoContentTimeoutMs: 120_000,
      metadataCenterSnapshot: {
        runtimeControl: {
          stopMessageEnabled: true,
        },
      },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    metadata.self = metadata;

    const projected = buildDirectProviderRuntimeMetadata({
      metadata,
      entryEndpoint: '/v1/responses',
      localPort: 5520,
      providerProtocol: 'openai-responses',
    });

    expect(projected).toEqual({
      entryEndpoint: '/v1/responses',
      entryPort: 5520,
      matchedPort: 5520,
      routecodexLocalPort: 5520,
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      clientRequestId: 'client-1',
      providerStreamNoContentTimeoutMs: 120_000,
      __responsesDirectPassthrough: true,
    });
    expect(JSON.stringify(projected)).toContain('__responsesDirectPassthrough');
    expect(projected).not.toHaveProperty('metadataCenterSnapshot');
    expect(projected).not.toHaveProperty('input');
    expect(projected).not.toHaveProperty('self');
  });
});
