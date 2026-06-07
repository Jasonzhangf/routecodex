import { describe, expect, test } from '@jest/globals';

import { applyFollowupDeltaPlan } from '../../sharedmodule/llmswitch-core/src/servertool/backend-route-origin-delta.js';

const SAMPLE_UPDATE_PATCH = '*** Begin Patch\n*** Update File: sample.txt\n@@\n- old\n+ new\n*** End Patch';
const A_TS_UPDATE_PATCH = '*** Begin Patch\n*** Update File: a.ts\n@@\n- old\n+ new\n*** End Patch';
const TMP_A_ADD_PATCH = '*** Begin Patch\n*** Add File: tmp/a.txt\n+ a\n*** End Patch';
const TMP_B_ADD_PATCH = '*** Begin Patch\n*** Add File: tmp/b.txt\n+ b\n*** End Patch';

describe('servertool followup origin clone delta', () => {
  test('clones origin request and appends canonical apply_patch result delta', () => {
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
      parameters: { temperature: 0.2 },
      parallel_tool_calls: true,
      store: false
    } as any;
    const finalChatResponse = {
      tool_outputs: [{
        tool_call_id: 'call_patch_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: SAMPLE_UPDATE_PATCH }),
        content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'sample.txt' })
      }]
    } as any;

    const payload = applyFollowupDeltaPlan({
      adapterContext: {},
      finalChatResponse,
      seed,
      injection: {
        ops: [
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      } as any
    }) as any;

    expect(payload.model).toBe('gpt-test');
    expect(payload.parameters).toEqual({ temperature: 0.2 });
    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.store).toBe(false);
    expect(payload.messages[0]).toEqual({ role: 'user', content: 'edit sample' });
    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_patch_1',
        type: 'function',
        function: {
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: SAMPLE_UPDATE_PATCH })
        }
      }]
    });
    expect(payload.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_patch_1',
      content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'sample.txt' })
    });
    expect(payload.tools).toEqual(seed.tools);
    expect(seed.messages).toEqual([{ role: 'user', content: 'edit sample' }]);
    expect(seed.tools[0]).toBe(originTool);
    expect(JSON.stringify(payload)).not.toContain('fileContent');
    expect(JSON.stringify(payload)).not.toContain('"filePath":"sample.txt"');
  });





  test('RED: captured responses tool results rebuild canonical assistant/tool messages for apply_patch followup', () => {
    const seed = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'retry edit' }],
      tools: [
        { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
      ]
    } as any;
    const payload = applyFollowupDeltaPlan({
      adapterContext: {
        responsesContext: {
          __captured_tool_results: [
            {
              tool_call_id: 'call_patch_ctx_1',
              name: 'apply_patch',
              arguments: JSON.stringify({ patch: A_TS_UPDATE_PATCH }),
              output: { status: 'APPLY_PATCH_ERROR', ok: false }
            }
          ]
        }
      } as any,
      finalChatResponse: {} as any,
      seed,
      injection: {
        ops: [
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      } as any
    }) as any;

    expect(payload.messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'retry edit' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_patch_ctx_1',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ patch: A_TS_UPDATE_PATCH })
            }
          }
        ]
      }
    ]);
    expect(payload.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_patch_ctx_1'
    });
    expect(JSON.parse(payload.messages[2].content)).toEqual({ status: 'APPLY_PATCH_ERROR', ok: false });
    expect(payload.tools).toEqual(seed.tools);
  });

  test('normalizes split pending tool calls before appending multiple tool outputs', () => {
    const seed = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'run two edits' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_patch_1',
            type: 'function',
            function: { name: 'apply_patch', arguments: JSON.stringify({ patch: TMP_A_ADD_PATCH }) }
          }]
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_patch_2',
            type: 'function',
            function: { name: 'apply_patch', arguments: JSON.stringify({ patch: TMP_B_ADD_PATCH }) }
          }]
        }
      ],
      tools: [
        { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }
      ]
    } as any;
    const finalChatResponse = {
      tool_outputs: [
        {
          tool_call_id: 'call_patch_1',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: TMP_A_ADD_PATCH }),
          content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'tmp/a.txt' })
        },
        {
          tool_call_id: 'call_patch_2',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: TMP_B_ADD_PATCH }),
          content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'tmp/b.txt' })
        }
      ]
    } as any;

    const payload = applyFollowupDeltaPlan({
      adapterContext: {},
      finalChatResponse,
      seed,
      injection: {
        ops: [
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      } as any
    }) as any;

    expect(payload.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_patch_1',
            type: 'function',
            function: { name: 'apply_patch', arguments: JSON.stringify({ patch: TMP_A_ADD_PATCH }) }
          },
          {
            id: 'call_patch_2',
            type: 'function',
            function: { name: 'apply_patch', arguments: JSON.stringify({ patch: TMP_B_ADD_PATCH }) }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_patch_1',
        content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'tmp/a.txt' })
      },
      {
        role: 'tool',
        tool_call_id: 'call_patch_2',
        content: JSON.stringify({ status: 'APPLY_PATCH_APPLIED', ok: true, filePath: 'tmp/b.txt' })
      }
    ]);
    expect(payload.tools).toEqual(seed.tools);
  });

  test('clones responses entry origin and appends followup delta to input', () => {
    const seed = {
      model: 'gpt-test',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original responses request' }]
      }],
      tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      parallel_tool_calls: true
    } as any;

    const payload = applyFollowupDeltaPlan({
      adapterContext: {},
      finalChatResponse: {} as any,
      seed,
      injection: {
        ops: [
          { op: 'append_user_text', text: 'continue with stopless schema' }
        ]
      } as any
    }) as any;

    expect(payload.messages).toBeUndefined();
    expect(payload.input).toHaveLength(2);
    expect(payload.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(payload.input[1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'continue with stopless schema' }]
    });
    expect(payload.tools).toEqual(seed.tools);
    expect(payload.tool_choice).toBe('auto');
    expect(payload.parallel_tool_calls).toBe(true);
  });
});
