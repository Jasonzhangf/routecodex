import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('server-side-tools auto-hook caller guard', () => {
  test('runServerSideToolEngine no longer hand-orchestrates optional/mandatory auto-hook queue execution inline', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts',
      'utf8'
    );

    expect(source).not.toContain('const autoHookExecutionList = listAutoServerToolHooks();');
    expect(source).not.toContain('const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromConfig({');
    expect(source).not.toContain("const optionalResult = await runAutoHookExecutionQueue({");
    expect(source).not.toContain("const mandatoryResult = await runAutoHookExecutionQueue({");
    expect(source).not.toContain('runServertoolAutoHookCallerViaThinShell as runServertoolAutoHookCaller');
  });
});
