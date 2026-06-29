import { describe, expect, test } from '@jest/globals';
import { extractToolCalls } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.js';
import { mapNativeProviderResponseToChat } from '../sharedmodule/native-response-mapper-test-helper.js';

describe('server-side-tools: extractToolCalls', () => {
  test('skips transcript-like malformed exec_command arguments', () => {
    const chat = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'bad_exec_call',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments:
                    'Chunk ID: f9ed9c\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1080'
                }
              },
              {
                id: 'good_exec_call',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'echo ok' })
                }
              }
            ]
          }
        }
      ]
    } as any;

    const calls = extractToolCalls(chat);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('good_exec_call');
    expect(calls[0]?.name).toBe('exec_command');
  });

  test('fails fast when assistant tool_call id is missing', () => {
    expect(() => extractToolCalls({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'pwd' })
                }
              }
            ]
          }
        }
      ]
    } as any)).toThrow(/tool_call missing required id/i);
  });

  test('assigns canonical ids for allowed internal servertools at extraction source', () => {
    const calls = extractToolCalls({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'continue_execution',
                  arguments: JSON.stringify({ summary: 'keep going' })
                }
              }
            ]
          }
        }
      ]
    } as any, 'req-continue-source-id');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('continue_execution');
    expect(calls[0]?.id).toMatch(/^call_[a-f0-9]{24}$/);
  });

  test('preserves anthropic tool_use ids for downstream servertool execution', () => {
    const chat = mapNativeProviderResponseToChat(
      'anthropic-messages',
      {
          id: 'msg_tool_use_1',
          role: 'assistant',
          model: 'mimo-v2.5-pro',
          content: [
            {
              type: 'tool_use',
              id: 'call_97cb11e6620746fc9a33d1a1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          stop_reason: 'tool_use'
        } as any
    ) as any;

    const calls = extractToolCalls(chat, 'req-anthropic-tool-use-id');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('exec_command');
    expect(calls[0]?.id).toBe('call_97cb11e6620746fc9a33d1a1');
    expect(chat?.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_97cb11e6620746fc9a33d1a1');
  });
});
