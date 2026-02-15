import { applyDeepSeekWebResponseTransform } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-response.js';

describe('deepseek-web text tool-call harvest', () => {
  const adapterContext: any = {
    capturedChatRequest: {
      tools: [{ type: 'function', function: { name: 'apply_patch' } }],
      tool_choice: 'required'
    }
  };

  it('harvests apply_patch from text-wrapped JSON when input is malformed object-like string', () => {
    const content = [
      'Here is the corrected patch:',
      '{"tool_calls":[{"name":"apply_patch","input":"{patch:\\"*** Begin Patch\\\\n*** Add File: sample.txt\\\\n+ok\\\\n*** End Patch\\"}"}]}'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContext);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(String(args.patch || args.input || '')).toContain('*** Begin Patch');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests when tool_calls field itself is a JSON string', () => {
    const content =
      '{"tool_calls":"[{\\"name\\":\\"apply_patch\\",\\"input\\":{\\"patch\\":\\"*** Begin Patch\\\\n*** Add File: sample2.txt\\\\n+ok\\\\n*** End Patch\\"}}]"}';

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_2',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContext);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(String(args.patch || args.input || '')).toContain('*** Begin Patch');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests shell_command text envelope into exec_command tool_call (snapshot)', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const content = '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}';

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_shell_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');

    const snapshotView = {
      finish_reason: out.choices?.[0]?.finish_reason,
      message: {
        ...out.choices?.[0]?.message,
        tool_calls: Array.isArray(out.choices?.[0]?.message?.tool_calls)
          ? out.choices?.[0]?.message?.tool_calls.map((tc: any) => ({ ...tc, id: '<tool_call_id>' }))
          : []
      },
      metadata: out.metadata
    };
    expect(snapshotView).toMatchInlineSnapshot(`
{
  "finish_reason": "tool_calls",
  "message": {
    "content": null,
    "role": "assistant",
    "tool_calls": [
      {
        "function": {
          "arguments": "{"command":"bd --no-db ready","cmd":"bd --no-db ready"}",
          "name": "exec_command",
        },
        "id": "<tool_call_id>",
        "type": "function",
      },
    ],
  },
  "metadata": {
    "deepseek": {
      "toolCallSource": "fallback",
      "toolCallState": "text_tool_calls",
    },
  },
}
`);
  });

  it('maps exec_command fallback to allowed Bash tool name when request toolset uses Claude naming', () => {
    const adapterContextBash: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'Bash' } }],
        tool_choice: 'required'
      }
    };
    const content = '{"tool_calls":[{"name":"exec_command","input":{"command":"echo hello"}}]}';

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_bash_alias_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextBash);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('Bash');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.command).toBe('echo hello');
    expect(args.cmd).toBe('echo hello');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests malformed tool:exec_command parameter markup into exec_command tool_call', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const content = [
      '• tool:exec_command (tool:exec_command)',
      '  <parameter name="command">rg -n "function resolveEndpoint|function mapEndpointToFolder" src/providers/core/utils/snapshot-writer.ts /Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/filters/utils/snapshot-writer.ts /Users/fanzhang/Documents/github/sharedmodule/llmswitch-core/src/conversion/shared/snapshot-hooks.ts</command>',
      '  </tool:exec_command>'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_param_mismatch_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(String(args.cmd || '')).toContain('rg -n');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests noisy JSON tool_calls wrapper with leading marker and trailing status text', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const content = [
      '⏺ {"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}},{"name":"shell_command","input":{"command":"bd --no-db list --status in_progress"}}]}',
      '',
      '✻ Baked for 41s'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_noisy_json_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const calls = Array.isArray(out.choices?.[0]?.message?.tool_calls) ? out.choices[0].message.tool_calls : [];
    expect(calls.length).toBe(2);
    expect(calls[0]?.function?.name).toBe('exec_command');
    expect(calls[1]?.function?.name).toBe('exec_command');
    expect(JSON.parse(String(calls[0]?.function?.arguments || '{}')).cmd).toBe('bd --no-db ready');
    expect(JSON.parse(String(calls[1]?.function?.arguments || '{}')).cmd).toBe('bd --no-db list --status in_progress');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('repairs native shell_command tool_calls args and maps name to requested exec_command', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const payload: any = {
      id: 'chatcmpl_deepseek_native_shell_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_native_1',
                type: 'function',
                function: {
                  name: 'shell_command',
                  arguments: '{"cmd":"bd --no-db ready","workdir":"/tmp"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect(args.command).toBe('bd --no-db ready');
    expect(args.workdir).toBe('/tmp');
  });

  it('harvests plain Begin/End Patch text into apply_patch tool_call', () => {
    const content = [
      'I need to add a backend endpoint to serve tab content to the iframe in the UI.',
      '',
      '*** Begin Patch',
      '*** Update File: server.js',
      '@@ -882,6 +882,12 @@ app.delete(\'/tabs/:tabId\', async (req, res) => {',
      '+app.get(\'/tabs/:tabId/view\', async (req, res) => {',
      '+  res.send(\'ok\');',
      '+});',
      '*** End Patch'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_patch_text_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContext);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    const patchText = String(args.patch || args.input || '');
    expect(patchText).toContain('*** Begin Patch');
    expect(patchText).toContain('app.get(\'/tabs/:tabId/view\'');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests escaped tool_calls transcript into exec_command tool_call', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const content = [
      '{\\"tool_calls\\":[{\\"name\\":\\"exec_command\\",\\"input\\":{\\"cmd\\":\\"npm run build:dev\\",\\"workdir\\":\\"/Users/fanzhang/Documents/github/routecodex\\"}}]}',
      '<｜User｜>> routecodex@0.89.2125 build:dev',
      '<｜Assistant｜>继续执行'
    ].join('');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_escaped_transcript_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('npm run build:dev');
    expect(args.workdir).toBe('/Users/fanzhang/Documents/github/routecodex');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests trailing JSON tool_calls after prose into exec_command tool_call', () => {
    const adapterContextExec: any = {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    };
    const content = [
      '我将按以下步骤执行：',
      '',
      '1. 先检查项目状态',
      '2. 再执行构建',
      '',
      '让我立即开始：',
      '',
      '{"tool_calls":[{"name":"exec_command","input":{"command":"bd --no-db ready"}}]}'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_trailing_json_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContextExec);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
