import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';

const PATCH = '*** Begin Patch\n*** Add File: tmp/apft/01-hello.txt\n+hello from apply_patch\n*** End Patch';
const APPLY_PATCH_GRAMMAR = 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF\nend_patch: "*** End Patch" LF?\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: "*** Add File: " filename LF add_line+\ndelete_hunk: "*** Delete File: " filename LF\nupdate_hunk: "*** Update File: " filename LF change_move? change?\nfilename: /(.+)/\nadd_line: "+" /(.*)/ LF\nchange_move: "*** Move to: " filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: ("@@" | "@@ " /(.+)/) LF\nchange_line: ("+" | "-" | " ") /(.*)/ LF\neof_line: "*** End of File" LF\n%import common.LF';

function buildResponsesPayload() {
  const rawArguments = JSON.stringify({ patch: PATCH });
  return {
    id: 'resp_apply_patch_blackbox',
    object: 'response',
    status: 'requires_action',
    output: [
      {
        type: 'function_call',
        call_id: 'call_apply_patch',
        name: 'apply_patch',
        arguments: rawArguments,
      },
    ],
    required_action: {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [
          {
            id: 'call_apply_patch',
            type: 'function',
            name: 'apply_patch',
            arguments: rawArguments,
            function: {
              name: 'apply_patch',
              arguments: rawArguments,
            },
          },
        ],
      },
    },
  };
}

function buildCodexFreeformApplyPatchTool() {
  return [
    {
      type: 'custom',
      name: 'apply_patch',
      description:
        'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
      format: {
        type: 'grammar',
        syntax: 'lark',
        definition: APPLY_PATCH_GRAMMAR,
      },
    },
  ];
}

function runNativeProjection(payload: unknown, toolsRaw: unknown[], metadata: unknown) {
  const script = `
    const { projectResponsesClientPayloadForClientWithNative } = await import(
      ${JSON.stringify(
        new URL(
          './helpers/resp-semantics-direct-native.ts',
          import.meta.url,
        ).href,
      )}
    );
    const output = projectResponsesClientPayloadForClientWithNative(
      ${JSON.stringify(payload)},
      ${JSON.stringify(toolsRaw)},
      ${JSON.stringify(metadata)},
    );
    process.stdout.write(JSON.stringify(output));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  return JSON.parse(stdout);
}

describe('apply_patch freeform client projection blackbox', () => {
  it('projects provider JSON patch arguments back to Codex raw freeform patch text', () => {
    const output = runNativeProjection(
      buildResponsesPayload(),
      buildCodexFreeformApplyPatchTool(),
      {},
    );

    expect(output.output?.[0]).toEqual({
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call_apply_patch',
      input: PATCH,
    });
    const toolCall = output.required_action?.submit_tool_outputs?.tool_calls?.[0];
    expect(toolCall?.arguments).toBe(PATCH);
    expect(toolCall?.function?.arguments).toBe(PATCH);
    expect(JSON.stringify(output)).not.toContain('{\\"patch\\"');
    expect(JSON.stringify(output)).not.toContain('"patch":');
  });

  it('restores client-visible response model and reasoning effort from metadata in native projection', () => {
    const output = runNativeProjection(
      {
        type: 'response.completed',
        response: {
          id: 'resp_restore',
          object: 'response',
          status: 'completed',
          model: 'provider-internal-model',
          reasoning: { summary: 'kept' },
          output: [],
        },
      },
      [],
      {
        clientModelId: 'client-visible-model',
        reasoning: { effort: 'high' },
      },
    );

    expect(output.response?.model).toBe('client-visible-model');
    expect(output.response?.reasoning).toEqual({ summary: 'kept', effort: 'high' });
  });

  it('strips replay-unsafe responses fields before client-visible projection', () => {
    const output = runNativeProjection(
      {
        type: 'response.completed',
        response: {
          id: 'resp_replay_safe',
          object: 'response',
          status: 'completed',
          output: [
            {
              id: 'rs_1',
              type: 'reasoning',
              status: 'completed',
              summary: [{ type: 'summary_text', text: 'plan' }],
              content: [{ type: 'reasoning_text', text: 'private reasoning' }],
              encrypted_content: 'opaque'
            },
            {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              name: 'exec_command',
              call_id: 'call_1',
              arguments: '{"cmd":"pwd"}'
            },
            {
              id: 'fco_1',
              type: 'function_call_output',
              status: 'completed',
              call_id: 'call_1',
              output: '/tmp/project'
            }
          ]
        }
      },
      [],
      {},
    );

    expect(output.response?.output).toEqual([
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'plan' }],
        encrypted_content: 'opaque'
      },
      {
        id: 'fc_1',
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: '{"cmd":"pwd"}'
      },
      {
        id: 'fco_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: '/tmp/project'
      }
    ]);
    expect(JSON.stringify(output)).not.toContain('"reasoning_text"');
    expect(JSON.stringify(output)).not.toContain('"status":"in_progress"');
    expect(JSON.stringify(output.response?.output)).not.toContain('"status":"completed"');
  });
});
