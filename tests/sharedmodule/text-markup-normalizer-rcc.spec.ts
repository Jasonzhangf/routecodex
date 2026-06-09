import { normalizeAssistantTextToToolCalls } from '../../sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.js';

describe('text-markup-normalizer RCC fence surface', () => {
  it('rejects RCC fence with glued closing marker by Rust native contract', () => {
    const message = {
      role: 'assistant',
      content: [
        '前言',
        '• <<RCC_TOOL_CALLS_JSON',
        '{"tool_calls":[{"input":{"cmd":"pwd","name":"exec_command"}}]}RCC_TOOL_CALLS_JSON',
        '尾言'
      ].join('\n')
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? (normalized as any).tool_calls : [];
    expect(toolCalls.length).toBe(0);
    expect((normalized as any).content).toContain('RCC_TOOL_CALLS_JSON');
  });

  it('harvests RCC fence with nested input.name and clears content', () => {
    const message = {
      role: 'assistant',
      content: [
        '前言',
        '• <<RCC_TOOL_CALLS_JSON',
        '{"tool_calls":[{"input":{"cmd":"pwd","name":"exec_command"}}]}',
        'RCC_TOOL_CALLS_JSON',
        '尾言'
      ].join('\n')
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? (normalized as any).tool_calls : [];
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.function?.name).toBe('exec_command');

    const args = JSON.parse(String(toolCalls[0]?.function?.arguments || '{}'));
    expect(args.cmd).toBe('pwd');
    expect((normalized as any).content).toBe('');
  });
});
