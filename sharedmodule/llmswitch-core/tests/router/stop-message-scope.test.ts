import { describe, expect, test } from '@jest/globals';

import { resolveStopMessageScope } from '../../src/router/virtual-router/engine/routing-state/store.js';

describe('stop message scope resolution', () => {
  test('uses explicit tmux scope when present', () => {
    const scope = resolveStopMessageScope({ stopMessageClientInjectSessionScope: 'tmux:abc123' } as any);
    expect(scope).toBe('tmux:abc123');
  });

  test('returns undefined when tmux scope is missing', () => {
    const scope = resolveStopMessageScope({ sessionId: 'sess-001' } as any);
    expect(scope).toBeUndefined();
  });

  test('returns undefined when only conversation scope is provided', () => {
    const scope = resolveStopMessageScope({ conversationId: 'conv-001' } as any);
    expect(scope).toBeUndefined();
  });
});
