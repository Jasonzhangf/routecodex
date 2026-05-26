import { injectReviewToolOutput } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/review-pure-blocks.js';
import { decorateFinalChatWithServerToolContext } from '../../sharedmodule/llmswitch-core/src/servertool/finalize-followup-block.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('finish_reason policy', () => {
  test('review handler must not rewrite tool_calls to stop after stripping handled call', () => {
    const base: JsonObject = {
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'review', arguments: '{}' } }]
        }
      }]
    } as any;

    const out: any = injectReviewToolOutput({
      base,
      toolCall: { id: 'call_1', type: 'function', function: { name: 'review', arguments: '{}' } } as any
    });

    expect(out.choices?.[0]?.message?.tool_calls).toBeUndefined();
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  test('continue_execution decoration must not force finish_reason=stop', () => {
    const base: JsonObject = {
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null }
      }]
    } as any;

    const out: any = decorateFinalChatWithServerToolContext(
      base,
      { flowId: 'continue_execution_flow', context: { continue_execution: { visibleSummary: 'ok' } } as any }
    );

    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
