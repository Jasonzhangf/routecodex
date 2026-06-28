import { describe, expect, it } from '@jest/globals';

import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { extractContinuationContextSessionIdentifiersFromMetadata } from '../../../../src/modules/llmswitch/bridge/state-integrations.js';

describe('state-integrations continuation context extraction', () => {
  it('does not read continuation session identifiers from MetadataCenter continuation_context', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeContinuationContext(
      'responsesResume',
      {
        responseId: 'resp-center-continuation'
      },
      {
        module: 'tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts',
        symbol: 'does not read continuation session identifiers from MetadataCenter continuation_context',
        stage: 'test'
      }
    );

    expect(extractContinuationContextSessionIdentifiersFromMetadata(metadata)).toEqual({});
  });

  it('does not read top-level metadata.responsesRequestContext without MetadataCenter binding', () => {
    expect(extractContinuationContextSessionIdentifiersFromMetadata({
      responsesRequestContext: {
        sessionId: 'sess-top-level-only',
        conversationId: 'conv-top-level-only'
      }
    })).toEqual({});
  });
});
