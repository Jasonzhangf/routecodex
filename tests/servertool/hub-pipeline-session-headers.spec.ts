import { extractSessionIdentifiersFromMetadata } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/session-identifiers.js';

describe('extractSessionIdentifiersFromMetadata', () => {
  test('detects sessionId from condensed sessionid header', () => {
    const identifiers = extractSessionIdentifiersFromMetadata({
      clientHeaders: {
        sessionid: 'sess-123'
      }
    });
    expect(identifiers.sessionId).toBe('sess-123');
    expect(identifiers.conversationId).toBeUndefined();
  });

  test('detects conversationId from condensed conversationid header', () => {
    const identifiers = extractSessionIdentifiersFromMetadata({
      clientHeaders: {
        conversationid: 'conv-999'
      }
    });
    expect(identifiers.conversationId).toBe('conv-999');
    expect(identifiers.sessionId).toBeUndefined();
  });
});
