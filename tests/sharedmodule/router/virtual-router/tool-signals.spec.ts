import { detectLastAssistantToolCategory } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/tool-signals.js';
import type { StandardizedMessage } from '../../../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

function buildToolCallMessages(toolName: string, command: string): StandardizedMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify({ command })
          }
        } as any
      ]
    }
  ];
}

function buildShellMessages(command: string): StandardizedMessage[] {
  return buildToolCallMessages('shell_command', command);
}

function buildMultiToolCallMessages(tools: { name: string; command: string }[]): StandardizedMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: tools.map(
        (tool, index) =>
          ({
            id: `call_${index + 1}`,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify({ command: tool.command })
            }
          } as any)
      )
    }
  ];
}

describe('shell command classification', () => {
  it('treats sed print commands as read operations', () => {
    const messages = buildShellMessages("nl -ba scripts/demo.mjs | sed -n '130,210p'");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('detects ripgrep invocations as search operations', () => {
    const messages = buildShellMessages('rg -n "workflow.*error" modules/workflow');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('search');
  });

  it('still flags sed -i usage as write operations', () => {
    const messages = buildShellMessages("sed -i '' 's/foo/bar/' file.txt");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('write');
  });

  it('treats ls listing as other operations', () => {
    const messages = buildShellMessages('ls -la');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('other');
  });

  it('treats mv rename as other operations', () => {
    const messages = buildShellMessages('mv foo.txt bar.txt');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('other');
  });

  it('classifies exec_command payloads using the inner command', () => {
    const messages = buildToolCallMessages('exec_command', 'cat README.md');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('classifies bash tool calls via inner shell command', () => {
    const messages = buildToolCallMessages('bash', "sed -i '' 's/foo/bar/' file.txt");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('write');
  });

  it('classifies declared web_search tools separately from local search', () => {
    const messages = buildToolCallMessages('web_search', JSON.stringify({ query: 'latest news' }));
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('websearch');
  });

  it('detects grep pipelines as shell search operations', () => {
    const messages = buildShellMessages("grep -R 'RouteCodex' src");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('search');
  });

  it('detects exec_command find invocations as search operations', () => {
    const messages = buildToolCallMessages('exec_command', 'find sharedmodule -name "*.ts"');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('search');
  });

  it('derives search classification for non-shell tools when command text is grep', () => {
    const messages = buildToolCallMessages('custom_runner', 'rg "tool-signals" sharedmodule');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('search');
  });

  it('treats echo redirection in shell commands as write operations', () => {
    const messages = buildShellMessages("echo 'console.log(1)' > scripts/tmp-check.js");
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('write');
  });

  it('treats head usage in pipelines as read operations', () => {
    const messages = buildShellMessages('lsof -i :7701 -i :7704 | head -20');
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('prioritizes read over search and other in a multi-tool assistant message', () => {
    const messages = buildMultiToolCallMessages([
      { name: 'exec_command', command: 'rg "RouteCodex" src' },
      { name: 'exec_command', command: 'cat README.md' },
      { name: 'exec_command', command: 'echo done' }
    ]);
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('classifies codex Read tool name as read even without shell command args', () => {
    const messages: StandardizedMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: 'src/index.ts' })
            }
          } as any
        ]
      }
    ];
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('read');
  });

  it('classifies codex Edit tool name as write even without shell command args', () => {
    const messages: StandardizedMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_edit',
            type: 'function',
            function: {
              name: 'Edit',
              arguments: JSON.stringify({
                file_path: 'src/index.ts',
                old_string: 'a',
                new_string: 'b'
              })
            }
          } as any
        ]
      }
    ];
    const result = detectLastAssistantToolCategory(messages);
    expect(result?.category).toBe('write');
  });
});
