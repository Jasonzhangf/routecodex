import { describe, expect, it, jest } from '@jest/globals';

type SpawnSyncResult = {
  status?: number | null;
  error?: unknown;
  stdout?: string;
  stderr?: string;
};

type SpawnSyncEnv = Record<string, string | undefined>;
type SpawnSyncMock = jest.MockedFunction<
  (cmd: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => SpawnSyncResult
>;

async function loadLauncherWithSpawnSyncMock(spawnSyncMock: SpawnSyncMock) {
  jest.resetModules();
  await jest.unstable_mockModule('node:child_process', () => ({
    spawn: jest.fn(),
    spawnSync: spawnSyncMock
  }));
  return import('../../../../src/providers/core/config/camoufox-launcher.js');
}

describe('openAuthInCamoufox qwen goto timeout recovery', () => {
  it('continues auto flow when goto timeout occurs but qwen auth page is already active', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalPortalSettle = process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_SETTLE_MS;
    const originalPortalPoll = process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_POLL_MS;
    const originalGoogleSettle = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
    const originalGooglePoll = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_SETTLE_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = '1';

    const portalUrl =
      'http://127.0.0.1:59402/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize%3Fuser_code%3DW09G7IMP%26client%3Dqwen-code';
    const calls: string[][] = [];

    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      calls.push(normalizedArgs);
      if (normalizedArgs[0] === 'profile') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-qwen.default' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-qwen.default', sessionId: 'rc-qwen.default' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        return {
          status: 1,
          stdout: '',
          stderr: 'Error: page.goto: Timeout 30000ms exceeded.'
        };
      }
      if (normalizedArgs[0] === 'list-pages') {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            activeIndex: 0,
            pages: [
              {
                index: 0,
                active: true,
                url: 'https://chat.qwen.ai/authorize?user_code=W09G7IMP&client=qwen-code'
              }
            ]
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'devtools' && normalizedArgs[1] === 'eval') {
        const expression = String(normalizedArgs[3] || '');
        if (expression.includes('document.querySelectorAll(selector)')) {
          if (expression.includes('button.qwen-chat-btn')) {
            return { status: 0, stdout: JSON.stringify({ result: { value: 'button.qwen-chat-btn' } }), stderr: '' };
          }
          return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
        }
        return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: JSON.stringify({ ok: true, selector: normalizedArgs[2] }), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: portalUrl,
        provider: 'qwen',
        alias: 'default'
      });

      expect(ok).toBe(true);
      expect(calls).toContainEqual(['goto', 'rc-qwen.default', portalUrl]);
      expect(calls).toContainEqual(['click', 'rc-qwen.default', 'button.qwen-chat-btn', '--no-highlight']);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalAutoMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = originalAutoMode;
      }
      if (originalPortalSettle === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_SETTLE_MS = originalPortalSettle;
      }
      if (originalPortalPoll === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_POLL_MS = originalPortalPoll;
      }
      if (originalGoogleSettle === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = originalGoogleSettle;
      }
      if (originalGooglePoll === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = originalGooglePoll;
      }
    }
  });
});
