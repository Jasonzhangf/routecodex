import { describe, expect, test } from '@jest/globals';

import {
  buildServerToolLoopState,
  readServerToolLoopState
} from '../../sharedmodule/llmswitch-core/src/servertool/loop-state-block.js';

const decision = {
  flowId: 'web_search_flow',
  outcomeMode: 'reenter',
  noFollowup: false,
  autoLimit: false,
  flowOnlyLoopLimit: false,
  clientInjectOnly: false,
  clearStateOnFollowupFailure: false,
  seedLoopPayload: false,
  ignoreRequiresActionFollowup: false
} as any;

describe('servertool loop-state block', () => {
  test('reads loop state through native normalization', () => {
    const state = readServerToolLoopState({
      __rt: {
        serverToolLoopState: {
          flowId: ' stop_message_flow ',
          payloadHash: ' __servertool_auto__ ',
          repeatCount: 2.8,
          startedAtMs: -10,
          stopPairRepeatCount: 3.2,
          stopPairWarned: true
        }
      }
    } as any);

    expect(state).toEqual({
      flowId: 'stop_message_flow',
      payloadHash: '__servertool_auto__',
      repeatCount: 2,
      startedAtMs: 0,
      stopPairRepeatCount: 3,
      stopPairWarned: true
    });
  });

  test('plans repeat state through native policy', () => {
    const first = buildServerToolLoopState({
      adapterContext: { __rt: {} } as any,
      flowId: 'web_search_flow',
      decision,
      payload: { query: 'routecodex' },
      logNonBlocking: () => {}
    });

    expect(first?.flowId).toBe('web_search_flow');
    expect(first?.repeatCount).toBe(1);
    expect(first?.payloadHash).toEqual(expect.any(String));
    expect(first?.startedAtMs).toEqual(expect.any(Number));

    const second = buildServerToolLoopState({
      adapterContext: { __rt: { serverToolLoopState: first } } as any,
      flowId: 'web_search_flow',
      decision,
      payload: { query: 'routecodex' },
      logNonBlocking: () => {}
    });

    expect(second?.repeatCount).toBe(2);
    expect(second?.startedAtMs).toBe(first?.startedAtMs);
    expect(second?.payloadHash).toBe(first?.payloadHash);
  });

  test('plans stop-message pair repeat state through native policy', () => {
    const payload = { model: 'gpt-test', messages: [{ role: 'user', content: 'continue' }] };
    const response = { choices: [{ message: { role: 'assistant', content: 'stop' } }] };
    const first = buildServerToolLoopState({
      adapterContext: { __rt: {} } as any,
      flowId: 'stop_message_flow',
      decision: { ...decision, flowId: 'stop_message_flow', flowOnlyLoopLimit: true },
      payload,
      response,
      logNonBlocking: () => {}
    });

    expect(first).toMatchObject({
      flowId: 'stop_message_flow',
      payloadHash: '__servertool_auto__',
      repeatCount: 1,
      stopPairRepeatCount: 1,
      stopPairWarned: false
    });

    const second = buildServerToolLoopState({
      adapterContext: { __rt: { serverToolLoopState: { ...first, stopPairWarned: true } } } as any,
      flowId: 'stop_message_flow',
      decision: { ...decision, flowId: 'stop_message_flow', flowOnlyLoopLimit: true },
      payload,
      response,
      logNonBlocking: () => {}
    });

    expect(second).toMatchObject({
      repeatCount: 2,
      startedAtMs: first?.startedAtMs,
      stopPairHash: first?.stopPairHash,
      stopPairRepeatCount: 2,
      stopPairWarned: true
    });
  });
});
