import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.js',
  () => ({
    cloneJson: jest.fn((value: unknown) => JSON.parse(JSON.stringify(value))),
    extractTextFromChatLike: jest.fn(() => ''),
    extractToolCalls: jest.fn(() => []),
    runServerSideToolEngine: jest.fn(),
    runServertoolAutoHookCaller: jest.fn(),
    isClientExecCliProjectionToolCall: jest.fn((toolCall: any) =>
      Boolean(
        toolCall &&
          typeof toolCall.executionMode === 'string' &&
          toolCall.executionMode.trim() === 'client_exec_cli_projection'
      )
    ),
    collectAdditionalClientToolCalls: jest.fn((base: any, projectedToolCallId: string) => {
      const choices = Array.isArray(base?.choices) ? base.choices : [];
      const first = choices[0] ?? {};
      const message = first?.message ?? {};
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      return toolCalls.filter((toolCall: any) => {
        const id = typeof toolCall?.id === 'string' ? toolCall.id : '';
        const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name.trim() : '';
        return Boolean(id) && id !== projectedToolCallId && name !== 'stop_message_auto';
      });
    })
  })
);

const {
  collectAdditionalClientToolCalls,
  isClientExecCliProjectionToolCall
} = await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js');

describe('server-side-tools cli projection guard', () => {
  test('only client_exec_cli_projection execution mode can trigger CLI projection', () => {
    expect(
      isClientExecCliProjectionToolCall({
        id: 'call_cli_projection_1',
        name: 'servertool_fixture',
        arguments: '{}',
        executionMode: 'client_exec_cli_projection'
      })
    ).toBe(true);

    expect(
      isClientExecCliProjectionToolCall({
        id: 'call_client_inject_only_1',
        name: 'continue_execution',
        arguments: '{}',
        executionMode: 'client_inject_only'
      })
    ).toBe(false);
  });

  test('additional client tool calls exclude projected tool call and stop_message_auto only', () => {
    const base = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_projected_1',
                type: 'function',
                function: {
                  name: 'servertool_fixture',
                  arguments: '{}'
                }
              },
              {
                id: 'call_stop_message_1',
                type: 'function',
                function: {
                  name: 'stop_message_auto',
                  arguments: '{}'
                }
              },
              {
                id: 'call_exec_command_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"echo hi"}'
                }
              }
            ]
          }
        }
      ]
    } as any;

    expect(collectAdditionalClientToolCalls(base, 'call_projected_1')).toEqual([
      {
        id: 'call_exec_command_1',
        type: 'function',
        function: {
          name: 'exec_command',
          arguments: '{"cmd":"echo hi"}'
        }
      }
    ]);
  });
});
