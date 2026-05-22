import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';

describe('WindsurfChatProvider auth-only live probe', () => {
  test('config alias ws-pro-4 reaches pure cascade auth probe with cheaper default model and no mock', async () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/windsurf-auth-probe.ts', 'config', 'ws-pro-4'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    const result = JSON.parse(stdout);

    expect(result).toEqual({
      ok: true,
      mode: 'config',
      alias: 'ws-pro-4',
      credential: expect.objectContaining({
        hasCredential: true,
        apiKeyPrefix: expect.stringMatching(/^devin-session-token\$/),
        accountId: 'account-5cb2b19d59e84f6986fe07ebf7f8622a',
        auth1TokenPresent: true,
      }),
      health: true,
    });
  }, 45_000);
});
