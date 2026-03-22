import { describe, expect, test } from '@jest/globals';

import { resolveStopMessageScope } from '../../src/router/virtual-router/engine/routing-state/store.js';

describe('stop message scope resolution', () => {
  test('uses explicit tmux scope when present', () => {
    const scope = resolveStopMessageScope({ stopMessageClientInjectSessionScope: 'tmux:abc123' } as any);
    expect(scope).toBe('tmux:abc123');
  });

  test('falls back to session scope when tmux scope is missing', () => {
    const scope = resolveStopMessageScope({ sessionId: 'sess-001' } as any);
    expect(scope).toBe('session:sess-001');
  });

  test('falls back to conversation scope when only conversation is provided', () => {
    const scope = resolveStopMessageScope({ conversationId: 'conv-001' } as any);
    expect(scope).toBe('conversation:conv-001');
  });

  test('accepts explicit session scope as-is', () => {
    const scope = resolveStopMessageScope({
      stopMessageClientInjectSessionScope: 'session:sess-explicit'
    } as any);
    expect(scope).toBe('session:sess-explicit');
  });
});
