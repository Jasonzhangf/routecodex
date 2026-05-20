import fs from 'node:fs';

import { sanitizeChatProcessRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.js';

const REAL_SAMPLE_PATH =
  '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778669500982_9b5b55f1/provider-request.json';
const REAL_SINGLETON_MIRROR_SAMPLE_PATH =
  '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778676798002_98daac0b/provider-request.json';

describe('sanitizeChatProcessRequest', () => {
  it('returns the original envelope when messages are missing', () => {
    const input: any = { model: 'gpt-5.4', metadata: { traceId: 'x' } };
    const out: any = sanitizeChatProcessRequest(input);
    expect(out).toBe(input);
  });

  it('does not inject synthetic thinking parameters', () => {
    const input: any = {
      messages: [
        { role: 'user', content: 'hello' }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.parameters).toBeUndefined();
  });

  it('removes empty/template assistant turns and keeps tool_calls turns', () => {
    const input: any = {
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: '   ' },
        {
          role: 'assistant',
          content: "I'm ready to help you with whatever you need. What would you like me to do?"
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        }
      ],
      metadata: { traceId: 't1' }
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(3);
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out.messages[2].tool_calls?.length).toBe(1);
    expect(out.metadata?.chatProcessSanitizer).toEqual({
      removedAssistantTurns: 2,
      removedEmptyAssistantTurns: 1,
      removedTemplateAssistantTurns: 1,
      removedDuplicateMirrorAssistantTurns: 0,
      removedHistoricalGoalTurns: 0,
      removedToolTurns: 0,
      removedEmptyToolTurns: 0,
      removedOrphanToolTurns: 0,
      backfilledToolCallIds: 0
    });
  });

  it('supports array content and strips short template variant', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'm here to help. What would you like me to do?" }
          ]
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '实际业务回复' }]
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content[0].text).toBe('实际业务回复');
    expect(out.metadata?.chatProcessSanitizer?.removedTemplateAssistantTurns).toBe(1);
  });

  it('removes repeated mirror assistant turns after the last tool boundary', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          reasoning_content: '.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '/tmp'
            }
          ]
        },
        {
          role: 'assistant',
          content: 'The daemon is running. Let me run the receipt now.',
          reasoning_content: 'The daemon is running. Let me run the receipt now.'
        },
        {
          role: 'user',
          content: 'Continue working toward the active thread goal.'
        },
        {
          role: 'assistant',
          content: 'I keep saying I will run the receipt, but I am not making a tool call.',
          reasoning_content: 'I keep saying I will run the receipt, but I am not making a tool call.'
        },
        {
          role: 'user',
          content: 'Continue working toward the active thread goal.'
        },
        {
          role: 'assistant',
          content: 'I need to run the qqbot-live-receipt command NOW. No more analysis.',
          reasoning_content: 'I need to run the qqbot-live-receipt command NOW. No more analysis.'
        },
        {
          role: 'user',
          content: 'next delta'
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(5);
    expect(out.messages[0].content?.[0]?.type).toBe('tool_use');
    expect(out.messages[1].content?.[0]?.type).toBe('tool_result');
    expect(out.messages[2]).toMatchObject({
      role: 'user',
      content: 'Continue working toward the active thread goal.'
    });
    expect(out.messages[3]).toMatchObject({
      role: 'user',
      content: 'Continue working toward the active thread goal.'
    });
    expect(out.messages[4]).toMatchObject({
      role: 'user',
      content: 'next delta'
    });
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      removedAssistantTurns: 3,
      removedDuplicateMirrorAssistantTurns: 3
    });
  });

  it('removes a single mirror assistant turn after a tool boundary', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ],
          reasoning_content: '.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '/tmp'
            }
          ]
        },
        {
          role: 'assistant',
          content: 'I will run the receipt now.',
          reasoning_content: 'I will run the receipt now.'
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(2);
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      removedAssistantTurns: 1,
      removedDuplicateMirrorAssistantTurns: 1
    });
  });

  it('does not remove mirror assistant text before any tool boundary exists', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: 'I will run the receipt now.',
          reasoning_content: 'I will run the receipt now.'
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content).toBe('I will run the receipt now.');
    expect(out.metadata?.chatProcessSanitizer).toBeUndefined();
  });

  it('removes historical goal-control turns before the latest user turn', () => {
    const input: any = {
      messages: [
        { role: 'user', content: '普通历史' },
        {
          role: 'developer',
          content: 'Continue working toward the active thread goal.\n\n<untrusted_objective>\n历史 goal\n</untrusted_objective>'
        },
        {
          type: 'function_call',
          id: 'fc_goal_1',
          call_id: 'fc_goal_1',
          name: 'get_goal',
          arguments: '{}'
        },
        {
          type: 'function_call_output',
          call_id: 'fc_goal_1',
          output: '{\"goal\":{\"threadId\":\"t1\",\"objective\":\"历史 goal\"}}'
        },
        {
          role: 'assistant',
          content: 'Goal 已满足全部完成信号。我现在就调用 `update_goal` 标记 `complete`。'
        },
        { role: 'user', content: '继续执行' }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({ role: 'user', content: '普通历史' });
    expect(out.messages[1]).toMatchObject({ role: 'user', content: '继续执行' });
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      removedHistoricalGoalTurns: 4,
      removedAssistantTurns: 4
    });
  });

  it('removes historical user goal_context and turn_aborted control turns before the latest user turn', () => {
    const input: any = {
      messages: [
        { role: 'user', content: '普通历史' },
        {
          role: 'user',
          content: '<goal_context>\nContinue working toward the active thread goal.\n<untrusted_objective>\n历史目标\n</untrusted_objective>\n</goal_context>'
        },
        {
          role: 'user',
          content: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>'
        },
        { role: 'user', content: '继续执行' }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({ role: 'user', content: '普通历史' });
    expect(out.messages[1]).toMatchObject({ role: 'user', content: '继续执行' });
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      removedHistoricalGoalTurns: 2,
      removedAssistantTurns: 2
    });
  });

  it('removes mirrored assistant text across multiple tool-boundary segments', () => {
    const repeatedMirror = 'Jason，我来检查编译构建、全局安装、daemon 重启的脚本链路。';
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'exec_command',
              input: { cmd: 'pwd' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '/tmp'
            }
          ]
        },
        {
          role: 'assistant',
          content: repeatedMirror,
          reasoning_content: repeatedMirror
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'exec_command',
              input: { cmd: 'ls' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_2',
          content: [{ type: 'text', text: 'ok' }]
        },
        {
          role: 'assistant',
          content: repeatedMirror,
          reasoning_content: repeatedMirror
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(4);
    expect(
      out.messages.some(
        (message: any) =>
          message?.role === 'assistant'
          && message?.content === repeatedMirror
          && message?.reasoning_content === repeatedMirror
      )
    ).toBe(false);
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      removedAssistantTurns: 2,
      removedDuplicateMirrorAssistantTurns: 2
    });
  });

  it('keeps reasoning-only assistant turns', () => {
    const input: any = {
      messages: [
        { role: 'user', content: '继续分析' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '我已经确认工作目录，接下来继续分析锁恢复链路。'
        },
        {
          role: 'assistant',
          content: [],
          reasoning: [{ type: 'thinking', thinking: '最终结论：继续排查 provider busy 恢复逻辑。' }]
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(3);
    expect(out.messages[1].reasoning_content).toBe('我已经确认工作目录，接下来继续分析锁恢复链路。');
    expect(out.messages[2].reasoning?.[0]?.thinking).toBe('最终结论：继续排查 provider busy 恢复逻辑。');
    expect(out.metadata?.chatProcessSanitizer).toBeUndefined();
  });

  it('does not over-strip ordinary assistant execution text', () => {
    const input: any = {
      messages: [
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: 'I will execute commands after I inspect the latest logs.'
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].content).toBe('I will execute commands after I inspect the latest logs.');
    expect(out.metadata?.chatProcessSanitizer).toBeUndefined();
  });

  it('does not backfill tool_call_id or drop orphan tool turns', () => {
    const input: any = {
      messages: [
        { role: 'user', content: 'run command' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        { role: 'tool', content: [{ type: 'text', text: 'orphan output' }] }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages).toHaveLength(4);
    expect(out.messages[2].role).toBe('tool');
    expect(out.messages[2].tool_call_id).toBeUndefined();
    expect(out.messages[3].role).toBe('tool');
    expect(out.metadata?.chatProcessSanitizer).toBeUndefined();
  });

  it('preserves assistant tool_calls when id normalization would otherwise drop malformed entries', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            },
            {
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"ls"}' }
            }
          ]
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages[0].tool_calls).toHaveLength(2);
    expect(out.messages[0].tool_calls[1].id).toBeUndefined();
    expect(out.metadata?.chatProcessSanitizer).toBeUndefined();
  });

  it('normalizes tool role call id aliases without deleting the tool turn', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        {
          role: 'tool',
          call_id: 'call_1',
          content: [{ type: 'text', text: 'ok' }]
        },
        {
          role: 'tool',
          id: 'call_2',
          content: [{ type: 'text', text: 'orphan' }]
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages[1].tool_call_id).toBe('call_1');
    expect(out.messages[2].tool_call_id).toBe('call_2');
  });

  (fs.existsSync(REAL_SAMPLE_PATH) ? it : it.skip)('replays the real save/restore loop sample and strips mirrored polluted turns', () => {
    const providerRequest = JSON.parse(fs.readFileSync(REAL_SAMPLE_PATH, 'utf8'));
    const messages = providerRequest?.body?.messages;
    const out: any = sanitizeChatProcessRequest({
      model: 'mimo-v2.5-pro',
      messages,
      metadata: {}
    });

    const lastAssistantMessages = out.messages.slice(-12);
    const mirrorTail = lastAssistantMessages.filter((message: any) =>
      message?.role === 'assistant'
      && typeof message?.content === 'string'
      && typeof message?.reasoning_content === 'string'
      && message.content.trim()
      && message.content === message.reasoning_content
    );

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(out.messages.length);
    expect(mirrorTail).toHaveLength(0);
    expect(out.metadata?.chatProcessSanitizer?.removedDuplicateMirrorAssistantTurns).toBeGreaterThan(0);
  });

  (fs.existsSync(REAL_SINGLETON_MIRROR_SAMPLE_PATH) ? it : it.skip)('replays the singleton mirror sample and removes mirrored assistant planning text after tool boundaries', () => {
    const providerRequest = JSON.parse(fs.readFileSync(REAL_SINGLETON_MIRROR_SAMPLE_PATH, 'utf8'));
    const messages = providerRequest?.body?.messages;
    const out: any = sanitizeChatProcessRequest({
      model: 'mimo-v2.5-pro',
      messages,
      metadata: {}
    });

    const pollutedMirror = (out.messages || []).filter((message: any) =>
      message?.role === 'assistant'
      && message?.content === message?.reasoning_content
      && typeof message?.content === 'string'
      && message.content.includes('The curl test returns 200 now!')
    );

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(out.messages.length);
    expect(pollutedMirror).toHaveLength(0);
    expect(out.metadata?.chatProcessSanitizer?.removedDuplicateMirrorAssistantTurns).toBeGreaterThan(0);
  });
});
