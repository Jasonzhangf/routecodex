import { describe, expect, test } from '@jest/globals';

import { resolveStickyKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';

describe('stop_message_auto continuation sticky key', () => {
  test('uses unified continuation request-chain key before session scope', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-chat',
      requestId: 'req_chat_cont_root',
      sessionId: 'session_should_lose',
      continuation: {
        chainId: 'req_chain_from_continuation',
        stickyScope: 'request_chain',
        resumeFrom: {
          requestId: 'req_chain_from_continuation'
        }
      }
    });

    expect(key).toBe('req_chain_from_continuation');
  });
});
