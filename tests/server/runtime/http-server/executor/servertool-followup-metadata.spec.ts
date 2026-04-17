import { describe, expect, it } from '@jest/globals';
import {
  buildServerToolNestedRequestMetadata
} from '../../../../../src/server/runtime/http-server/executor/servertool-followup-metadata.js';

describe('servertool followup nested request metadata', () => {
  it('preserves only continuity headers and strips clientRequestId for followup reenter', () => {
    const metadata = buildServerToolNestedRequestMetadata({
      baseMetadata: {
        clientHeaders: {
          'user-agent': 'Codex/1.0',
          'anthropic-session-id': 'sess_base',
          'anthropic-conversation-id': 'conv_base',
          authorization: 'Bearer should-forward'
        }
      },
      extraMetadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'anthropic-session-id': 'sess_123',
          'anthropic-conversation-id': 'conv_456',
          authorization: 'Bearer should-forward'
        },
        clientRequestId: 'req_from_client'
      },
      entryEndpoint: '/v1/messages'
    });

    expect(metadata.clientHeaders).toEqual({
      'user-agent': 'Codex/1.0',
      'anthropic-session-id': 'sess_123',
      'anthropic-conversation-id': 'conv_456',
      authorization: 'Bearer should-forward'
    });
    expect(metadata.clientRequestId).toBeUndefined();
    expect(metadata.sessionId).toBe('sess_123');
    expect(metadata.conversationId).toBe('conv_456');
  });

  it('backfills daemon tmux and workdir continuity tokens from preserved headers', () => {
    const metadata = buildServerToolNestedRequestMetadata({
      baseMetadata: {},
      extraMetadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'x-routecodex-session-daemon-id': 'daemon_1',
          'x-routecodex-client-tmux-session-id': 'tmux_1',
          'x-routecodex-workdir': '/tmp/followup-workdir'
        }
      },
      entryEndpoint: '/v1/responses'
    });

    expect(metadata.clientDaemonId).toBe('daemon_1');
    expect(metadata.sessionDaemonId).toBe('daemon_1');
    expect(metadata.sessionClientDaemonId).toBe('daemon_1');
    expect(metadata.clientTmuxSessionId).toBe('tmux_1');
    expect(metadata.tmuxSessionId).toBe('tmux_1');
    expect(metadata.clientWorkdir).toBe('/tmp/followup-workdir');
    expect(metadata.workdir).toBe('/tmp/followup-workdir');
    expect(metadata.cwd).toBe('/tmp/followup-workdir');
  });
});
