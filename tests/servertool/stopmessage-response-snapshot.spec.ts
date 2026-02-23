import { describe, expect, test } from '@jest/globals';

import {
  extractResponsesOutputText,
  extractStopMessageAutoResponseSnapshot
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/iflow-followup.js';

describe('stopmessage response snapshot extraction', () => {
  test('extracts responses message text when content part type is text', () => {
    const payload = {
      object: 'response',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'text',
              text: '这是一段正文'
            }
          ]
        }
      ]
    };

    expect(extractResponsesOutputText(payload)).toBe('这是一段正文');
  });

  test('extracts tool-call arguments instead of only placeholder dot', () => {
    const payload = {
      id: 'chatcmpl-review-args',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '.',
            tool_calls: [
              {
                id: 'call_review_1',
                type: 'function',
                function: {
                  name: 'review',
                  arguments: JSON.stringify({
                    goal: '按照 docs/RUNTIME_SPEC.md 进行完整实现',
                    focus: 'build,test,evidence'
                  })
                }
              }
            ]
          }
        }
      ]
    };

    const snapshot = extractStopMessageAutoResponseSnapshot(payload, {
      providerProtocol: 'openai-chat'
    });

    expect(snapshot.assistantText).toContain('docs/RUNTIME_SPEC.md');
    expect(snapshot.assistantText).toContain('build,test,evidence');
  });
});
