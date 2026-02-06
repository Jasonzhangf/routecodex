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

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: true });
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

    expect(interactiveRefresh).toHaveBeenCalledWith('antigravity-oauth-1-test.json', { force: false });
  });
});
