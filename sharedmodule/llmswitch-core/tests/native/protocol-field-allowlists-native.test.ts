import { describe, expect, test } from '@jest/globals';

import {
  ANTHROPIC_ALLOWED_FIELDS,
  GEMINI_ALLOWED_FIELDS,
  OPENAI_CHAT_ALLOWED_FIELDS,
  OPENAI_RESPONSES_ALLOWED_FIELDS,
} from '../../src/conversion/protocol-field-allowlists.js';

describe('protocol field allowlists native bootstrap', () => {
  test('loads allowlists via native bootstrap without throwing', () => {
    expect(OPENAI_CHAT_ALLOWED_FIELDS).toContain('messages');
    expect(OPENAI_RESPONSES_ALLOWED_FIELDS).toContain('input');
    expect(ANTHROPIC_ALLOWED_FIELDS).toContain('messages');
    expect(GEMINI_ALLOWED_FIELDS).toContain('contents');
  });
});
