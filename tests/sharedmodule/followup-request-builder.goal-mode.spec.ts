import { describe, expect, test } from '@jest/globals';

import {
  buildServerToolFollowupChatPayloadFromInjection,
  buildServerToolFollowupPayloadFromInjection
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder.js';

function buildGoalCapturedChatRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: '继续执行目标' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_goal',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_goal',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'reasoning.stop',
          parameters: { type: 'object', properties: {} }
        }
      }
    ]
  };
}

describe('goal-mode followup request builder', () => {
  test('chat followup strips stale reasoning.stop and refuses re-injection in goal mode', () => {
    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: {
        capturedChatRequest: buildGoalCapturedChatRequest(),
        __rt: { goalMode: true }
      },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: {
        ops: [
          { op: 'ensure_standard_tools' },
          { op: 'append_user_text', text: 'stopless 继续执行当前目标' }
        ]
      } as any
    });

    expect(followup).toBeTruthy();
    expect((followup.tools as any[]).map((tool) => tool?.function?.name)).toEqual([
      'get_goal',
      'update_goal'
    ]);
  });

  test('native followup strips stale reasoning.stop and refuses re-injection in goal mode', () => {
    const followup: any = buildServerToolFollowupPayloadFromInjection({
      adapterContext: {
        capturedChatRequest: buildGoalCapturedChatRequest(),
        __rt: { goalMode: true }
      },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: {
        ops: [
          { op: 'ensure_standard_tools' },
          { op: 'append_user_text', text: 'stopless 继续执行当前目标' }
        ]
      } as any
    });

    expect(followup).toBeTruthy();
    expect((followup.tools as any[]).map((tool) => tool?.function?.name)).toEqual([
      'get_goal',
      'update_goal'
    ]);
  });

  test('managed stopless goal followup also strips stale reasoning.stop and refuses re-injection', () => {
    const followup: any = buildServerToolFollowupPayloadFromInjection({
      adapterContext: {
        capturedChatRequest: buildGoalCapturedChatRequest(),
        stoplessGoalState: {
          status: 'active',
          objective: 'continue managed goal',
          updatedAt: Date.now(),
          createdAt: Date.now()
        }
      },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: {
        ops: [
          { op: 'ensure_standard_tools' },
          { op: 'append_user_text', text: '继续执行当前目标' }
        ]
      } as any
    });

    expect(followup).toBeTruthy();
    expect((followup.tools as any[]).map((tool) => tool?.function?.name)).toEqual([
      'get_goal',
      'update_goal'
    ]);
  });
});
