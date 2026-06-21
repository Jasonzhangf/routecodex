import { describe, expect, test } from '@jest/globals';
import {
  collectAdditionalClientToolCalls,
  isClientExecCliProjectionToolCall
} from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';

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
