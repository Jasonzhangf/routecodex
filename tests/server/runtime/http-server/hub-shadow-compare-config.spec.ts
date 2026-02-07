import { jest } from '@jest/globals';

describe('Hub shadow compare default gating', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  async function resolveConfig() {
    const mod = await import('../../../../src/server/runtime/http-server/hub-shadow-compare.js');
    return mod.resolveHubShadowCompareConfig();
  }

  it('defaults to disabled for normal routecodex package', async () => {
    delete process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE;
    delete process.env.ROUTECODEX_PACKAGE_NAME;

    const config = await resolveConfig();
    expect(config.enabled).toBe(false);
  });

  it('defaults to enabled for rccx package', async () => {
    delete process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE;
    process.env.ROUTECODEX_PACKAGE_NAME = '@jsonstudio/rccx';

    const config = await resolveConfig();
    expect(config.enabled).toBe(true);
  });

  it('allows env override to disable even for rccx package', async () => {
    process.env.ROUTECODEX_PACKAGE_NAME = '@jsonstudio/rccx';
    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE = '0';

    const config = await resolveConfig();
    expect(config.enabled).toBe(false);
  });

  it('allows env override to enable for non-rccx package', async () => {
    process.env.ROUTECODEX_PACKAGE_NAME = 'routecodex';
    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE = '1';

    const config = await resolveConfig();
    expect(config.enabled).toBe(true);
  });
});
