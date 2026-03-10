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
});
