import { describe, expect, it } from '@jest/globals';

import { resolveStopMessageSessionScope } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';

describe('stopless VR route hint contract', () => {
  it('stopless persisted lookup still uses only sessionId (no tmux/conversation/default fallback)', () => {
    const scope = resolveStopMessageSessionScope({
      sessionId: 'sess-vr-route',
      conversationId: 'conv-ignored',
      clientTmuxSessionId: 'tmux-ignored',
      requestId: 'req-vr-route',
      stopMessageClientInjectScope: 'conversation:legacy'
    } as any);
    expect(scope).toBe('session:sess-vr-route');
  });

  it('responsesRequestContext session does not become stop-message session scope', () => {
    const scope = resolveStopMessageSessionScope({
      requestId: 'req-vr-route-rrc-only',
      metadata: {
        responsesRequestContext: {
          sessionId: 'sess-relay-only',
          conversationId: 'conv-relay-only'
        }
      },
      __rt: {
        responsesRequestContext: {
          sessionId: 'sess-relay-only-rt',
          conversationId: 'conv-relay-only-rt'
        }
      }
    } as any);
    expect(scope).toBeUndefined();
  });

  it('stopless never carries route_hint:tools in normalized metadata', () => {
    const meta = {
      sessionId: 'sess-vr-route-2',
      requestId: 'req-vr-route-2',
      routecodexPortMode: 'router',
      routeHint: 'tools'
    } as any;
    if (meta.routecodexPortMode === 'router' && meta.routeHint === 'tools') {
      delete meta.routeHint;
    }
    expect(meta.routeHint).toBeUndefined();
  });
});
