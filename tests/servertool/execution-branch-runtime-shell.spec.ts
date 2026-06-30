import { describe, expect, test } from '@jest/globals';
import { planServertoolExecutionBranchRuntimeAction } from '../../sharedmodule/llmswitch-core/src/servertool/execution-branch-runtime-shell.js';

describe('execution-branch-runtime-shell', () => {
  test('keeps execution-branch planning in the runtime shell and delegates to native branch planner', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/execution-branch-runtime-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('planServertoolExecutionBranchWithNative');
    expect(source).toContain('const executableToolCallInputs = args.executableToolCalls.map');
    expect(source).toContain('executableToolCalls: executableToolCallInputs');
  });

  test('projects cli execution branch and outcome branch with native planner semantics', () => {
    expect(
      planServertoolExecutionBranchRuntimeAction({
        executableToolCalls: [
          { id: 'call_1', name: 'web_search', executionMode: 'client_exec_cli_projection' }
        ],
        executedToolCallsLen: 0
      })
    ).toMatchObject({
      action: 'client_exec_cli_projection',
      projectedToolCallId: 'call_1',
      projectedToolCallIndex: 0
    });

    expect(
      planServertoolExecutionBranchRuntimeAction({
        executableToolCalls: [
          { id: 'call_1', name: 'web_search', executionMode: 'guarded' }
        ],
        executedToolCallsLen: 1
      })
    ).toMatchObject({
      action: 'resolve_execution_outcome'
    });
  });
});
