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

  it('accepts native V3 health body without legacy server marker', async () => {
    const probe = await probeRouteCodexHealth({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          bind: '0.0.0.0',
          manifest_version: 3,
          port: 5555,
          server_id: 'responses_v3_5555',
          status: 'ok',
          version: 3
        })
      })) as any,
      host: '127.0.0.1',
      port: 5555,
      timeoutMs: 10
    });

    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.body.server_id).toBe('responses_v3_5555');
      expect(probe.body.manifest_version).toBe(3);
    }
  });

  it('classifies routecodex starting body distinctly without treating it as bad_status', async () => {
    const probe = await probeRouteCodexHealth({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          server: 'routecodex',
          status: 'starting',
          ready: false,
          pipelineReady: false
        })
      })) as any,
      host: '127.0.0.1',
      port: 5520,
      timeoutMs: 10
    });

    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.kind).toBe('starting');
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
