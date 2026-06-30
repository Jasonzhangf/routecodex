import { describe, expect, it } from '@jest/globals';

import {
  assertInternalDebugErrorDoesNotLeakToClient,
  assertInternalDebugErrorDoesNotLeakToProvider,
  buildInternalDebugErrorEnvelope,
} from '../../src/debug/internal-error/index.js';

describe('feature_id: debug.internal_error_numbering leak gate', () => {
  it('allows normal payloads without internal envelopes', () => {
    const clientPayload = { error: { message: 'upstream provider error', code: 'upstream_error' } };
    const providerPayload = { model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hello' }] };

    expect(() => assertInternalDebugErrorDoesNotLeakToClient(clientPayload)).not.toThrow();
    expect(() => assertInternalDebugErrorDoesNotLeakToProvider(providerPayload)).not.toThrow();
  });

  it('[reverse] rejects internal envelopes in client/provider normal payloads', () => {
    const envelope = buildInternalDebugErrorEnvelope({
      code: '500-300',
      stage: 'DebugObs05HarnessExecuted',
      message: 'debug artifact projection failed',
    });

    expect(() => assertInternalDebugErrorDoesNotLeakToClient({ error: envelope })).toThrow(/client normal payload/);
    expect(() => assertInternalDebugErrorDoesNotLeakToProvider({ metadata: { debug: envelope } })).toThrow(/provider wire payload/);
  });
});
