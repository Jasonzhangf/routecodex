import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.js';

describe('apply_patch native governance ownership', () => {
  it('keeps normalizeApplyPatchArgumentsJson as a required native export', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('normalizeApplyPatchArgumentsJson');
  });

  it('keeps the retired chat-process governance TS wrapper deleted', () => {
    const retiredWrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts'
    );

    expect(fs.existsSync(retiredWrapperPath)).toBe(false);
  });

  it('keeps the req-process TS wrapper deleted', () => {
    const reqProcessWrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-process-semantics.ts'
    );

    expect(fs.existsSync(reqProcessWrapperPath)).toBe(false);
  });
});
