import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('heartbeat directive bridge contract audit', () => {
  it('TS heartbeat bridge must consume camelCase fields from native wrapper, not snake_case residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).not.toContain('nativeDirective.interval_ms');
    expect(source).not.toContain('nativeDirective.tmux_session_id');
    expect(source).not.toContain('nativeDirective.content_changed');
  });
});
