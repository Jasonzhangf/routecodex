import { describe, expect, it } from '@jest/globals';

import {
  requireDirectPassthroughPayloadObject,
} from '../../../../src/server/runtime/http-server/direct-passthrough-payload.js';

describe('direct passthrough minimum hooks', () => {
  it('keeps direct input history and model untouched', () => {
    const firstHistoryItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<goal_context>internal planner prompt</goal_context>' }],
    };
    const toolHistoryItem = {
      type: 'function_call',
      name: 'update_plan',
      call_id: 'call_1',
      arguments: '{}',
    };
    const ingress = {
      model: 'raw-model',
      input: [firstHistoryItem, toolHistoryItem],
      instructions: 'raw-instructions',
    } as Record<string, unknown>;

    const output = requireDirectPassthroughPayloadObject(ingress);

    expect(output).toBe(ingress);
    expect(output.model).toBe('raw-model');
    expect(output.instructions).toBe('raw-instructions');
    expect((output.input as unknown[])[0]).toBe(firstHistoryItem);
    expect((output.input as unknown[])[1]).toBe(toolHistoryItem);
    expect(output.input).toBe(ingress.input);
  });
});
