import { describe, expect, it } from '@jest/globals';

import { normalizeResponsesToolCallArgumentsForClientWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

const PATCH = '*** Begin Patch\n*** Add File: tmp/apft/01-hello.txt\n+hello from apply_patch\n*** End Patch';

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
        definition: 'start: begin_patch hunk+ end_patch',
      },
    },
  ];
}

describe('apply_patch freeform client projection blackbox', () => {
  it('projects provider JSON patch arguments back to Codex raw freeform patch text', () => {
    const output = normalizeResponsesToolCallArgumentsForClientWithNative(
      buildResponsesPayload(),
      buildCodexFreeformApplyPatchTool(),
    );

    expect(output.output?.[0]?.arguments).toBe(PATCH);
    const toolCall = output.required_action?.submit_tool_outputs?.tool_calls?.[0];
    expect(toolCall?.arguments).toBe(PATCH);
    expect(toolCall?.function?.arguments).toBe(PATCH);
    expect(JSON.stringify(output)).not.toContain('{\\"patch\\"');
    expect(JSON.stringify(output)).not.toContain('"patch":');
  });
});
