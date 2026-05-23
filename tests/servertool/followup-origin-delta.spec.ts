import { describe, expect, test } from '@jest/globals';

import { applyFollowupDeltaPlan } from '../../sharedmodule/llmswitch-core/src/servertool/followup-origin-delta.js';

describe('servertool followup origin clone delta', () => {
  test('clones origin request, appends canonical apply_patch result delta, and drops apply_patch tool', () => {
    const originTool = {
      type: 'function',
      function: { name: 'apply_patch', parameters: { type: 'object' } }
    };
    const seed = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit sample' }],
      tools: [
        originTool,
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
      ],
      parameters: { temperature: 0.2 }
    } as any;
    const finalChatResponse = {
      tool_outputs: [{
        tool_call_id: 'call_patch_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ filePath: 'sample.txt', patch: '- old\n+ new' }),
        content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'sample.txt' })
      }]
    } as any;

    const payload = applyFollowupDeltaPlan({
      adapterContext: {},
      finalChatResponse,
      seed,
      injection: {
        ops: [
          { op: 'append_tool_messages_from_tool_outputs', required: true },
          { op: 'drop_tool_by_name', name: 'apply_patch' }
        ]
      } as any
    }) as any;

    expect(payload.model).toBe('gpt-test');
    expect(payload.parameters).toEqual({ temperature: 0.2 });
    expect(payload.messages[0]).toEqual({ role: 'user', content: 'edit sample' });
    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_patch_1',
        type: 'function',
        function: {
          name: 'apply_patch',
          arguments: JSON.stringify({ filePath: 'sample.txt', patch: '- old\n+ new' })
        }
      }]
    });
    expect(payload.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_patch_1',
      content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'sample.txt' })
    });
    expect(payload.tools.map((tool: any) => tool.function.name)).toEqual(['exec_command']);
    expect(seed.messages).toEqual([{ role: 'user', content: 'edit sample' }]);
    expect(seed.tools[0]).toBe(originTool);
    expect(JSON.stringify(payload)).not.toContain('fileContent');
    expect(JSON.stringify(payload)).not.toContain('*** Begin Patch');
  });
});
