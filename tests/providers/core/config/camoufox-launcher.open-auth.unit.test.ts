import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

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

function writeFingerprintFixture(homeDir: string, profileId: string): void {
  const fpDir = path.join(homeDir, '.routecodex', 'camoufox-fp');
  fs.mkdirSync(fpDir, { recursive: true });
  fs.writeFileSync(
    path.join(fpDir, `${profileId}.json`),
    JSON.stringify({
      env: {
        CAMOU_CONFIG_1: JSON.stringify({
          'navigator.platform': 'Win32'
        })
      }
    }),
    'utf8'
  );
}

describe('openAuthInCamoufox portal flow', () => {
  it('runs start -> goto -> click for token portal URL', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalRetries = process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES;
    const originalRetryDelay = process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES = '2';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'status') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, session: { profileId: 'rc-iflow.138' } }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'list') {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            sessions: listCalls === 1 ? [] : [{ profileId: 'rc-iflow.138' }]
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-iflow.138', sessionId: 'rc-iflow.138' }),
          stderr: ''
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-iflow.138');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth',
        provider: 'iflow',
        alias: '138'
      });

      expect(ok).toBe(true);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual(['profile', 'default', 'rc-iflow.138']);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'start',
        'rc-iflow.138',
        '--headless',
        '--idle-timeout',
        '30m'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'goto',
        'rc-iflow.138',
        'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-iflow.138',
        '#continue-btn',
        '--no-highlight'
      ]);
      const profileRoot = path.join('/tmp', '.routecodex', 'camoufox-profiles');
      expect(
        spawnCalls.some((entry) => entry.env?.WEBAUTO_PATHS_PROFILES === profileRoot)
      ).toBe(true);
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
      if (originalRetries === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES = originalRetries;
      }
      if (originalRetryDelay === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS = originalRetryDelay;
      }
    }
  });

  it('returns false when auto mode requires portal click but click keeps failing', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalRetries = process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES;
    const originalRetryDelay = process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES = '3';
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'status') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, session: { profileId: 'rc-iflow.138' } }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-iflow.138' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-iflow.138', sessionId: 'rc-iflow.138' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 1, stdout: '', stderr: 'click failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-iflow.138');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth',
        provider: 'iflow',
        alias: '138'
      });

      expect(ok).toBe(false);
      const clickCalls = spawnCalls.filter((entry) => entry.args[0] === 'click');
      expect(clickCalls).toHaveLength(3);
      const profileRoot = path.join('/tmp', '.routecodex', 'camoufox-profiles');
      expect(
        spawnCalls.some((entry) => entry.env?.WEBAUTO_PATHS_PROFILES === profileRoot)
      ).toBe(true);
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
      if (originalRetries === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES = originalRetries;
      }
      if (originalRetryDelay === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS = originalRetryDelay;
      }
    }
  });

  it('auto-creates fingerprint env when missing instead of failing launch', async () => {
    const originalHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join('/tmp', 'routecodex-camoufox-fp-missing-'));
    process.env.HOME = tmpHome;

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'status') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, session: { profileId: 'rc-qwen.135' } }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'list') {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            sessions: listCalls === 1 ? [] : [{ profileId: 'rc-qwen.135' }]
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-qwen.135', sessionId: 'rc-qwen.135' }),
          stderr: ''
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize',
        provider: 'qwen',
        alias: '135'
      });

      expect(ok).toBe(true);
      expect(
        spawnCalls.some(
          (entry) =>
            entry.args[0] === 'profile' &&
            entry.args[1] === 'create' &&
            entry.args[2] === 'rc-qwen.135'
        )
      ).toBe(true);
      expect(
        spawnCalls.some(
          (entry) =>
            Boolean(entry.env?.CAMOU_CONFIG_1) &&
            entry.env?.BROWSER_PROFILE_ID === 'rc-qwen.135'
        )
      ).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  it('skips portal click when active page is already direct oauth url after fallback', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalIflowAccountRetries = process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRIES;
    const originalIflowAccountRetryDelay = process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRY_DELAY_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
    process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRIES = '1';
    process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRY_DELAY_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-iflow.138' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-iflow.138', sessionId: 'rc-iflow.138' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        const targetUrl = normalizedArgs[2] || '';
        if (targetUrl.includes('/token-auth/demo')) {
          return { status: 1, stdout: '', stderr: 'goto timeout' };
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list-pages') {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            activeIndex: 0,
            pages: [{ index: 0, active: true, url: 'https://iflow.cn/oauth?state=abc' }]
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-iflow.138');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth',
        provider: 'iflow',
        alias: '138'
      });

      expect(ok).toBe(true);
      const portalClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && entry.args[2] === '#continue-btn'
      );
      expect(portalClickCalls).toHaveLength(0);
      const accountClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && String(entry.args[2] || '').includes('accountItem--')
      );
      expect(accountClickCalls.length).toBeGreaterThanOrEqual(1);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'goto',
        'rc-iflow.138',
        'https://iflow.cn/oauth'
      ]);
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
      if (originalIflowAccountRetries === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRIES;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRIES = originalIflowAccountRetries;
      }
      if (originalIflowAccountRetryDelay === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRY_DELAY_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_IFLOW_ACCOUNT_CLICK_RETRY_DELAY_MS = originalIflowAccountRetryDelay;
      }
    }
  });

  it('keeps portal in headful mode when portal goto returns non-zero', async () => {
    const originalHome = process.env.HOME;
    const originalDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-iflow.138' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-iflow.138', sessionId: 'rc-iflow.138' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        const targetUrl = normalizedArgs[2] || '';
        if (targetUrl.includes('/token-auth/demo')) {
          return { status: 1, stdout: '', stderr: 'goto timeout' };
        }
      }
      if (normalizedArgs[0] === 'list-pages') {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            activeIndex: 0,
            pages: [{ index: 0, active: true, url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=x' }]
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 1, stdout: '', stderr: 'headful should not auto-click portal' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-iflow.138');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth',
        provider: 'iflow',
        alias: '138'
      });

      expect(ok).toBe(true);
      const gotoCalls = spawnCalls.filter((entry) => entry.args[0] === 'goto').map((entry) => entry.args);
      expect(gotoCalls).toEqual([[
        'goto',
        'rc-iflow.138',
        'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth'
      ]]);
      const clickCalls = spawnCalls.filter((entry) => entry.args[0] === 'click');
      expect(clickCalls).toHaveLength(0);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalDevMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = originalDevMode;
      }
    }
  });

  it('waits for iflow oauth page after portal click before account selection', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalSettleMs = process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_SETTLE_MS;
    const originalPollMs = process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_POLL_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
    process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_POLL_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listPagesCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-iflow.138' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-iflow.138', sessionId: 'rc-iflow.138' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list-pages') {
        listPagesCalls += 1;
        const url = listPagesCalls < 3
          ? 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth'
          : 'https://iflow.cn/oauth?state=abc';
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, activeIndex: 0, pages: [{ index: 0, active: true, url }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-iflow.138');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fiflow.cn%2Foauth',
        provider: 'iflow',
        alias: '138'
      });

      expect(ok).toBe(true);
      const portalClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && entry.args[2] === '#continue-btn'
      );
      expect(portalClickCalls.length).toBeGreaterThanOrEqual(1);
      const accountClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && String(entry.args[2] || '').includes('accountItem--')
      );
      expect(accountClickCalls.length).toBeGreaterThanOrEqual(1);
      expect(listPagesCalls).toBeGreaterThanOrEqual(3);
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
      if (originalSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_SETTLE_MS = originalSettleMs;
      }
      if (originalPollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_IFLOW_OAUTH_POLL_MS = originalPollMs;
      }
    }
  });

  it('advances qwen login page through Google auto flow instead of falling back to manual', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalQwenSettle = process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS;
    const originalQwenPoll = process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS;
    const originalGoogleSettle = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
    const originalGooglePoll = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
    const originalGoogleRetries = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRIES;
    const originalGoogleRetryDelay = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRY_DELAY_MS;
    const originalGoogleSignInSettle = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
    const originalGoogleSignInPoll = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRIES = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRY_DELAY_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listPagesCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-qwen.135' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, profileId: 'rc-qwen.135', sessionId: 'rc-qwen.135' }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list-pages') {
        listPagesCalls += 1;
        const url = (() => {
          if (listPagesCalls <= 2) {
            return 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize';
          }
          if (listPagesCalls <= 4) {
            return 'https://chat.qwen.ai/auth?user_code=ABCD1234&client=qwen-code';
          }
          return 'https://accounts.google.com/signin/oauth/consent?state=abc';
        })();
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, activeIndex: 0, pages: [{ index: 0, active: true, url }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'devtools' && normalizedArgs[1] === 'eval') {
        const expr = normalizedArgs[3] || '';
        if (expr.includes('document.querySelectorAll(selector)')) {
          if (expr.includes('.qwenchat-auth-pc-other-login-button')) {
            return { status: 0, stdout: JSON.stringify({ result: { value: '.qwenchat-auth-pc-other-login-button' } }), stderr: '' };
          }
          if (expr.includes('div[data-identifier]')) {
            return { status: 0, stdout: JSON.stringify({ result: { value: 'div[data-identifier]' } }), stderr: '' };
          }
          return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
        }
        if (expr.includes('[data-rcx-google-signin="1"]') || expr.includes('[data-rcx-signin="1"]')) {
          return { status: 0, stdout: JSON.stringify({ result: { value: false } }), stderr: '' };
        }
        return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-qwen.135');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize',
        provider: 'qwen',
        alias: '135'
      });

      expect(ok).toBe(true);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.135',
        '#continue-btn',
        '--no-highlight'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.135',
        '.qwenchat-auth-pc-other-login-button',
        '--no-highlight'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.135',
        'div[data-identifier]',
        '--no-highlight'
      ]);
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
      if (originalQwenSettle === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS = originalQwenSettle;
      }
      if (originalQwenPoll === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS = originalQwenPoll;
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
      if (originalGoogleRetries === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRIES;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRIES = originalGoogleRetries;
      }
      if (originalGoogleRetryDelay === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRY_DELAY_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRY_DELAY_MS = originalGoogleRetryDelay;
      }
      if (originalGoogleSignInSettle === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = originalGoogleSignInSettle;
      }
      if (originalGoogleSignInPoll === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = originalGoogleSignInPoll;
      }
    }
  });

  it('waits for google auth page after portal click before google account selection', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalSettleMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
    const originalPollMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
    const originalSignInSettleMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
    const originalSignInPollMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = '10';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listPagesCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, sessions: [{ profileId: 'rc-qwen.geetasamodgeetasamoda' }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'start') {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            profileId: 'rc-qwen.geetasamodgeetasamoda',
            sessionId: 'rc-qwen.geetasamodgeetasamoda'
          }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'goto') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list-pages') {
        listPagesCalls += 1;
        const url = listPagesCalls < 3
          ? 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth'
          : 'https://accounts.google.com/v3/signin/accountchooser?flowName=GeneralOAuthFlow';
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, activeIndex: 0, pages: [{ index: 0, active: true, url }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-qwen.geetasamodgeetasamoda');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth',
        provider: 'qwen',
        alias: 'geetasamodgeetasamoda'
      });

      expect(ok).toBe(true);
      const portalClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && entry.args[2] === '#continue-btn'
      );
      expect(portalClickCalls.length).toBeGreaterThanOrEqual(1);
      const googleAccountClickCalls = spawnCalls.filter(
        (entry) => entry.args[0] === 'click' && String(entry.args[2] || '').includes('data-identifier')
      );
      expect(googleAccountClickCalls.length).toBeGreaterThanOrEqual(1);
      expect(listPagesCalls).toBeGreaterThanOrEqual(3);
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
      if (originalSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = originalSettleMs;
      }
      if (originalPollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = originalPollMs;
      }
      if (originalSignInSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = originalSignInSettleMs;
      }
      if (originalSignInPollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = originalSignInPollMs;
      }
    }
  });

  it('keeps qwen auto progressing when portal settles to qwen login before google auth', async () => {
    const originalHome = process.env.HOME;
    const originalAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const originalQwenSettleMs = process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS;
    const originalQwenPollMs = process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS;
    const originalGoogleSettleMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
    const originalGooglePollMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
    const originalGoogleSignInSettleMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
    const originalGoogleSignInPollMs = process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
    process.env.HOME = '/tmp';
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS = '5';
    process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = '5';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = '1';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = '5';
    process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = '1';

    const spawnCalls: Array<{ args: string[]; env?: SpawnSyncEnv }> = [];
    let listPagesCalls = 0;
    const spawnSyncMock = jest.fn((_: string, args?: ReadonlyArray<string>, options?: { env?: SpawnSyncEnv }) => {
      const normalizedArgs = Array.isArray(args) ? [...args] : [];
      spawnCalls.push({ args: normalizedArgs, env: options?.env });
      if (normalizedArgs[0] === 'status') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, session: { profileId: 'rc-qwen.default' } }),
          stderr: ''
        };
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
        return { status: 0, stdout: '', stderr: '' };
      }
      if (normalizedArgs[0] === 'list-pages') {
        listPagesCalls += 1;
        const url = (() => {
          if (listPagesCalls <= 4) {
            return 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize';
          }
          if (listPagesCalls <= 6) {
            return 'https://chat.qwen.ai/auth?user_code=ABCD1234&client=qwen-code';
          }
          return 'https://accounts.google.com/signin/oauth/consent?state=abc';
        })();
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, activeIndex: 0, pages: [{ index: 0, active: true, url }] }),
          stderr: ''
        };
      }
      if (normalizedArgs[0] === 'devtools' && normalizedArgs[1] === 'eval') {
        const expr = normalizedArgs[3] || '';
        if (expr.includes('document.querySelectorAll(selector)')) {
          if (expr.includes('.qwenchat-auth-pc-other-login-button')) {
            return { status: 0, stdout: JSON.stringify({ result: { value: '.qwenchat-auth-pc-other-login-button' } }), stderr: '' };
          }
          if (expr.includes('div[data-identifier]')) {
            return { status: 0, stdout: JSON.stringify({ result: { value: 'div[data-identifier]' } }), stderr: '' };
          }
          return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
        }
        if (expr.includes('[data-rcx-google-signin="1"]') || expr.includes('[data-rcx-signin="1"]')) {
          return { status: 0, stdout: JSON.stringify({ result: { value: false } }), stderr: '' };
        }
        return { status: 0, stdout: JSON.stringify({ result: { value: '' } }), stderr: '' };
      }
      if (normalizedArgs[0] === 'click') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as SpawnSyncMock;

    try {
      writeFingerprintFixture('/tmp', 'rc-qwen.default');
      const launcher = await loadLauncherWithSpawnSyncMock(spawnSyncMock);
      const ok = await launcher.openAuthInCamoufox({
        url: 'http://127.0.0.1:18080/token-auth/demo?oauthUrl=https%3A%2F%2Fchat.qwen.ai%2Fauthorize',
        provider: 'qwen',
        alias: 'default'
      });

      expect(ok).toBe(true);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.default',
        '#continue-btn',
        '--no-highlight'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.default',
        '.qwenchat-auth-pc-other-login-button',
        '--no-highlight'
      ]);
      expect(spawnCalls.map((entry) => entry.args)).toContainEqual([
        'click',
        'rc-qwen.default',
        'div[data-identifier]',
        '--no-highlight'
      ]);
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
      if (originalQwenSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS = originalQwenSettleMs;
      }
      if (originalQwenPollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS = originalQwenPollMs;
      }
      if (originalGoogleSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS = originalGoogleSettleMs;
      }
      if (originalGooglePollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS = originalGooglePollMs;
      }
      if (originalGoogleSignInSettleMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS = originalGoogleSignInSettleMs;
      }
      if (originalGoogleSignInPollMs === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS = originalGoogleSignInPollMs;
      }
    }
  });
});
