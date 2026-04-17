import { describe, expect, it } from '@jest/globals';

import {
  probeGuardianHealth,
  probeRouteCodexHealth
} from '../../src/utils/http-health-probe.js';

describe('http-health-probe', () => {
  it('classifies routecodex bad_json distinctly', async () => {
    const probe = await probeRouteCodexHealth({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => 'not-json'
      })) as any,
      host: '127.0.0.1',
      port: 5520,
      timeoutMs: 10
    });

    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.kind).toBe('bad_json');
      expect(probe.status).toBe(200);
      expect(probe.bodySnippet).toBe('not-json');
    }
  });

  it('classifies non-routecodex health body explicitly', async () => {
    const probe = await probeRouteCodexHealth({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'other-service', status: 'ok' })
      })) as any,
      host: '127.0.0.1',
      port: 5520,
      timeoutMs: 10
    });

    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.kind).toBe('not_routecodex');
      expect(probe.status).toBe(200);
    }
  });

  it('classifies guardian auth_error distinctly', async () => {
    const probe = await probeGuardianHealth({
      fetchImpl: (async () => ({
        ok: false,
        status: 403,
        text: async () => '{"error":"forbidden"}'
      })) as any,
      port: 5511,
      token: 'guardian-token',
      timeoutMs: 10
    });

    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.kind).toBe('auth_error');
      expect(probe.status).toBe(403);
    }
  });
});
