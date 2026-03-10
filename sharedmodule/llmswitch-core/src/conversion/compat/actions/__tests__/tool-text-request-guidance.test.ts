import { applyToolTextRequestGuidance } from '../tool-text-request-guidance.js';

describe('tool-text-request-guidance native wrapper', () => {
  test('does not inject when tools are missing', () => {
    const payload: any = {
      messages: [{ role: 'user', content: 'hello' }],
    };

    const result = applyToolTextRequestGuidance(payload);

    expect(result).toEqual(payload);
  });

  test('does not duplicate marker when guidance already exists', () => {
    const result = applyToolTextRequestGuidance({
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      messages: [
        {
          role: 'system',
          content: 'Tool-call output contract (STRICT):\nalready there',
        },
      ],
    } as any) as any;

    expect(result.messages[0].content.match(/Tool-call output contract \(STRICT\)/g)).toHaveLength(1);
  });

  test('requires at least one tool call when tool_choice=required', () => {
    const result = applyToolTextRequestGuidance(
      {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required',
        messages: [{ role: 'user', content: 'run pwd' }],
      } as any,
      { includeToolNames: true },
    ) as any;

    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain(
      'tool_choice is required for this turn: return at least one tool call.',
    );
    expect(result.messages[0].content).toContain(
      'Allowed tool names this turn: exec_command',
    );
  });
});
