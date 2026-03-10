import { harvestToolCallsFromText, harvestToolCallsFromTextWithConfig } from '../harvest-tool-calls-from-text.js';

describe('harvest-tool-calls-from-text compat wrapper', () => {
  test('harvests tool calls from OpenAI chat format', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<tool_call><tool_name>shell</tool_name><arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>'
          }
        }
      ]
    };

    const result = harvestToolCallsFromText(payload as any);
    expect((result as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
  });

  test('harvests tool calls from Responses format', () => {
    const payload = {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<tool_call><tool_name>shell</tool_name><arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>'
            }
          ]
        }
      ]
    };

    const result = harvestToolCallsFromText(payload as any);
    expect((result as any).output).toHaveLength(1);
    expect((result as any).output[0].type).toBe('function_call');
  });

  test('preserves payload if no tool calls found', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello world'
          }
        }
      ]
    };

    const result = harvestToolCallsFromText(payload as any);
    expect(result).toEqual(payload);
  });

  test('harvests native tool call from reasoning_content without [思考] wrapper and removes time tag noise', () => {
    const payload = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            reasoning_content: [
              '[Time/Date]: utc=`2026-03-10T12:18:35.686Z` local=`2026-03-10 20:18:35.686 +08:00` tz=`Asia/Shanghai` nowMs=`1773145115686` ntpOffsetMs=`33`',
              'exec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>'
            ].join('\n')
          }
        }
      ]
    };

    const result = harvestToolCallsFromText(payload as any);
    const choice = (result as any).choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls[0].function.name).toBe('exec_command');
    expect(choice.message.tool_calls[0].function.arguments).toContain('pwd');
    expect(choice.message.reasoning_content).toBeUndefined();
  });

  test('does not mis-harvest plain thinking text without native tool payload', () => {
    const payload = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            reasoning_content: '先思考一下，再直接回答用户，不调用工具。'
          }
        }
      ]
    };

    const result = harvestToolCallsFromText(payload as any);
    expect((result as any).choices[0].message.tool_calls).toBeUndefined();
    expect((result as any).choices[0].message.reasoning_content).toBe('先思考一下，再直接回答用户，不调用工具。');
    expect((result as any).choices[0].finish_reason).toBe('stop');
  });
});
