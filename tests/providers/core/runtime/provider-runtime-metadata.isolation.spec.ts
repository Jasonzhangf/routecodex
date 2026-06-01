import { describe, expect, it } from '@jest/globals';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata,
  PROVIDER_RUNTIME_SYMBOL
} from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

describe('provider runtime metadata carrier isolation', () => {
  it('keeps metadata as non-enumerable side-channel outside provider wire payload', () => {
    const request = { model: 'gpt-5.4', messages: [], metadata: { user_id: 'wire-must-not-use' } } as Record<string, unknown>;
    attachProviderRuntimeMetadata(request, {
      requestId: 'req-carrier-1',
      metadata: { port: 5520, sessionId: 'session-a', routeHint: 'default' }
    });

    expect(Object.keys(request)).toEqual(['model', 'messages', 'metadata']);
    expect(Object.getOwnPropertyDescriptor(request, PROVIDER_RUNTIME_SYMBOL)?.enumerable).toBe(false);
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      model: 'gpt-5.4',
      messages: [],
      metadata: { user_id: 'wire-must-not-use' }
    });
    expect(extractProviderRuntimeMetadata(request)?.metadata).toEqual({
      port: 5520,
      sessionId: 'session-a',
      routeHint: 'default'
    });
  });

  it('does not share metadata across request, port, or session carriers', () => {
    const requestA = { model: 'gpt-5.4', messages: [] } as Record<string, unknown>;
    const requestB = { model: 'gpt-5.4', messages: [] } as Record<string, unknown>;

    attachProviderRuntimeMetadata(requestA, {
      requestId: 'req-a',
      metadata: { port: 5520, sessionId: 'session-a' }
    });
    attachProviderRuntimeMetadata(requestB, {
      requestId: 'req-b',
      metadata: { port: 5555, sessionId: 'session-b' }
    });

    const metaA = extractProviderRuntimeMetadata(requestA);
    const metaB = extractProviderRuntimeMetadata(requestB);

    expect(metaA?.requestId).toBe('req-a');
    expect(metaB?.requestId).toBe('req-b');
    expect(metaA?.metadata).toEqual({ port: 5520, sessionId: 'session-a' });
    expect(metaB?.metadata).toEqual({ port: 5555, sessionId: 'session-b' });
    expect(metaA?.metadata).not.toBe(metaB?.metadata);
  });
});
