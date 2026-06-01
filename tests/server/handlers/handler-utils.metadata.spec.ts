import { describe, expect, it } from '@jest/globals';

import {
  mergePipelineMetadata,
  stripRequestBodyMetadataForPipeline
} from '../../../src/server/handlers/handler-utils.js';

describe('handler metadata merge', () => {
  it('drops client/restored routeHint metadata before pipeline routing', () => {
    const merged = mergePipelineMetadata(
      {
        routeHint: 'coding',
        sessionId: 'fin',
        __rt: { routeHint: 'coding', keep: true },
      },
      {
        providerProtocol: 'openai-responses',
        __rt: { internal: true },
      }
    );

    expect(merged.routeHint).toBeUndefined();
    expect(merged.sessionId).toBe('fin');
    expect(merged.__rt).toEqual({ routeHint: 'coding', keep: true, internal: true });
  });

  it('strips top-level request body metadata before pipeline body handoff', () => {
    const original = {
      model: 'gpt-test',
      metadata: { session_id: 'must-stay-in-carrier' },
      input: [{ role: 'user', content: 'hello' }]
    };

    const stripped = stripRequestBodyMetadataForPipeline(original) as Record<string, unknown>;

    expect(stripped).toEqual({
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }]
    });
    expect(original.metadata).toEqual({ session_id: 'must-stay-in-carrier' });
  });
});
