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
  });
});
