import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('req_process stage1 clock deletion gate', () => {
  it('stage shell must not directly import or call clock runtime bridge', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).not.toContain('chat-process-clock-runtime-bridge.js');
    expect(source).not.toMatch(/\bapplyChatProcessClockRuntimeBridge\s*\(/);
  });
});
