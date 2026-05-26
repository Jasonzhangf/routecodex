import { describe, expect, test } from '@jest/globals';

import { RequestHeaderBuilder } from '../../../../src/providers/core/runtime/transport/request-header-builder.js';

describe('RequestHeaderBuilder transparency', () => {
  test('does not forward internal session metadata or codex-generated ids upstream for non-opencode providers', async () => {
    const headers = await RequestHeaderBuilder.buildHeaders({
      baseHeaders: { 'Content-Type': 'application/json' },
      serviceHeaders: {},
      overrideHeaders: {},
      runtimeHeaders: {},
      authHeaders: { Authorization: 'Bearer test-key' },
      normalizedClientHeaders: {
        accept: 'text/event-stream',
        session_id: 'sess-internal',
        conversation_id: 'conv-internal'
      },
      inboundMetadata: {
        sessionId: 'sess-meta',
        conversationId: 'conv-meta'
      },
      runtimeMetadata: {
        requestId: 'req-host-internal',
        providerId: 'crs.key1',
        providerKey: 'crs.key1.gpt-5.4',
        providerType: 'responses',
        providerProtocol: 'openai-responses',
        routeName: 'thinking',
        metadata: {
          sessionId: 'sess-runtime',
          conversationId: 'conv-runtime'
        }
      } as any,
      defaultUserAgent: 'RouteCodex/test',
      isGeminiFamily: false,
      codexUaMode: true
    });

    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers.session_id).toBeUndefined();
    expect(headers.conversation_id).toBeUndefined();
  });
});
