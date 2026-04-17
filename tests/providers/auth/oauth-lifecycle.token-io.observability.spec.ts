import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

describe('oauth token-io non-blocking observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    delete process.env.ROUTECODEX_OAUTH_DEBUG;
  });

  it('logs parse failures when reading token files and keeps null contract', async () => {
    jest.resetModules();
    process.env.ROUTECODEX_OAUTH_DEBUG = '1';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-token-io-'));
    const tokenFile = path.join(tmpDir, 'broken-token.json');
    fs.writeFileSync(tokenFile, '{"broken"', 'utf8');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { readTokenFromFile } = await import('../../../src/providers/auth/oauth-lifecycle/token-io.js');
      await expect(readTokenFromFile(tokenFile)).resolves.toBeNull();
      expect(
        logSpy.mock.calls.some(([message]) => String(message).includes('token.read failed (non-blocking)'))
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('logs backup cleanup failures instead of silently swallowing them', async () => {
    jest.resetModules();
    process.env.ROUTECODEX_OAUTH_DEBUG = '1';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-token-io-'));
    const targetFile = path.join(tmpDir, 'target.json');
    const backupFile = path.join(tmpDir, 'backup.json');
    fs.writeFileSync(targetFile, '{"ok":true}\n', 'utf8');
    fs.writeFileSync(backupFile, '{"bak":true}\n', 'utf8');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const fsPromises = await import('node:fs/promises');
      const unlinkSpy = jest.spyOn(fsPromises.default ?? fsPromises, 'unlink').mockRejectedValueOnce(new Error('unlink denied'));
      const { restoreTokenFileFromBackup } = await import('../../../src/providers/auth/oauth-lifecycle/token-io.js');

      await restoreTokenFileFromBackup(backupFile, targetFile);

      expect(unlinkSpy).toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some(([message]) => String(message).includes('token.restore.cleanupBackup failed (non-blocking)'))
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
