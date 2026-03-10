import { applyAnthropicClaudeCodeSystemPromptCompat } from '../anthropic-claude-code-system-prompt.js';

describe('anthropic-claude-code-system-prompt native wrapper', () => {
  test('normalizes system and injects metadata.user_id through native compat', () => {
    const result = applyAnthropicClaudeCodeSystemPromptCompat(
      {
        model: 'glm-4.7',
        system: [{ type: 'text', text: 'Legacy system prompt' }],
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          clientHeaders: { session_id: 'sid_test_123' }
        }
      } as any,
      undefined,
      {
        compatibilityProfile: 'chat:claude-code',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_claude_1',
        entryEndpoint: '/v1/messages'
      } as any
    );

    expect((result as any).system).toEqual([
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }
    ]);
    expect((result as any).thinking).toEqual({ type: 'adaptive' });
    expect((result as any).output_config).toEqual({ effort: 'medium' });
    expect((result as any).metadata.user_id).toMatch(
      /^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/
    );
    expect((result as any).messages[0].content).toBe('Legacy system prompt\n\nhello');
  });

  test('honors config systemText and preserveExistingSystemAsUserMessage=false via native context', () => {
    const result = applyAnthropicClaudeCodeSystemPromptCompat(
      {
        model: 'glm-5-air',
        system: 'Legacy system prompt',
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      {
        systemText: 'Custom Claude Code system',
        preserveExistingSystemAsUserMessage: false
      },
      {
        compatibilityProfile: 'chat:claude-code',
        providerProtocol: 'anthropic-messages'
      } as any
    );

    expect((result as any).system).toEqual([{ type: 'text', text: 'Custom Claude Code system' }]);
    expect((result as any).messages[0].content).toBe('hello');
    expect((result as any).output_config).toEqual({ effort: 'high' });
  });

  test('preserves existing Claude Code-shaped user_id', () => {
    const existingUserId =
      'user_' + 'a'.repeat(64) + '_account__session_123e4567-e89b-42d3-a456-426614174000';
    const result = applyAnthropicClaudeCodeSystemPromptCompat(
      {
        model: 'glm-4.7',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: {
          user_id: existingUserId,
          clientHeaders: { session_id: 'sid_should_not_override' }
        }
      } as any,
      undefined,
      {
        compatibilityProfile: 'chat:claude-code',
        providerProtocol: 'anthropic-messages'
      } as any
    );

    expect((result as any).metadata.user_id).toBe(existingUserId);
  });
});
