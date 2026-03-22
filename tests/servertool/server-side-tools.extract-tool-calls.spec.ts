import { describe, expect, test } from '@jest/globals';
import { extractToolCalls } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';

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
});

