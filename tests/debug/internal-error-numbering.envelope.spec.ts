import { describe, expect, it } from '@jest/globals';

import {
  buildDebugErrorDiagArtifactRecord,
} from '../../src/debug/diag/index.js';
import {
  buildInternalDebugErrorEnvelope,
  projectInternalDebugErrorToDebugArtifact,
} from '../../src/debug/internal-error/index.js';

describe('feature_id: debug.internal_error_numbering envelope', () => {
  it('builds internal debug envelopes and projects them into debug artifacts only', () => {
    const envelope = buildInternalDebugErrorEnvelope({
      code: '500-100',
      stage: 'ServerReqInbound01ClientRaw',
      message: 'request adapter invariant failed',
      requestId: 'req-ien-1',
      details: { field: 'body' },
    });

    expect(envelope).toEqual(expect.objectContaining({
      internalCode: '500-100',
      lane: 'request',
      nodeId: 'ServerReqInbound01ClientRaw',
      ownerFeatureId: 'server.responses_request_handler_bridge_surface',
    }));

    const projection = projectInternalDebugErrorToDebugArtifact(envelope);
    const record = buildDebugErrorDiagArtifactRecord({
      endpoint: '/v1/responses',
      requestId: 'req-ien-1',
      requestBody: { input: 'hello' },
      error: new Error('debug artifact write'),
      internalError: projection.internalError,
      timestamp: '2026-06-29T00:00:00.000Z',
    });

    expect(record.internalError?.internalCode).toBe('500-100');
    expect(record).not.toHaveProperty('externalError');
  });

  it('[reverse] rejects missing required external link and disallowed external link', () => {
    expect(() => buildInternalDebugErrorEnvelope({
      code: '500-200',
      stage: 'ProviderRespInbound01Raw',
      message: 'raw response staging failed',
    })).toThrow(/requires externalLink/);

    expect(() => buildInternalDebugErrorEnvelope({
      code: '500-110',
      stage: 'HubReqInbound02Standardized',
      message: 'standardization failed',
      externalLink: { kind: 'provider', status: 503 },
    })).toThrow(/does not allow externalLink/);
  });
});
