import {
  normalizeApplyPatchToolCallsOnRequest,
  normalizeApplyPatchToolCallsOnResponse
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
    expect(String(args.cmd || '')).not.toContain('${escaped}');
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
    expect(String(args.cmd || '')).not.toContain('${escaped}');
    expect(String(args.cmd || '')).not.toContain('git checkout feature/new-flow');
    expect(args.workdir).toBe('/workspace');
  });

  it('repairs malformed response tool_call when command is placed in function.name', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_name_1',
                type: 'function',
                function: {
                  name: 'wc -l /Users/fanzhang/Documents/github/routecodex/src/providers/auth/oauth-lifecycle.ts',
                  arguments: '{}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnResponse(response);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');
    const args = JSON.parse(String(fn?.arguments || '{}'));
    expect(String(args.cmd || '')).toContain('wc -l');
  });

  it('repairs malformed request tool_call when command is placed in function.name', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_bad_name_2',
              type: 'function',
              function: {
                name: 'rg -n "routecodex" src',
                arguments: JSON.stringify({ workdir: '/workspace' })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');
    const args = JSON.parse(String(fn?.arguments || '{}'));
    expect(String(args.cmd || '')).toContain('rg -n "routecodex" src');
    expect(args.workdir).toBe('/workspace');
  });
});
