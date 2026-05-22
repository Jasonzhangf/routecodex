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
    expect(desc).toContain('NEVER call apply_patch through exec_command');
    expect(desc).toContain('apply_patch <<PATCH');
    expect(desc).toContain('ONLY valid path is a direct apply_patch tool call');
  });

  it('includes system-level prohibition for nested apply_patch in guidance text', () => {
    const guidance = buildSystemToolGuidance();
    expect(guidance).toContain('NEVER wrap apply_patch inside exec_command/shell');
    expect(guidance).toContain('apply_patch <<PATCH');
    expect(guidance).not.toContain('Failed to find expected lines');
    expect(guidance).not.toContain('GNU line-number ranges');
  });

  it('does not let generic guidance own apply_patch schema or authoring contract anymore', () => {
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
    expect(desc).toBe('Edit files by patch');
    expect(out?.[0]?.function?.parameters?.properties?.patch).toBeUndefined();
    expect(out?.[0]?.function?.parameters?.properties?.input).toBeUndefined();
  });

  it('does not rewrite apply_patch into canonical grammar at generic guidance layer', () => {
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
    const patchDesc = String(out?.[0]?.function?.parameters?.properties?.patch?.description || '');
    expect(patchDesc).toBe('');
  });

  it('does not rewrite apply_patch into hashline mode at generic guidance layer', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'Edit files by patch',
          parameters: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'target file path'
              }
            }
          }
        }
      }
    ];

    const out = augmentOpenAITools(tools) as any[];
    expect(out?.[0]?.function?.parameters?.properties?.filePath?.type).toBe('string');
    const patchDesc = String(out?.[0]?.function?.parameters?.properties?.patch?.description || '');
    expect(patchDesc).toBe('');
  });
});
