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
    expect(desc).toContain('Use exec_command only for shell execution');
    expect(desc).toContain('bash -lc');
    expect(desc).not.toContain('apply_patch');
  });

  it('generic system guidance no longer owns apply_patch policy text', () => {
    const guidance = buildSystemToolGuidance();
    expect(guidance).not.toContain('apply_patch');
    expect(guidance).not.toContain('Failed to find expected lines');
    expect(guidance).not.toContain('GNU line-number ranges');
  });

  it('generic shell guidance no longer owns apply_patch routing text', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'shell',
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
    expect(desc).not.toContain('apply_patch');
    expect(desc).not.toContain('File writes are FORBIDDEN via shell');
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
