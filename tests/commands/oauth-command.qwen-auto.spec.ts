import { describe, expect, it } from '@jest/globals';

import { createOauthCommand } from '../../src/commands/oauth.js';

describe('oauth command', () => {
  it('does not register removed qwen-auto subcommand', () => {
    const cmd = createOauthCommand();
    const sub = cmd.commands.map((c) => c.name());
    expect(sub).not.toContain('qwen-auto');
  });
});

