import {
  normalizeApplyPatchToolCallsOnRequest,
  normalizeApplyPatchToolCallsOnResponse
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.js';

describe('tool governor apply_patch canonicalization', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: apps/host_console/lib/main.dart',
    '@@',
    '-void main() {}',
    '+void main() { runApp(const SizedBox()); }',
    '*** End Patch'
  ].join('\n');

  it('does not rewrite response exec_command(apply_patch ...) into a second tool name', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({
                    command: ['apply_patch', patchText],
                    workdir: '/tmp/project'
                  })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnResponse(response as any);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');

    expect(typeof fn?.arguments).toBe('string');
  });

  it('does not rewrite request history exec_command(apply_patch ...) or inject TS policy messages', () => {
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
                arguments: JSON.stringify({ command: ['apply_patch', patchText] })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request as any);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');

    expect(typeof fn?.arguments).toBe('string');

    const policyMessage = out.messages?.find(
      (entry: any) => entry?.role === 'system' && String(entry?.content || '').includes('[Codex NestedApplyPatch Policy]')
    );
    expect(policyMessage).toBeFalsy();
  });

  it('normalizes request-side apply_patch args through Rust canonical contract', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_bad_req',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patchText })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('apply_patch');
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(args.patch).toBe(args.input);
  });

  it('normalizes response-side apply_patch args through Rust canonical contract', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_resp',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ patch: patchText })
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
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(args.patch).toBe(args.input);
  });

  it('normalizes noncanonical shell wrapper with extra commands into empty apply_patch payload', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_shell',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: `bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH"`
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
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toBe('');
    expect(String(args.input || '')).toBe('');
  });
});
