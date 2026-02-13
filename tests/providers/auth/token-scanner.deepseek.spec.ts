import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { scanDeepSeekAccountTokenFiles } from '../../../src/providers/auth/token-scanner/index.js';

describe('token-scanner deepseek-account', () => {
  const tempDirs: string[] = [];
  const prevAuthDir = process.env.ROUTECODEX_AUTH_DIR;
  const prevRccAuthDir = process.env.RCC_AUTH_DIR;

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

  it('scans deepseek-account token files and sorts aliases deterministically', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-scan-'));
    tempDirs.push(authDir);
    process.env.ROUTECODEX_AUTH_DIR = authDir;

    await fs.writeFile(path.join(authDir, 'deepseek-account-2.json'), '{"access_token":"a"}\n', 'utf8');
    await fs.writeFile(path.join(authDir, 'deepseek-account-10-work.json'), '{"access_token":"b"}\n', 'utf8');
    await fs.writeFile(path.join(authDir, 'deepseek-account-alpha.json'), '{"access_token":"c"}\n', 'utf8');
    await fs.writeFile(path.join(authDir, 'qwen-oauth-1-default.json'), '{"access_token":"x"}\n', 'utf8');

    const matches = await scanDeepSeekAccountTokenFiles();
    expect(matches).toHaveLength(3);
    expect(matches.map((item) => item.alias)).toEqual(['2', '10-work', 'alpha']);
    expect(matches.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(matches.every((item) => item.providerPrefix === 'deepseek-account')).toBe(true);
  });
});
