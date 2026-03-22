import { augmentOpenAITools, buildSystemToolGuidance } from '../../sharedmodule/llmswitch-core/src/guidance/index.js';

describe('tool guidance for nested apply_patch prevention', () => {
  it('injects explicit no-nesting guidance into exec_command tool description', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Run shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    ];

    const out = augmentOpenAITools(tools) as any[];
    const desc = String(out?.[0]?.function?.description || '');
    expect(desc).toContain('[Codex ExecCommand Guidance]');
    expect(desc).toContain('Do NOT call apply_patch via exec_command/shell');
  });

  it('includes system-level prohibition for nested apply_patch in guidance text', () => {
    const guidance = buildSystemToolGuidance();
    expect(guidance).toContain('NEVER wrap apply_patch inside exec_command/shell');
    expect(guidance).toContain('nl -ba <file>');
    expect(guidance).toContain('Failed to find expected lines');
    expect(guidance).toContain('Failed to find context');
    expect(guidance).toContain('do NOT keep guessing `@@` hunk syntax or GNU line-number ranges');
    expect(guidance).toContain('Never guess file names/paths');
    expect(guidance).toContain('CRLF/LF and tab separators are tolerated');
  });

  it('injects apply_patch preflight + templates guidance', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'Edit files by patch',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      }
    ];

    const out = augmentOpenAITools(tools) as any[];
    const desc = String(out?.[0]?.function?.description || '');
    expect(desc).toContain('[Codex ApplyPatch Guidance]');
    expect(desc).toContain('nl -ba <file>');
    expect(desc).toContain('High-success templates');
    expect(desc).toContain('NEVER guess file names/paths');
    expect(desc).toContain('NEVER send empty "*** Add File" blocks');
    expect(desc).toContain('Choose ONE format per patch');
    expect(desc).toContain('FIRST line must literally be "*** Begin Patch"');
    expect(desc).toContain('Raw markdown/frontmatter lines');
    expect(desc).toContain('do NOT keep guessing `@@` syntax or GNU line-number ranges');
  });
});
