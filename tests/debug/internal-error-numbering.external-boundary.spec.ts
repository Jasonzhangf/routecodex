import { describe, expect, it } from '@jest/globals';

import {
  buildDebugErrorDiagArtifactRecord,
} from '../../src/debug/diag/index.js';
import {
  linkExternalError,
} from '../../src/debug/internal-error/index.js';

describe('feature_id: debug.internal_error_numbering external boundary', () => {
  it('records provider/upstream errors as external links, not internal envelopes', () => {
    const externalError = linkExternalError({
      kind: 'provider',
      status: 429,
      code: 'INSUFFICIENT_QUOTA',
      providerKey: 'minimax.key1',
      message: 'provider quota exhausted',
    });

    const record = buildDebugErrorDiagArtifactRecord({
      endpoint: '/v1/responses',
      requestId: 'req-external-1',
      requestBody: { model: 'MiniMax-M3' },
      error: Object.assign(new Error('provider returned 429'), {
        code: 'HTTP_429',
        statusCode: 429,
      }),
      externalError,
      timestamp: '2026-06-29T00:00:00.000Z',
    });

    expect(record.externalError).toEqual(expect.objectContaining({
      kind: 'provider',
      status: 429,
      code: 'INSUFFICIENT_QUOTA',
    }));
    expect(record.internalError).toBeUndefined();
  });

  it('[reverse] rejects invalid external link kind', () => {
    expect(() => linkExternalError({
      kind: 'internal' as never,
      status: 500,
    })).toThrow(/invalid external error link kind/);
  });
});
