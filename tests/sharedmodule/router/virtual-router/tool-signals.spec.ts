import { detectLastAssistantToolCategory } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/tool-signals.js';
import type { StandardizedMessage } from '../../../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

function buildShellMessages(command: string): StandardizedMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'shell_command',
            arguments: JSON.stringify({ command })
          }
        } as any
      ]
    }
  ];
}

describe('shell command classification', () => {
  it('treats sed print commands as read operations', () => {
    const messages = buildShellMessages("nl -ba scripts/demo.mjs | sed -n '130,210p'");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('detects ripgrep invocations as read/search tools', () => {
    const messages = buildShellMessages('rg -n "workflow.*error" modules/workflow');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('still flags sed -i usage as write operations', () => {
    const messages = buildShellMessages("sed -i '' 's/foo/bar/' file.txt");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('write');
  });
});
