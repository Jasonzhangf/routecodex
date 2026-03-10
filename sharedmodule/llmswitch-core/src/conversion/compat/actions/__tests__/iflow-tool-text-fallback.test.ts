import { applyIflowToolTextFallback } from '../iflow-tool-text-fallback.js';

describe('iflow-tool-text-fallback native wrapper', () => {
  test('strips tools/tool_choice and injects tool text system guidance', () => {
    const result = applyIflowToolTextFallback(
      {
        model: 'minimax-m2.5',
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      { models: ['minimax-m2.5'] },
    ) as any;

    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('## Tool Calls (Text Markup Mode)');
  });

  test('converts assistant tool_calls into XML blocks', () => {
    const result = applyIflowToolTextFallback(
      {
        model: 'minimax-m2.5',
        messages: [
          {
            role: 'assistant',
            content: 'before',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd","timeout_ms":1000}',
                },
              },
            ],
          },
        ],
      } as any,
      { models: ['minimax-m2.5'] },
    ) as any;

    expect(result.messages[1].content).toContain('<tool:exec_command>');
    expect(result.messages[1].content).toContain('<command>pwd</command>');
    expect(result.messages[1].tool_calls).toBeUndefined();
  });

  test('converts role=tool messages into user text output', () => {
    const result = applyIflowToolTextFallback(
      {
        model: 'minimax-m2.5',
        messages: [
          {
            role: 'tool',
            name: 'exec_command',
            tool_call_id: 'call_1',
            content: { cwd: '/tmp', exit_code: 0 },
          },
        ],
      } as any,
      { models: ['minimax-m2.5'] },
    ) as any;

    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].content).toContain('Tool result:');
    expect(result.messages[1].content).toContain('tool_call_id: call_1');
    expect(result.messages[1].content).toContain('"cwd": "/tmp"');
  });

  test('does not trigger fallback on web_search/search routes', () => {
    const payload = {
      model: 'minimax-m2.5',
      tools: [{ type: 'function', function: { name: 'exec_command' } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    } as any;

    const result = applyIflowToolTextFallback(payload, {
      models: ['minimax-m2.5'],
      routeId: 'web_search-primary',
    }) as any;

    expect(result).toEqual(payload);
  });
});
