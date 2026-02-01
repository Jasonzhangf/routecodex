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
