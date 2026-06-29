import { describe, expect, it } from '@jest/globals';

import { createResponseBuilder } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.js';

describe('responses response builder no-salvage boundary', () => {
  it('fails cyclic function_call input instead of coercing it to string or empty JSON', () => {
    const builder = createResponseBuilder();

    expect(builder.processEvent({
      type: 'response.output_item.added',
      timestamp: 1,
      sequenceNumber: 0,
      protocol: 'responses',
      direction: 'sse_to_json',
      data: {
        output_index: 0,
        item: {
          id: 'fc_cyclic_input',
          type: 'function_call',
          status: 'in_progress',
          call_id: 'call_cyclic',
          name: 'exec_command'
        }
      }
    } as any)).toBe(true);

    const cyclicInput: Record<string, unknown> = { cmd: 'pwd' };
    cyclicInput.self = cyclicInput;

    expect(builder.processEvent({
      type: 'response.output_item.done',
      timestamp: 2,
      sequenceNumber: 1,
      protocol: 'responses',
      direction: 'sse_to_json',
      data: {
        output_index: 0,
        item: {
          id: 'fc_cyclic_input',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_cyclic',
          name: 'exec_command',
          input: cyclicInput
        }
      }
    } as any)).toBe(false);

    const result = builder.getResult();
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('circular');
  });
});
