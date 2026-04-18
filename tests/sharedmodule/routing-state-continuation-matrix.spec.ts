import { describe, expect, it } from '@jest/globals';

import { resolveStickyKey } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/keys.js';

describe('routing-state continuation matrix', () => {
  it('uses continuation request_chain across non-responses protocols', () => {
    expect(
      resolveStickyKey({
        requestId: 'req_chat_1',
        providerProtocol: 'openai-chat',
        sessionId: 'session_should_lose',
        continuation: {
          chainId: 'chain_request_root_1',
          stickyScope: 'request_chain',
          resumeFrom: {
            requestId: 'chain_request_root_1',
            protocol: 'openai-responses'
          }
        }
      } as any)
    ).toBe('chain_request_root_1');
  });

  it('uses continuation session scope when unified semantics says session', () => {
    expect(
      resolveStickyKey({
        requestId: 'req_anthropic_1',
        providerProtocol: 'anthropic-messages',
        sessionId: 'session_scope_1',
        conversationId: 'conversation_should_lose',
        continuation: {
          stickyScope: 'session',
          stateOrigin: 'anthropic-messages'
        }
      } as any)
    ).toBe('session:session_scope_1');
  });

  it('uses continuation conversation scope when unified semantics says conversation', () => {
    expect(
      resolveStickyKey({
        requestId: 'req_gemini_1',
        providerProtocol: 'gemini-chat',
        conversationId: 'conversation_scope_1',
        continuation: {
          stickyScope: 'conversation',
          stateOrigin: 'gemini-chat'
        }
      } as any)
    ).toBe('conversation:conversation_scope_1');
  });

  it('uses request scope when unified semantics says request', () => {
    expect(
      resolveStickyKey({
        requestId: 'req_scope_only_1',
        providerProtocol: 'openai-chat',
        sessionId: 'session_should_not_win',
        continuation: {
          stickyScope: 'request',
          stateOrigin: 'openai-chat'
        }
      } as any)
    ).toBe('req_scope_only_1');
  });

  it('keeps legacy responses resume only as migration fallback', () => {
    expect(
      resolveStickyKey({
        requestId: 'req_responses_legacy_1',
        providerProtocol: 'openai-responses',
        sessionId: 'session_should_lose_to_legacy_chain',
        responsesResume: {
          previousRequestId: 'req_chain_legacy_1'
        }
      } as any)
    ).toBe('req_chain_legacy_1');
  });
});
