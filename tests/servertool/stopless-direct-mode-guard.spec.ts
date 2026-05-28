import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('stopless direct mode guard removal', () => {
  test('response-stage shell no longer contains a direct-mode no-followup branch', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('direct_mode_no_followup');
    expect(source).not.toContain('allowFollowup === false');
  });
});
