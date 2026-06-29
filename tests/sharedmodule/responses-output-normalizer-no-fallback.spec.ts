import { describe, expect, it } from '@jest/globals';

import { normalizeResponsesMessageItem } from '../../sharedmodule/llmswitch-core/src/sse/shared/responses-output-normalizer.js';
import type { ResponsesMessageItem } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

describe('responses output normalizer no-fallback boundary', () => {
  it('throws when a message id is missing instead of inventing a synthetic id', () => {
    const item = {
      id: '   ',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }]
    } as ResponsesMessageItem;

    expect(() => normalizeResponsesMessageItem(item, { requestId: 'req_no_fallback', outputIndex: 0 }))
      .toThrow('Invalid Responses message: missing id');
  });
});
