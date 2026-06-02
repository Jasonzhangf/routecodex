import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('req_process stage1 sanitizer deletion gate', () => {
  it('stage shell must be physically removed instead of keeping sanitizer checks in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
  });
});
