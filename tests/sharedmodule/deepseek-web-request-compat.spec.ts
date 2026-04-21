import { describe, expect, it } from '@jest/globals';
import { applyDeepSeekWebRequestTransform } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-request.js';

describe('deepseek-web request compat', () => {
  it('does not force another required tool call when latest turn is a tool result resume', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: '请执行 pwd' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: "bash -lc 'pwd'" })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'exec_command',
            content: '{"stdout":"/tmp","exit_code":0}'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'tools-deepseek-web-primary'
      } as any
    );

    expect((result as any).prompt).toContain('[Previous tool output — result of a prior tool call');
    expect((result as any).prompt).not.toContain('tool_choice is required for this turn');
    expect((result as any).prompt).not.toContain('This turn is tool-required');
  });
});
