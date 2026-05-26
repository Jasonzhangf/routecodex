import { describe, expect, it } from '@jest/globals';

import { finalizeProviderPayloadWithPolicy } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.ts';

describe('provider outbound internal metadata boundary', () => {
  it('RED: strips internal control metadata before provider outbound for openai-responses', () => {
    const result = finalizeProviderPayloadWithPolicy({
      effectivePolicy: { mode: 'enforce' },
      outboundProtocol: 'openai-responses',
      compatibilityProfile: undefined,
      formattedPayload: {
        model: 'gpt-test',
        input: [],
        metadata: {
          routeHint: 'tools/gateway-priority-5555-tools',
          responsesResume: { previousResponseId: 'resp_prev_internal' },
          clientInjectOnly: true,
          __rt: { serverToolFollowup: true },
          __shadowCompareForcedProviderKey: 'mini27.key1.MiniMax-M2.7'
        }
      } as any,
      stageRecorder: undefined as any,
      requestId: 'req_provider_outbound_internal_meta_1',
      config: { toolSurface: {} } as any,
      outboundAdapterContext: {} as any,
    });

    expect((result as Record<string, unknown>).metadata).toBeUndefined();
  });
});
