import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { warmupCheckAntigravityAlias } from '../../../src/providers/auth/antigravity-warmup.js';
import { readAntigravityReauthRequiredState } from '../../../src/providers/auth/antigravity-reauth-state.js';

async function writeCamoufoxFingerprint(homeDir: string, alias: string, camouConfig: Record<string, unknown>): Promise<void> {
  const fpDir = path.join(homeDir, '.routecodex', 'camoufox-fp');
  await fs.mkdir(fpDir, { recursive: true });
  const fpPath = path.join(fpDir, `rc-gemini.${alias}.json`);
  await fs.writeFile(fpPath, JSON.stringify({ env: { CAMOU_CONFIG_1: JSON.stringify(camouConfig) } }, null, 2));
}

describe('antigravity-warmup', () => {
  const originalEnv = { ...process.env };
  let tempHome: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ua-warmup-'));
    process.env.HOME = tempHome;

    // Keep tests hermetic: never hit remote version endpoint.
    process.env.ROUTECODEX_ANTIGRAVITY_UA_DISABLE_REMOTE = '1';
    process.env.ROUTECODEX_ANTIGRAVITY_UA_VERSION = '1.11.9';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('passes when UA suffix matches alias fingerprint', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Win32',
      'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
      'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profileId).toBe('rc-gemini.test');
      expect(result.expectedSuffix).toBe('windows/amd64');
      expect(result.actualSuffix).toBe('windows/amd64');
      expect(result.actualUserAgent).toBe('antigravity/1.11.9 windows/amd64');
    }
  });

  test('fails when operator forces mismatching UA suffix', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Win32',
      'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
      'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    process.env.ROUTECODEX_ANTIGRAVITY_UA_SUFFIX = 'macos/amd64';

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ua_suffix_mismatch');
      expect(result.expectedSuffix).toBe('windows/amd64');
      expect(result.actualSuffix).toBe('macos/amd64');
    }
  });

  test('fails when fingerprint indicates linux (not allowed)', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Linux x86_64',
      'navigator.oscpu': 'Linux x86_64',
      'navigator.userAgent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('linux_not_allowed');
      expect(result.expectedSuffix).toBe('linux/amd64');
    }
  });

  test('fails when alias is marked reauth-required', async () => {
    const stateDir = path.join(tempHome, '.routecodex', 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'antigravity-reauth-required.json'),
      JSON.stringify(
        {
          test: {
            provider: 'antigravity',
            alias: 'test',
            tokenFile: 'antigravity-oauth-1-test.json',
            profileId: 'rc-gemini.test',
            fromSuffix: 'linux/amd64',
            toSuffix: 'windows/amd64',
            updatedAt: Date.now()
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('reauth_required');
      expect(result.tokenFile).toBe('antigravity-oauth-1-test.json');
      expect(result.fromSuffix).toBe('linux/amd64');
      expect(result.toSuffix).toBe('windows/amd64');
    }
  });

  test('auto-clears stale reauth-required marker after successful token refresh', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Win32',
      'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
      'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    // Create a token file with a newer mtime than the marker so warmup can verify freshness.
    const tokenDir = path.join(tempHome, '.routecodex', 'auth');
    await fs.mkdir(tokenDir, { recursive: true });
    const tokenPath = path.join(tokenDir, 'antigravity-oauth-1-test.json');
    await fs.writeFile(tokenPath, JSON.stringify({ dummy: true }, null, 2), 'utf8');

    const updatedAt = Date.now() - 60_000;
    const stateDir = path.join(tempHome, '.routecodex', 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'antigravity-reauth-required.json'),
      JSON.stringify(
        {
          test: {
            provider: 'antigravity',
            alias: 'test',
            tokenFile: tokenPath,
            profileId: 'rc-gemini.test',
            fromSuffix: 'linux/amd64',
            toSuffix: 'windows/amd64',
            updatedAt
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(true);

    const state = await readAntigravityReauthRequiredState();
    expect(state).not.toHaveProperty('test');
  });

  test('auto-clears stale reauth-required marker even when tokenFile is missing (best-effort scan)', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Win32',
      'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
      'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    const tokenDir = path.join(tempHome, '.routecodex', 'auth');
    await fs.mkdir(tokenDir, { recursive: true });
    const tokenPath = path.join(tokenDir, 'antigravity-oauth-3-test.json');
    await fs.writeFile(tokenPath, JSON.stringify({ dummy: true }, null, 2), 'utf8');

    const updatedAt = Date.now() - 60_000;
    const stateDir = path.join(tempHome, '.routecodex', 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'antigravity-reauth-required.json'),
      JSON.stringify(
        {
          test: {
            provider: 'antigravity',
            alias: 'test',
            profileId: 'rc-gemini.test',
            fromSuffix: 'linux/amd64',
            toSuffix: 'windows/amd64',
            updatedAt
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(true);

    const state = await readAntigravityReauthRequiredState();
    expect(state).not.toHaveProperty('test');
  });

  test('fails when fingerprint is missing', async () => {
    const result = await warmupCheckAntigravityAlias('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_fingerprint');
    }
  });
});
