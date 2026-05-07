import { extractToolCalls } from '../../../../src/server/runtime/http-server/stats-manager-internals.js';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager.js';

describe('StatsManager tool name canonicalization', () => {
  it('canonicalizes functions namespace and shell aliases when extracting tool calls', () => {
    const calls = extractToolCalls({
      tool_calls: [
        {
          id: 'tool-1',
          function: {
            name: 'functions.exec_command'
          }
        },
        {
          id: 'tool-2',
          function: {
            name: '  FuNcTiOnS.SHELL_COMMAND '
          }
        },
        {
          id: 'tool-3',
          function: {
            name: 'functions.apply_patch'
          }
        }
      ]
    });

    expect(calls).toEqual([
      { id: 'tool-1', name: 'exec_command' },
      { id: 'tool-2', name: 'exec_command' },
      { id: 'tool-3', name: 'apply_patch' }
    ]);
  });

  it('records canonical tool names in stats snapshots', () => {
    const stats = new StatsManager();

    stats.recordToolUsage(
      { providerKey: 'deepseek-web.1', model: 'deepseek-reasoner' },
      {
        output: [
          {
            type: 'function_call',
            id: 'call-1',
            name: 'functions.exec_command'
          },
          {
            type: 'function_call',
            id: 'call-2',
            name: 'functions.apply_patch'
          }
        ]
      }
    );

    const snapshot = stats.snapshot(1234);
    expect(snapshot.tools?.byToolName.exec_command?.callCount).toBe(1);
    expect(snapshot.tools?.byToolName.apply_patch?.callCount).toBe(1);
    expect(snapshot.tools?.byToolName['functions.exec_command']).toBeUndefined();
    expect(snapshot.tools?.byToolName['functions.apply_patch']).toBeUndefined();
  });
});
