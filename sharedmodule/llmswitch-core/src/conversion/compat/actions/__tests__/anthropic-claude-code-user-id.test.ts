import { applyAnthropicClaudeCodeUserIdCompat } from '../anthropic-claude-code-user-id.js';

describe('anthropic-claude-code-user-id native wrapper', () => {
  test('injects metadata.user_id from session context and updates the original object', () => {
    const payload: any = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        clientHeaders: { session_id: 'sid_test_123' },
      },
    };
    const rootRef = payload;
    const metadataRef = payload.metadata;

    applyAnthropicClaudeCodeUserIdCompat(payload, {
      compatibilityProfile: 'chat:claude-code',
      providerProtocol: 'anthropic-messages',
      requestId: 'req_claude_user_id_1',
      entryEndpoint: '/v1/messages',
    } as any);

    expect(payload).toBe(rootRef);
    expect(payload.metadata).not.toBe(metadataRef);
    expect(payload.metadata.user_id).toMatch(
      /^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/,
    );
  });

  test('fills metadata when context is missing but preserves payload semantics', () => {
    const payload: any = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }],
    };

    applyAnthropicClaudeCodeUserIdCompat(payload);

    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.metadata.user_id).toMatch(
      /^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/,
    );
  });

  test('does not pollute unrelated fields and preserves existing valid user_id', () => {
    const existingUserId =
      'user_' + 'b'.repeat(64) + '_account__session_123e4567-e89b-42d3-a456-426614174000';
    const payload: any = {
      model: 'glm-4.7',
      temperature: 0.4,
      metadata: {
        user_id: existingUserId,
        trace: 'keep',
        clientHeaders: { session_id: 'sid_should_not_override' },
      },
      extra: { ok: true },
    };

    applyAnthropicClaudeCodeUserIdCompat(payload, {
      providerProtocol: 'anthropic-messages',
    } as any);

    expect(payload.metadata.user_id).toBe(existingUserId);
    expect(payload.metadata.trace).toBe('keep');
    expect(payload.temperature).toBe(0.4);
    expect(payload.extra).toEqual({ ok: true });
  });
});
