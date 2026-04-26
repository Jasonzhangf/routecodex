import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

describe('oauth command behavior', () => {
  it('keeps glm root oauth path in manual mode', async () => {
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
        findTokenBySelector: jest.fn(async () => ({ provider: 'glm' }))
      }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();
    await cmd.parseAsync(['node', 'oauth', 'glm-oauth-3-138.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('glm-oauth-3-138.json', { force: true, mode: 'manual' });
    expect(autoModeAtCall).toBe('');
    expect(autoConfirmAtCall).toBe('');
  });

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

  it('keeps root oauth direct even if auto env was set', async () => {
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
      await cmd.parseAsync(['node', 'oauth', 'antigravity-oauth-1-test.json'], { from: 'node' });
      expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true, mode: 'manual' });
      expect(autoModeAtCall).toBe('');
      expect(autoConfirmAtCall).toBe('');
      expect(accountTextAtCall).toBe('');
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

  it('supports force path via --force', async () => {
    jest.resetModules();
    const interactiveRefresh = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => null) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    await cmd.parseAsync(['node', 'oauth', '--force', 'antigravity-oauth-1-test.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true, mode: 'manual' });
  });

  it('defaults oauth <selector> browser to camoufox', async () => {
    jest.resetModules();
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    let browserAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      browserAtCall = String(process.env.ROUTECODEX_OAUTH_BROWSER || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => null) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    try {
      await cmd.parseAsync(['node', 'oauth', 'glm-oauth-3-138.json'], { from: 'node' });
      expect(interactiveRefresh).toHaveBeenCalledWith('glm-oauth-3-138.json', { force: true, mode: 'manual' });
      expect(browserAtCall).toBe('camoufox');
    } finally {
      if (prevBrowser === undefined) {
        delete process.env.ROUTECODEX_OAUTH_BROWSER;
      } else {
        process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
      }
    }
  });

  it('honors --headful for oauth <selector> while staying in manual mode for glm', async () => {
    jest.resetModules();
    const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    let devModeAtCall = '';
    let browserAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      devModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '');
      browserAtCall = String(process.env.ROUTECODEX_OAUTH_BROWSER || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: { findTokenBySelector: jest.fn(async () => ({ provider: 'glm' })) }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    try {
      await cmd.parseAsync(['node', 'oauth', '--headful', 'glm-oauth-3-138.json'], { from: 'node' });
      expect(interactiveRefresh).toHaveBeenCalledWith('glm-oauth-3-138.json', { force: true, mode: 'manual' });
      expect(devModeAtCall).toBe('1');
      expect(browserAtCall).toBe('camoufox');
    } finally {
      if (prevDevMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
      }
      if (prevBrowser === undefined) {
        delete process.env.ROUTECODEX_OAUTH_BROWSER;
      } else {
        process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
      }
    }
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

    expect(interactiveRefresh).toHaveBeenCalledWith('gemini-oauth-1-test.json', {
      force: true,
      mode: 'auto',
      noAutoFallback: true
    });
    expect(autoModeAtCall).toBe('gemini');
    expect(autoConfirmAtCall).toBe('1');
  });

  it('honors --headful for glm-auto subcommand', async () => {
    jest.resetModules();
    const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    let devModeAtCall = '';
    let autoModeAtCall = '';
    let browserAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      devModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '');
      autoModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '');
      browserAtCall = String(process.env.ROUTECODEX_OAUTH_BROWSER || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: {
        findTokenBySelector: jest.fn(async () => ({ provider: 'glm' }))
      }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    try {
      await cmd.parseAsync(['node', 'oauth', 'glm-auto', 'glm-oauth-1-186.json', '--headful'], { from: 'node' });
      expect(interactiveRefresh).toHaveBeenCalledWith('glm-oauth-1-186.json', {
        force: true,
        mode: 'manual'
      });
      expect(devModeAtCall).toBe('1');
      expect(autoModeAtCall).toBe('');
      expect(browserAtCall).toBe('camoufox');
    } finally {
      if (prevDevMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
      }
      if (prevAutoMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      }
      if (prevBrowser === undefined) {
        delete process.env.ROUTECODEX_OAUTH_BROWSER;
      } else {
        process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
      }
      if (prevAutoConfirm === undefined) {
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      } else {
        process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      }
    }
  });

  it('honors --headful for nested routecodex oauth glm-auto command parsing', async () => {
    jest.resetModules();
    const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    let devModeAtCall = '';
    const interactiveRefresh = jest.fn(async () => {
      devModeAtCall = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '');
    });

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: {
        findTokenBySelector: jest.fn(async () => ({ provider: 'glm' }))
      }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const root = new Command('routecodex').enablePositionalOptions();
    root.addCommand(createOauthCommand());

    try {
      await root.parseAsync(
        ['node', 'routecodex', 'oauth', 'glm-auto', 'glm-oauth-1-186.json', '--headful'],
        { from: 'node' }
      );
      expect(interactiveRefresh).toHaveBeenCalledWith('glm-oauth-1-186.json', {
        force: true,
        mode: 'manual'
      });
      expect(devModeAtCall).toBe('1');
    } finally {
      if (prevDevMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
      }
      if (prevAutoMode === undefined) {
        delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      } else {
        process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
      }
      if (prevBrowser === undefined) {
        delete process.env.ROUTECODEX_OAUTH_BROWSER;
      } else {
        process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
      }
      if (prevAutoConfirm === undefined) {
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      } else {
        process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
      }
    }
  });

  it('logs selector lookup failure before falling back to manual mode', async () => {
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const interactiveRefresh = jest.fn(async () => {});

    jest.unstable_mockModule('../../src/token-daemon/index.js', () => ({
      interactiveRefresh,
      validateOAuthTokens: jest.fn(async () => true),
      TokenDaemon: {
        findTokenBySelector: jest.fn(async () => {
          throw new Error('selector boom');
        })
      }
    }));

    const { createOauthCommand } = await import('../../src/commands/oauth.js');
    const cmd = createOauthCommand();

    await cmd.parseAsync(['node', 'oauth', 'antigravity-oauth-1-test.json'], { from: 'node' });

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true, mode: 'manual' });
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=selector_resolution');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=find_token_by_selector');

    warnSpy.mockRestore();
  });
});
