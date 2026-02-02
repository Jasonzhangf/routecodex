import { applyRequestCompat } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js';

describe('compat profile chat:claude-code', () => {
  it('forces Anthropic system prompt to Claude Code official string', () => {
    const input = {
      model: 'glm-4.7',
      system: [{ type: 'text', text: 'You are Codex, based on GPT-5.' }],
      messages: [{ role: 'user', content: 'hi' }]
    } as any;

    const result = applyRequestCompat('chat:claude-code', input, {
      adapterContext: {
        requestId: 'req-test',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as any
    });

    expect(result.appliedProfile).toBe('chat:claude-code');
    expect(typeof (result.payload as any).metadata).toBe('object');
    const system = (result.payload as any).system;
    expect(Array.isArray(system)).toBe(true);
    expect(system?.[0]?.type).toBe('text');
    expect(system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect((result.payload as any).messages?.[0]?.role).toBe('user');
    expect(String((result.payload as any).messages?.[0]?.content || '')).toContain('You are Codex, based on GPT-5.');
  });

  it('normalizes metadata.user_id to Claude Code canonical shape', () => {
    const sessionId = '019c1bdf-6508-7a01-9cf6-a83d6baf1b2f';
    const input = {
      model: 'glm-4.7',
      metadata: {
        user_id: sessionId
      },
      messages: [{ role: 'user', content: 'hi' }]
    } as any;

    const result = applyRequestCompat('anthropic:claude-code', input, {
      adapterContext: {
        requestId: 'req-userid-shape',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        sessionId
      } as any
    });

    expect(result.appliedProfile).toBe('anthropic:claude-code');
    const userId = String((result.payload as any).metadata?.user_id || '');
    expect(userId).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]{32,}$/i);
    expect(userId.endsWith(sessionId.toLowerCase())).toBe(true);
    expect(userId.includes('_account__session_')).toBe(true);
  });

  it('keeps a valid Claude Code metadata.user_id unchanged', () => {
    const sessionId = '019c1bdf-6508-7a01-9cf6-a83d6baf1b2f';
    const existing = `user_${'a'.repeat(64)}_account__session_${sessionId}`;
    const input = {
      model: 'glm-4.7',
      metadata: {
        user_id: existing
      },
      messages: [{ role: 'user', content: 'hi' }]
    } as any;

    const result = applyRequestCompat('anthropic:claude-code', input, {
      adapterContext: {
        requestId: 'req-userid-keep',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        sessionId
      } as any
    });

    expect(result.appliedProfile).toBe('anthropic:claude-code');
    expect(String((result.payload as any).metadata?.user_id || '')).toBe(existing);
  });

  it('fills metadata.user_id when missing (Claude Code-gated proxies)', () => {
    const sessionId = '019c1bdf-6508-7a01-9cf6-a83d6baf1b2f';
    const input = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }]
    } as any;

    const result = applyRequestCompat('anthropic:claude-code', input, {
      adapterContext: {
        requestId: 'req-userid-fill',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        sessionId
      } as any
    });

    expect(result.appliedProfile).toBe('anthropic:claude-code');
    const userId = String((result.payload as any).metadata?.user_id || '');
    expect(userId).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]{32,}$/i);
    expect(userId.endsWith(sessionId.toLowerCase())).toBe(true);
  });

  it('matches profile id case-insensitively (e.g. Chat:Claude-Code)', () => {
    const input = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hi' }]
    } as any;

    const result = applyRequestCompat('Chat:Claude-Code', input, {
      adapterContext: {
        requestId: 'req-test-case',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as any
    });

    expect(result.appliedProfile).toBe('chat:claude-code');
    expect(typeof (result.payload as any).metadata).toBe('object');
  });
});
