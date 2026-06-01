import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('chat-process clock legacy deletion gate', () => {
  it('legacy chat-process clock bridge files must be physically removed after Rust side-effects takeover', () => {
    const legacyPaths = [
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-clock-reminders.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-servertool-orchestration.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/blocks/chat-process-clock-runtime-bridge.ts',
    ];

    const survivors = legacyPaths.filter((relativePath) =>
      fs.existsSync(path.join(process.cwd(), relativePath)),
    );

    expect(survivors).toEqual([]);
  });
});
