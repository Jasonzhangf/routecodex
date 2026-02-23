import { describe, expect, it } from '@jest/globals';

import { getClockClientRegistry } from '../../../../../src/server/runtime/http-server/clock-client-registry.js';
import {
  resolveStopMessageClientInjectReadiness,
  runClientInjectionFlowBeforeReenter
} from '../../../../../src/server/runtime/http-server/executor/client-injection-flow.js';

describe('client-injection-flow strict tmux isolation', () => {
  it('requires explicit tmux session even if daemon/session mapping exists', () => {
    const registry = getClockClientRegistry();
    const daemonId = `clockd_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const sessionScope = `clockd.${daemonId}`;

    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65531/inject',
      tmuxSessionId: 'tmux_mapped_should_not_be_used',
      workdir: '/tmp/client-inject-flow-test'
    });
    registry.bindConversationSession({
      conversationSessionId: sessionScope,
      daemonId
    });

    const readiness = resolveStopMessageClientInjectReadiness({
      clientDaemonId: daemonId,
      sessionId: 'session_without_tmux'
    });

    expect(readiness).toEqual(
      expect.objectContaining({
        ready: false,
        reason: 'tmux_session_required'
      })
    );

    registry.unbindConversationSession(sessionScope);
    registry.unregister(daemonId);
  });

  it('rejects clientInjectOnly flow when tmux session is missing', async () => {
    await expect(
      runClientInjectionFlowBeforeReenter({
        nestedMetadata: {
          clientInjectOnly: true,
          sessionId: 'session_without_tmux'
        },
        requestBody: {
          messages: [
            {
              role: 'user',
              content: '继续执行'
            }
          ]
        },
        requestId: 'req_client_inject_no_tmux'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'client_inject_failed',
      details: expect.objectContaining({
        reason: 'tmux_session_required'
      })
    });
  });
});
