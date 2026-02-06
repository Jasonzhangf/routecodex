import { describe, expect, it, jest } from '@jest/globals';

describe('oauth command behavior', () => {
  it('forces manual reauth by default for oauth <selector>', async () => {
    jest.resetModules();
    const interactiveRefresh = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => null) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    await cmd.parseAsync(['node', 'oauth', 'antigravity-oauth-1-test.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true, mode: 'manual' });
  });

  it('keeps root oauth manual even if auto env was set', async () => {
    jest.resetModules();
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
    process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'gemini';
    process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
    process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = 'foo@example.com';

    let autoModeAtCall = '';
    let autoConfirmAtCall = '';
    let accountTextAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      autoModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '');
      autoConfirmAtCall = String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || '');
      accountTextAtCall = String(process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => null) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    try {
      await cmd.parseAsync(['node', 'oauth', 'antigravity-oauth-1-test.json', '--headful'], { from: 'node' });
      expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true, mode: 'manual' });
      expect(autoModeAtCall).toBe('');
      expect(autoConfirmAtCall).toBe('');
      expect(accountTextAtCall).toBe('');
      expect(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('gemini');
      expect(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM).toBe('1');
      expect(process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT).toBe('foo@example.com');
    } finally {
      if (prevAutoMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      }
      if (prevAutoConfirm === undefined) {
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      } else {
        process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      }
      if (prevAccountText === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
      }
    }
  });

  it('supports legacy non-force path via --soft', async () => {
    jest.resetModules();
    const interactiveRefresh = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => null) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    await cmd.parseAsync(['node', 'oauth', '--soft', 'antigravity-oauth-1-test.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: false, mode: 'manual' });
  });

  it('keeps gemini-auto in auto mode', async () => {
    jest.resetModules();
    let autoModeAtCall = '';
    let autoConfirmAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      autoModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '');
      autoConfirmAtCall = String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: {
        findTokenBySelector: jest.fn(async () => ({ provider: 'gemini-cli' }))
      }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    await cmd.parseAsync(['node', 'oauth', 'gemini-auto', 'gemini-oauth-1-test.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('gemini-oauth-1-test.json', { force: true, mode: 'auto' });
    expect(autoModeAtCall).toBe('gemini');
    expect(autoConfirmAtCall).toBe('1');
  });
});
