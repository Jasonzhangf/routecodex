import { runChatResponseToolFilters } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.js';

describe('runChatResponseToolFilters exec_command raw shape', () => {
  it('does not alias-repair command-only args into cmd', async () => {
    const input: any = {
      id: 'chatcmpl-invalid',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_invalid_exec',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: 'pwd' })
                }
              }
            ]
          }
        }
      ]
    };

    const out = await runChatResponseToolFilters(input, {
      entryEndpoint: '/v1/responses',
      requestId: 'resp_filter_exec_command_raw_shape',
      profile: 'openai-chat'
    });

    const args = JSON.parse(String(out.choices[0].message.tool_calls[0].function.arguments));
    expect(args).toEqual({ command: 'pwd' });
  });
});
