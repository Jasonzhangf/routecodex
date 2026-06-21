import { describe, expect, test } from '@jest/globals';
import { extractToolCallsFromResponseStage } from '../../sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.js';

describe('extract-tool-calls-shell', () => {
  test('keeps response-stage extraction in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('runServertoolResponseStageWithNative');
    expect(source).toContain('replaceJsonObjectInPlace');
  });

  test('extracts normalized tool calls and writes canonical payload in place', () => {
    const chat = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
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
    } as any;

    const calls = extractToolCallsFromResponseStage(chat, 'req-1');
    expect(calls).toEqual([
      {
        id: 'call_1',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' })
      }
    ]);
    expect(chat.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_1');
  });
});
