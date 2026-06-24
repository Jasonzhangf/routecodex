import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { collectTokenSnapshot } from '../../src/token-daemon/token-utils.js';
import { TokenDaemon } from '../../src/token-daemon/token-daemon.js';

describe('token-daemon ecodev token management', () => {
  const prevAuthDir = process.env.ROUTECODEX_AUTH_DIR;
  const prevRccAuthDir = process.env.RCC_AUTH_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (prevAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevAuthDir;
    }
    if (prevRccAuthDir === undefined) {
      delete process.env.RCC_AUTH_DIR;
    } else {
      process.env.RCC_AUTH_DIR = prevRccAuthDir;
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('collects EcoDev OAuth token files and supports provider selector aliases', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-daemon-'));
    tempDirs.push(authDir);
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    process.env.RCC_AUTH_DIR = authDir;

    await fs.writeFile(path.join(authDir, 'ecodev-oauth-1-default.json'), '{"access_token":"token-1"}\n', 'utf8');
    await fs.writeFile(path.join(authDir, 'ecodev-oauth-2-backup.json'), '{"access_token":"token-2"}\n', 'utf8');

    const snapshot = await collectTokenSnapshot();
    const ecodev = snapshot.providers.find((item) => item.provider === 'ecodev');
    expect(ecodev).toBeDefined();
    expect(ecodev?.tokens.map((token) => token.alias)).toEqual(['default', 'backup']);

    const byFamily = await TokenDaemon.findTokenBySelector('ecodev');
    expect(byFamily?.provider).toBe('ecodev');
    expect(byFamily?.alias).toBe('default');

    const byFile = await TokenDaemon.findTokenBySelector('ecodev-oauth-2-backup.json');
    expect(byFile?.provider).toBe('ecodev');
    expect(byFile?.alias).toBe('backup');
  });

  it('creates synthetic EcoDev token descriptors for new account selectors', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-daemon-'));
    tempDirs.push(authDir);
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    process.env.RCC_AUTH_DIR = authDir;

    const byFile = await TokenDaemon.findTokenBySelector('ecodev-oauth-2-backup.json');
    expect(byFile).toMatchObject({
      provider: 'ecodev',
      alias: 'backup',
      sequence: 2,
      filePath: path.join(authDir, 'ecodev-oauth-2-backup.json')
    });
    expect(byFile?.state.status).toBe('invalid');

    const byAlias = await TokenDaemon.findTokenBySelector('ecodev:backup');
    expect(byAlias).toMatchObject({
      provider: 'ecodev',
      alias: 'backup',
      sequence: 2,
      filePath: path.join(authDir, 'ecodev-oauth-2-backup.json')
    });
  });

  it('allocates the next EcoDev token sequence for additional account aliases', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-daemon-'));
    tempDirs.push(authDir);
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    process.env.RCC_AUTH_DIR = authDir;

    await fs.writeFile(path.join(authDir, 'ecodev-oauth-1-default.json'), '{"access_token":"token-1"}\n', 'utf8');
    await fs.writeFile(path.join(authDir, 'ecodev-oauth-2-backup.json'), '{"access_token":"token-2"}\n', 'utf8');

    const byAlias = await TokenDaemon.findTokenBySelector('ecodev:work');
    expect(byAlias).toMatchObject({
      provider: 'ecodev',
      alias: 'work',
      sequence: 3,
      filePath: path.join(authDir, 'ecodev-oauth-3-work.json')
    });
  });
});
