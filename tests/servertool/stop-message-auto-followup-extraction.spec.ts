import { describe, expect, test } from '@jest/globals';
import { extractStopMessageAutoResponseSnapshot } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/iflow-followup.js';

describe('stop message followup snapshot extraction', () => {
  test('extracts meaningful assistant text from tool_use input (choices path)', () => {
    const payload = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'apply_patch',
                input: {
                  patch: '*** Begin Patch\n*** Update File: src/a.ts\n+console.log("ok");\n*** End Patch'
                }
              }
            ]
          }
        }
      ]
    };

    const snapshot = extractStopMessageAutoResponseSnapshot(payload, { providerProtocol: 'openai-chat' });
    expect(snapshot.finishReason).toBe('stop');
    expect(snapshot.assistantText || '').toContain('*** Begin Patch');
    expect(snapshot.assistantText || '').toContain('src/a.ts');
  });

  test('extracts meaningful assistant text from output tool blocks (responses path)', () => {
    const payload = {
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'tool_use',
              name: 'run_command',
              input: {
                command: 'npm test -- tests/unit/orchestration/runtime.test.ts'
              }
            }
          ]
        }
      ]
    };

    const snapshot = extractStopMessageAutoResponseSnapshot(payload, { providerProtocol: 'openai-responses' });
    expect(snapshot.finishReason).toBe('completed');
    expect(snapshot.assistantText || '').toContain('runtime.test.ts');
  });
});
