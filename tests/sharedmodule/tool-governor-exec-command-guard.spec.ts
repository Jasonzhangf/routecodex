import {
  normalizeApplyPatchToolCallsOnRequest
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.js';

describe('tool governor exec_command guard', () => {
  const originalEnhance = process.env.RCC_TOOL_ENHANCE;

  beforeEach(() => {
    process.env.RCC_TOOL_ENHANCE = '1';
  });

  afterAll(() => {
    if (originalEnhance === undefined) {
      delete process.env.RCC_TOOL_ENHANCE;
    } else {
      process.env.RCC_TOOL_ENHANCE = originalEnhance;
    }
  });

  it('rewrites request-side dangerous git reset --hard to blocked command', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'git reset --hard HEAD',
                  workdir: '/workspace'
                })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request);
    const argsRaw = out.messages?.[0]?.tool_calls?.[0]?.function?.arguments;
    const args = JSON.parse(String(argsRaw || '{}'));

    expect(String(args.cmd || '')).toContain('blocked by exec_command guard');
    expect(String(args.cmd || '')).not.toContain('git reset --hard HEAD');
    expect(args.workdir).toBe('/workspace');
  });

  it('rewrites request-side checkout non-file command to blocked command', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'git checkout feature/new-flow',
                  workdir: '/workspace'
                })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request);
    const argsRaw = out.messages?.[0]?.tool_calls?.[0]?.function?.arguments;
    const args = JSON.parse(String(argsRaw || '{}'));

    expect(String(args.cmd || '')).toContain('blocked by exec_command guard');
    expect(String(args.cmd || '')).toContain('git checkout is allowed only for a single file');
    expect(String(args.cmd || '')).not.toContain('git checkout feature/new-flow');
    expect(args.workdir).toBe('/workspace');
  });
});
