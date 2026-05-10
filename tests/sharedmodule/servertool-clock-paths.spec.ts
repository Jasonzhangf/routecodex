import { jest } from '@jest/globals';

describe('servertool clock paths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('prefers ROUTECODEX_SESSION_DIR when set', async () => {
    process.env.ROUTECODEX_SESSION_DIR = '/tmp/rcc-sessions';
    delete process.env.RCC_SESSION_DIR;
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_HOME;
    delete process.env.ROUTECODEX_USER_DIR;

    const { readSessionDirEnv } = await import('../../sharedmodule/llmswitch-core/src/servertool/clock/paths.js');

    expect(readSessionDirEnv()).toBe('/tmp/rcc-sessions');
  });

  it('falls back to RCC_SESSION_DIR when ROUTECODEX_SESSION_DIR is absent', async () => {
    delete process.env.ROUTECODEX_SESSION_DIR;
    process.env.RCC_SESSION_DIR = '/tmp/rcc-sessions-fallback';

    const { readSessionDirEnv } = await import('../../sharedmodule/llmswitch-core/src/servertool/clock/paths.js');

    expect(readSessionDirEnv()).toBe('/tmp/rcc-sessions-fallback');
  });

  it('falls back to RCC_HOME sessions dir when env is missing or invalid', async () => {
    process.env.ROUTECODEX_SESSION_DIR = 'undefined';
    delete process.env.RCC_SESSION_DIR;
    process.env.RCC_HOME = '/tmp/rcc-home';
    delete process.env.ROUTECODEX_HOME;
    delete process.env.ROUTECODEX_USER_DIR;

    const { readSessionDirEnv } = await import('../../sharedmodule/llmswitch-core/src/servertool/clock/paths.js');

    expect(readSessionDirEnv()).toBe('/tmp/rcc-home/sessions');
  });
});
