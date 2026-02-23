import { afterAll, describe, expect, test } from '@jest/globals';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildReviewToolCallPayload(): JsonObject {
  return {
    id: 'chatcmpl-review-1',
    object: 'chat.completion',
    model: 'kimi-k2.5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_review_1',
              type: 'function',
              function: {
                name: 'review',
                arguments: JSON.stringify({
                  goal: '检查当前实现是否真的完成目标并给出下一步动作',
                  focus: 'tests/build/evidence'
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('review servertool followup', () => {
  const prevEnabled = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;

  afterAll(() => {
    if (prevEnabled === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
      return;
    }
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = prevEnabled;
  });

  test('dispatches client-inject-only followup and skips reenter', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '0';

    const adapterContext: AdapterContext = {
      requestId: 'req-review-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey: 'iflow.1-186.kimi-k2.5',
      stream: false,
      sessionId: 'session-review-1',
      metadata: {
        workdir: '/tmp/review-workdir'
      },
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '请继续实现并自查。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    let reenterCalled = false;
    const orchestration = await runServerToolOrchestration({
      chat: buildReviewToolCallPayload(),
      adapterContext,
      requestId: 'req-review-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async () => {
        reenterCalled = true;
        return { body: { id: 'unexpected' } as JsonObject };
      },
      clientInjectDispatch: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { ok: true } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('review_flow');
    expect(reenterCalled).toBe(false);
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.clientInjectOnly).toBe(true);
    expect(typeof (capturedFollowupMeta as any)?.clientInjectText).toBe('string');
    expect(String((capturedFollowupMeta as any)?.clientInjectText || '')).toContain('代码 review');
    expect((capturedFollowupMeta as any)?.clientInjectSource).toBe('servertool.review');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe('iflow.1-186.kimi-k2.5');
  });
});
