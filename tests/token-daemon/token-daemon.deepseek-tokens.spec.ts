import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { collectTokenSnapshot } from '../../src/token-daemon/token-utils.js';
import { TokenDaemon } from '../../src/token-daemon/token-daemon.js';

describe('token-daemon deepseek-account token management', () => {
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

  it('collects deepseek-account tokens and supports provider selector aliases', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-daemon-'));
    tempDirs.push(authDir);
    process.env.ROUTECODEX_AUTH_DIR = authDir;

    await fs.writeFile(path.join(authDir, 'deepseek-account-1.json'), '{"access_token":"token-1"}\n', 'utf8');
    await fs.writeFile(
      path.join(authDir, 'deepseek-account-3-13823250570.json'),
      '{"access_token":"token-3"}\n',
      'utf8'
    );

    const snapshot = await collectTokenSnapshot();
    const deepseek = snapshot.providers.find((item) => item.provider === 'deepseek-account');
    expect(deepseek).toBeDefined();
    expect(deepseek?.tokens.map((token) => token.alias)).toEqual(['1', '3-13823250570']);

    const byFamily = await TokenDaemon.findTokenBySelector('deepseek-account');
    expect(byFamily?.provider).toBe('deepseek-account');

    const byProviderId = await TokenDaemon.findTokenBySelector('deepseek-web');
    expect(byProviderId?.provider).toBe('deepseek-account');
  });
});
