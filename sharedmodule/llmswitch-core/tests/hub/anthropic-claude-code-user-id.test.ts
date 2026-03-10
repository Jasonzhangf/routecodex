import { describe, expect, test } from '@jest/globals';

import { applyAnthropicClaudeCodeSystemPromptCompat } from '../../src/conversion/compat/actions/anthropic-claude-code-system-prompt.js';

describe('anthropic claude-code compat metadata.user_id', () => {
  test('fills metadata.user_id with native Claude Code shape from metadata.clientHeaders.session_id', () => {
    const payload: any = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        clientHeaders: { session_id: 'sid_test_123' }
      }
    };

    const out: any = applyAnthropicClaudeCodeSystemPromptCompat(payload, undefined, {
      requestId: 'req_test',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      compatibilityProfile: 'chat:claude-code'
    });

    expect(out.metadata).toBeTruthy();
    expect(out.metadata.user_id).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/);
  });

  test('does not override existing metadata.user_id', () => {
    const existingUserId =
      'user_' + 'b'.repeat(64) + '_account__session_123e4567-e89b-42d3-a456-426614174000';
    const payload: any = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        user_id: existingUserId,
        clientHeaders: { session_id: 'sid_should_not_override' }
      }
    };

    const out: any = applyAnthropicClaudeCodeSystemPromptCompat(payload, undefined, {
      providerProtocol: 'anthropic-messages',
      compatibilityProfile: 'chat:claude-code'
    });

    expect(out.metadata.user_id).toBe(existingUserId);
  });
});
