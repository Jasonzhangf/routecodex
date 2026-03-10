import { describe, expect, test } from '@jest/globals';

import { resolveStickyKey } from '../../src/servertool/handlers/stop-message-auto/runtime-utils.js';

describe('stop_message_auto resolveStickyKey', () => {
  test('uses session scope for openai-responses when sessionId exists and no resume chain', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_1',
      sessionId: 'session_should_win'
    });

    expect(key).toBe('session:session_should_win');
  });

  test('uses session scope for openai-responses from captured context when top-level session is absent', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_capture_1',
      metadata: {
        capturedContext: {
          __hub_capture: {
            context: {
              sessionId: 'session_from_capture'
            }
          }
        }
      }
    });

    expect(key).toBe('session:session_from_capture');
  });

  test('uses conversation scope for openai-responses when sessionId is absent and no resume chain', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_1',
      conversationId: 'conv_should_win'
    });

    expect(key).toBe('conversation:conv_should_win');
  });

  test('uses previousRequestId for openai-responses resume chain', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_2',
      responsesResume: {
        previousRequestId: 'req_chain_root'
      }
    });

    expect(key).toBe('req_chain_root');
  });

  test('prefers responses resume chain over session scope', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_2',
      sessionId: 'session_wins',
      responsesResume: {
        previousRequestId: 'req_chain_root'
      }
    });

    expect(key).toBe('req_chain_root');
  });

  test('falls back to requestId for openai-responses when no session/conversation/resume exists', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_responses_only'
    });

    expect(key).toBe('req_responses_only');
  });

  test('uses session scope for non-responses protocol', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-chat',
      requestId: 'req_chat_1',
      sessionId: 'session_1'
    });

    expect(key).toBe('session:session_1');
  });

  test('falls back to requestId when no session scope exists', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-chat',
      requestId: 'req_chat_2'
    });

    expect(key).toBe('req_chat_2');
  });
});
