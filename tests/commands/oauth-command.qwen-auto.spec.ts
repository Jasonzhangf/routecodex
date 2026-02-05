import { describe, expect, it } from '@jest/globals';

import { createOauthCommand } from '../../src/commands/oauth.js';

describe('oauth command', () => {
  it('registers qwen-auto subcommand', () => {
    const cmd = createOauthCommand();
    const sub = cmd.commands.map((c) => c.name());
    expect(sub).toContain('qwen-auto');
  });

  it('registers --headful for interactive oauth flows', () => {
    const cmd = createOauthCommand();
    const rootOptionFlags = cmd.options.map((o) => o.long);
    expect(rootOptionFlags).toContain('--headful');

    const qwen = cmd.commands.find((c) => c.name() === 'qwen-auto');
    expect(qwen).toBeDefined();
    const qwenFlags = (qwen!.options || []).map((o) => o.long);
    expect(qwenFlags).toContain('--headful');

    const gemini = cmd.commands.find((c) => c.name() === 'gemini-auto');
    expect(gemini).toBeDefined();
    const geminiFlags = (gemini!.options || []).map((o) => o.long);
    expect(geminiFlags).toContain('--headful');

    const antigravity = cmd.commands.find((c) => c.name() === 'antigravity-auto');
    expect(antigravity).toBeDefined();
    const antigravityFlags = (antigravity!.options || []).map((o) => o.long);
    expect(antigravityFlags).toContain('--headful');
  });
});
