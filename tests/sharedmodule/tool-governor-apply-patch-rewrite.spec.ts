import {
  normalizeApplyPatchToolCallsOnRequest,
  normalizeApplyPatchToolCallsOnResponse
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.js';

describe('tool governor apply_patch rewrite', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: apps/host_console/lib/main.dart',
    '@@',
    '-void main() {}',
    '+void main() { runApp(const SizedBox()); }',
    '*** End Patch'
  ].join('\n');

  it('rewrites response exec_command(apply_patch ...) into apply_patch tool call', () => {
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
    expect(fn?.name).toBe('apply_patch');

    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    const patchOrInput = String(args.patch || args.input || '');
    expect(patchOrInput).toContain('*** Begin Patch');
  });

  it('rewrites request history and injects nested-apply_patch policy notice', () => {
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
    expect(fn?.name).toBe('apply_patch');

    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    const patchOrInput = String(args.patch || args.input || '');
    expect(patchOrInput).toContain('*** Begin Patch');

    const policyMessage = out.messages?.find(
      (entry: any) => entry?.role === 'system' && String(entry?.content || '').includes('[Codex NestedApplyPatch Policy]')
    );
    expect(policyMessage).toBeTruthy();
  });

  it('rewrites invalid apply_patch args into reason-encoded guard payload on request path', () => {
    const badPatch = [
      '*** Begin Patch',
      '*** Update File: HEARTBEAT.md',
      '---',
      'title: "finger project heartbeat"',
      '*** End Patch'
    ].join('\n');
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
                arguments: JSON.stringify({ patch: badPatch })
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
    const patchOrInput = String(args.patch || args.input || '');
    expect(patchOrInput).toContain('__rcc_apply_patch_validation_error__/reason-unsupported-patch-format');
  });

  it('rewrites invalid apply_patch args into reason-encoded guard payload on response path', () => {
    const badPatch = [
      '*** Begin Patch',
      '*** Add File: src/empty.txt',
      '*** End Patch'
    ].join('\n');
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
                  arguments: JSON.stringify({ patch: badPatch })
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
    const patchOrInput = String(args.patch || args.input || '');
    expect(patchOrInput).toContain('__rcc_apply_patch_validation_error__/reason-empty-add-file-block');
  });
});
