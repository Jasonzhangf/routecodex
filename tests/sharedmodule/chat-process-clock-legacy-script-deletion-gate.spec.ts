import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('chat-process clock legacy script deletion gate', () => {
  it('legacy clock alias clear harness must be physically removed after Rust side-effects takeover', () => {
    const legacyHarness = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/scripts/tests/clock-clear-alias-scopes.mjs',
    );
    expect(fs.existsSync(legacyHarness)).toBe(false);
  });
});
