import { extractSessionIdentifiersFromMetadata } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/session-identifiers.js';

describe('extractSessionIdentifiersFromMetadata', () => {
  test('detects sessionId from condensed sessionid header', () => {
    const identifiers = extractSessionIdentifiersFromMetadata({
      clientHeaders: {
        sessionid: 'sess-123'
      }
    });
    expect(identifiers.sessionId).toBe('sess-123');
    expect(identifiers.conversationId).toBe("sess-123");
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

  test('derives identifiers from raw request metadata user_id', () => {
    const identifiers = extractSessionIdentifiersFromMetadata({
      __raw_request_body: {
        metadata: {
          user_id: 'user_foo__session_5fae623b-22a7-49be-ac82-fb2f3b310878'
        }
      }
    });
    expect(identifiers.sessionId).toBe('5fae623b-22a7-49be-ac82-fb2f3b310878');
    expect(identifiers.conversationId).toBe('5fae623b-22a7-49be-ac82-fb2f3b310878');
  });

  test('parses session token from SSE rawText payload', () => {
    const identifiers = extractSessionIdentifiersFromMetadata({
      __raw_request_body: {
        format: 'sse',
        rawText:
          '{"metadata":{"user_id":"user_0aa6ba833d6dc6ba802c7df4dc307544fbed72fda3244a1c0420844b23b5047f_account__session_019bb087-5b1e-7bd0-b9cb-7317ebd76f74"}}'
      }
    });
    expect(identifiers.sessionId).toBe('019bb087-5b1e-7bd0-b9cb-7317ebd76f74');
    expect(identifiers.conversationId).toBe('019bb087-5b1e-7bd0-b9cb-7317ebd76f74');
  });
});
