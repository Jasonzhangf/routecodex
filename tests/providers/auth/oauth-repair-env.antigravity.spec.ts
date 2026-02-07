import { describe, expect, test } from '@jest/globals';

import { withOAuthRepairEnv } from '../../../src/providers/auth/oauth-repair-env.js';

describe('withOAuthRepairEnv', () => {
  test('scopes camoufox env for antigravity and restores afterwards', async () => {
    const prevAuto = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;

    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'prev-mode';
    process.env.ROUTECODEX_OAUTH_BROWSER = 'prev-browser';
    process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '0';

    let insideAuto: string | undefined;
    let insideBrowser: string | undefined;
    let insideConfirm: string | undefined;

    await withOAuthRepairEnv('antigravity', async () => {
      insideAuto = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      insideBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      insideConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    });

    expect(insideAuto).toBe('antigravity');
    expect(insideBrowser).toBe('camoufox');
    expect(insideConfirm).toBe('1');
    expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('prev-mode');
    expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('prev-browser');
    expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('0');

    if (prevAuto === undefined) delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    else process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAuto;
    if (prevBrowser === undefined) delete process.env.ROUTECODEX_OAUTH_BROWSER;
    else process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
    if (prevConfirm === undefined) delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    else process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevConfirm;
  });

  test('scopes camoufox env for qwen', async () => {
    const prevAuto = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;

    await withOAuthRepairEnv('qwen', async () => {
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('qwen');
      expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('camoufox');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
    });

    expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe(prevAuto);
    expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe(prevBrowser);
    expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe(prevConfirm);
  });

  test('scopes camoufox env for iflow', async () => {
    const prevAuto = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;

    await withOAuthRepairEnv('iflow', async () => {
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('iflow');
      expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('camoufox');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
    });

    expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe(prevAuto);
    expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe(prevBrowser);
    expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe(prevConfirm);
  });

  test('scopes camoufox env for gemini + gemini-cli', async () => {
    const prevAuto = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;

    await withOAuthRepairEnv('gemini', async () => {
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('gemini');
      expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('camoufox');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
    });
    await withOAuthRepairEnv('gemini-cli', async () => {
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('gemini');
      expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe('camoufox');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
    });

    expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe(prevAuto);
    expect(process.env.ROUTECODEX_OAUTH_BROWSER).toBe(prevBrowser);
    expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe(prevConfirm);
  });
});
