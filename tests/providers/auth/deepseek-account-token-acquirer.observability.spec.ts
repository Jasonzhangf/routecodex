import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

describe('deepseek-account-token-acquirer observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('logs JSON parse failures instead of silently returning undefined', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { __deepSeekAccountTokenAcquirerTestables } = await import(
      '../../../src/providers/auth/deepseek-account-token-acquirer.js'
    );

    expect(__deepSeekAccountTokenAcquirerTestables.tryParseJson('{"broken"', 'unit:invalid-json')).toBeUndefined();
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes('tryParseJson failed (non-blocking)'))
    ).toBe(true);
  });

  it('logs credential file read failures instead of silently collapsing to null', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { __deepSeekAccountTokenAcquirerTestables } = await import(
      '../../../src/providers/auth/deepseek-account-token-acquirer.js'
    );

    const missingFile = path.join(os.tmpdir(), `routecodex-missing-${Date.now()}.json`);
    await expect(__deepSeekAccountTokenAcquirerTestables.resolveCredentialFromFile(missingFile)).resolves.toBeNull();
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes('resolveCredentialFromFile failed (non-blocking)'))
    ).toBe(true);
  });

  it('logs fingerprint load failures instead of silently dropping camoufox metadata', async () => {
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-deepseek-fp-'));
    process.env.HOME = tmpHome;

    const profileDir = path.join(tmpHome, '.rcc', 'camoufox-profiles', 'deepseek-default');
    const fingerprintDir = path.join(tmpHome, '.rcc', 'camoufox-fp');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(fingerprintDir, { recursive: true });
    fs.writeFileSync(path.join(fingerprintDir, 'deepseek-default.json'), '{"broken"', 'utf8');

    jest.unstable_mockModule('../../../src/providers/core/config/camoufox-launcher.js', () => ({
      ensureCamoufoxFingerprintForToken: () => {},
      getCamoufoxProfileDir: () => profileDir
    }));

    try {
      const { __deepSeekAccountTokenAcquirerTestables } = await import(
        '../../../src/providers/auth/deepseek-account-token-acquirer.js'
      );

      await expect(
        __deepSeekAccountTokenAcquirerTestables.loadCamoufoxFingerprint('deepseek', 'default')
      ).resolves.toBeNull();
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes('loadCamoufoxFingerprint failed (non-blocking)'))
      ).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
