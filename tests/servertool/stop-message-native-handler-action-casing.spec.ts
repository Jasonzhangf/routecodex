import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

function nativePath(): string {
  return path.join(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'
  );
}

describe('stop_message native handler action casing', () => {
  it('lowercase trigger action produces stop_followup reenter plan', async () => {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = nativePath();
    const { runStopMessageAutoHandlerWithNative } = await import(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-stop-message-auto-semantics.js'
    );

    const result = runStopMessageAutoHandlerWithNative({
      decision: {
        action: 'trigger',
        used: 0,
        max_repeats: 3,
        followup_text: '继续执行'
      },
      adapterContext: {
        sessionId: 'native-action-casing',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        }
      },
      base: {
        id: 'chatcmpl-native-action-casing',
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
      },
      candidateKeys: ['session:native-action-casing'],
      stickyKey: 'session:native-action-casing'
    });

    expect(result.flowId).toBe('stop_message_flow');
    expect(result.persistKeys).toContain('session:native-action-casing');
    expect(result.stateUpdate).toMatchObject({ used: 1, maxRepeats: 3 });
    expect(result.followup).toMatchObject({
      requestIdSuffix: ':stop_followup',
      injection: {
        ops: expect.arrayContaining([
          expect.objectContaining({ op: 'append_user_text', text: '继续执行' })
        ])
      }
    });
  });
});
