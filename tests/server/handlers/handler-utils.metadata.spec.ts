import { describe, expect, it } from '@jest/globals';

import { mergePipelineMetadata } from '../../../src/server/handlers/handler-utils.js';

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
});
