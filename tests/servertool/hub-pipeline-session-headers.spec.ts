import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

function extractSessionIdentifiersFromMetadataDirectNative(
  metadata: Record<string, unknown> | undefined
): { sessionId?: string; conversationId?: string } {
  const fn = nativeBinding.extractSessionIdentifiersJson;
  if (typeof fn !== 'function') {
    throw new Error('extractSessionIdentifiersJson native export is required');
  }
  const raw = fn(JSON.stringify(metadata ?? null));
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('extractSessionIdentifiersJson returned invalid payload');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractSessionIdentifiersJson returned non-object payload');
  }
  return parsed as { sessionId?: string; conversationId?: string };
}

describe('extractSessionIdentifiersFromMetadata', () => {
  test('detects sessionId from direct metadata', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      sessionId: 'sess-direct',
    });
    expect(identifiers.sessionId).toBe('sess-direct');
    expect(identifiers.conversationId).toBeUndefined();
  });

  test('detects conversationId from direct metadata', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      conversation_id: 'conv-direct',
    });
    expect(identifiers.conversationId).toBe('conv-direct');
    expect(identifiers.sessionId).toBeUndefined();
  });

  test('detects sessionId from condensed sessionid header without deriving conversationId', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      clientHeaders: {
        sessionid: 'sess-123'
      }
    });
    expect(identifiers.sessionId).toBe('sess-123');
    expect(identifiers.conversationId).toBeUndefined();
  });

  test('detects conversationId from condensed conversationid header', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      clientHeaders: {
        conversationid: 'conv-999'
      }
    });
    expect(identifiers.conversationId).toBe('conv-999');
    expect(identifiers.sessionId).toBeUndefined();
  });

  test('detects identifiers from normalizedClientHeaders', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      normalizedClientHeaders: {
        'x-session-id': 'sess-normalized',
        'openai-conversation-id': 'conv-normalized'
      }
    });
    expect(identifiers.sessionId).toBe('sess-normalized');
    expect(identifiers.conversationId).toBe('conv-normalized');
  });

  test('does not derive identifiers from raw request body metadata user_id', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      __raw_request_body: {
        metadata: {
          user_id: 'user_foo__session_5fae623b-22a7-49be-ac82-fb2f3b310878'
        }
      }
    });
    expect(identifiers.sessionId).toBeUndefined();
    expect(identifiers.conversationId).toBeUndefined();
  });

  test('does not parse session token from SSE rawText payload', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      __raw_request_body: {
        format: 'sse',
        rawText:
          '{"metadata":{"user_id":"user_0aa6ba833d6dc6ba802c7df4dc307544fbed72fda3244a1c0420844b23b5047f_account__session_019bb087-5b1e-7bd0-b9cb-7317ebd76f74"}}'
      }
    });
    expect(identifiers.sessionId).toBeUndefined();
    expect(identifiers.conversationId).toBeUndefined();
  });

  test('does not parse codex-style generated session token from raw payload fallback', () => {
    const identifiers = extractSessionIdentifiersFromMetadataDirectNative({
      __raw_request_body: {
        metadata: {
          user_id:
            'user_foo__session_codex_cli_session_openai-chat-crs_key2-gpt-5_3-codex-_a4714ec8f5'
        },
        rawText:
          '{"metadata":{"conversation_id":"codex_cli_conversation_openai-chat-crs_key2-gpt-5_3-c_2cc168faa7"}}'
      }
    });
    expect(identifiers.sessionId).toBeUndefined();
    expect(identifiers.conversationId).toBeUndefined();
  });
});
