import { describe, expect, test } from '@jest/globals';

import { detectMockProviderEntryHintForTest } from '../../src/providers/mock/mock-provider-runtime.js';

describe('mock provider runtime entry hint', () => {
  test('treats chat tool messages as followup submit outputs samples', () => {
    expect(detectMockProviderEntryHintForTest(
      { entryEndpoint: '/v1/chat/completions' },
      {
        model: 'smokemodel',
        messages: [
          { role: 'user', content: 'edit target' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'apply_patch', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
        ]
      }
    )).toBe('openai-responses.submit_tool_outputs');
  });
});
