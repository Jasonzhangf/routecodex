import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('token daemon server-utils non-blocking observability', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('distinguishes config load failures', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    jest.unstable_mockModule('../../src/config/routecodex-config-loader.js', () => ({
      loadRouteCodexConfig: async () => {
        throw new Error('config boom');
      }
    }));
    jest.unstable_mockModule('../../src/config/user-data-paths.js', () => ({
      resolveRccConfigFile: () => '/tmp/config.json'
    }));
    jest.unstable_mockModule('../../src/utils/http-health-probe.js', () => ({
      probeRouteCodexHealth: async () => ({ ok: true }),
      describeHealthProbeFailure: () => 'unused'
    }));

    const mod = await import('../../src/token-daemon/server-utils.js');
    const out = await mod.detectLocalServerInstanceDetailed();

    expect(out).toMatchObject({ ok: false, kind: 'config_error' });
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=detect_local_server');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=load_config');

    warnSpy.mockRestore();
  });

  it('distinguishes health probe fallback cause', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    jest.unstable_mockModule('../../src/config/routecodex-config-loader.js', () => ({
      loadRouteCodexConfig: async () => ({
        userConfig: {
          httpserver: {
            host: '127.0.0.1',
            port: 5555
          }
        }
      })
    }));
    jest.unstable_mockModule('../../src/config/user-data-paths.js', () => ({
      resolveRccConfigFile: () => '/tmp/config.json'
    }));
    jest.unstable_mockModule('../../src/utils/http-health-probe.js', () => ({
      probeRouteCodexHealth: async () => ({
        ok: false,
        kind: 'timeout'
      }),
      describeHealthProbeFailure: () => 'health timeout'
    }));

    const mod = await import('../../src/token-daemon/server-utils.js');
    const out = await mod.detectLocalServerInstanceDetailed();

    expect(out).toMatchObject({
      ok: true,
      server: { status: 'offline' },
      probe: { ok: false, kind: 'timeout' }
    });
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=detect_local_server');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=health_probe');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('"kind":"timeout"');

    warnSpy.mockRestore();
  });
});
