import { decorateFinalChatWithServerToolContext } from '../../sharedmodule/llmswitch-core/src/servertool/backend-route-finalize-block.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

describe('finish_reason policy', () => {

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
