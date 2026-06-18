import { describe, expect, it } from '@jest/globals';

import {
  EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER,
  containsEmptyAssistantSanitizedPlaceholder,
  extractTextFromResponsesOutputItem,
} from '../../../../../src/server/runtime/http-server/executor/request-executor-response-inspect.js';

describe('request executor response inspection helpers', () => {
  it('detects nested empty assistant sanitized placeholders', () => {
    expect(
      containsEmptyAssistantSanitizedPlaceholder({
        output: [
          {
            text: `prefix ${EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER} suffix`,
          },
        ],
      }),
    ).toBe(true);

    expect(
      containsEmptyAssistantSanitizedPlaceholder({
        output: [{ text: 'regular assistant output' }],
      }),
    ).toBe(false);
  });

  it('extracts concatenated text from responses message output items', () => {
    expect(
      extractTextFromResponsesOutputItem({
        type: 'message',
        content: [
          { type: 'output_text', text: 'alpha' },
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'beta' },
        ],
      }),
    ).toBe('alphabeta');
  });
});
