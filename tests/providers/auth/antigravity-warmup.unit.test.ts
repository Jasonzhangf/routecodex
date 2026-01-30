import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { warmupCheckAntigravityAlias } from '../../../src/providers/auth/antigravity-warmup.js';

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
      'navigator.platform': 'Linux x86_64',
      'navigator.oscpu': 'Linux x86_64',
      'navigator.userAgent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expectedSuffix).toBe('linux/amd64');
      expect(result.actualSuffix).toBe('linux/amd64');
      expect(result.actualUserAgent).toBe('antigravity/1.11.9 linux/amd64');
    }
  });

  test('fails when operator forces mismatching UA suffix', async () => {
    await writeCamoufoxFingerprint(tempHome, 'test', {
      'navigator.platform': 'Linux x86_64',
      'navigator.oscpu': 'Linux x86_64',
      'navigator.userAgent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    process.env.ROUTECODEX_ANTIGRAVITY_UA_SUFFIX = 'windows/amd64';

    const result = await warmupCheckAntigravityAlias('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ua_suffix_mismatch');
      expect(result.expectedSuffix).toBe('linux/amd64');
      expect(result.actualSuffix).toBe('windows/amd64');
    }
  });

  test('fails when fingerprint is missing', async () => {
    const result = await warmupCheckAntigravityAlias('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_fingerprint');
    }
  });
});

