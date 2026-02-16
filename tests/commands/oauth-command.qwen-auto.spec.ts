import { describe, expect, it } from '@jest/globals';

import { createOauthCommand } from '../../src/commands/oauth.js';

describe('oauth command', () => {
  it('registers qwen-auto subcommand', () => {
    const cmd = createOauthCommand();
    const sub = cmd.commands.map((c) => c.name());
    expect(sub).toContain('qwen-auto');
  });
});

