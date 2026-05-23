import { describe, expect, it } from '@jest/globals';
import { enforceWindsurfStartupProbeForHandle } from '../../../src/server/runtime/http-server/windsurf-startup-probe.js';

describe('Windsurf runtime startup probe', () => {
  it('rejects the runtime handle when Windsurf startup checkHealth returns false', async () => {
    const previous = process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE;
    delete process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE;
    try {
      await expect(enforceWindsurfStartupProbeForHandle({
        providerFamily: 'windsurf',
        runtimeKey: 'windsurf.ws-pro-bad',
        instance: { checkHealth: async () => false }
      })).rejects.toMatchObject({ code: 'WINDSURF_STARTUP_PROBE_FAILED' });
    } finally {
      if (previous === undefined) delete process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE;
      else process.env.ROUTECODEX_WINDSURF_STARTUP_PROBE = previous;
    }
  });

  it('allows non-windsurf providers without probing', async () => {
    await expect(enforceWindsurfStartupProbeForHandle({
      providerFamily: 'openai',
      runtimeKey: 'openai.key1',
      instance: { checkHealth: async () => false }
    })).resolves.toBeUndefined();
  });
});
