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

  it('strips mappable response semantics from followup metadata before hub reentry', () => {
    const metadata = buildServerToolNestedRequestMetadata({
      baseMetadata: {
        responsesContext: { previous_response_id: 'resp_1' },
        extraFields: { store: true },
        contextSnapshot: { store: true },
        responseFormat: { type: 'json_schema' },
        __rt: {
          serverToolFollowup: true,
          responsesContext: { previous_response_id: 'resp_rt_1' },
          extraFields: { store: true }
        }
      },
      extraMetadata: {
        responses_context: { previous_response_id: 'resp_2' },
        extra_fields: { store: true },
        systemInstructions: ['legacy'],
        __rt: {
          serverToolFollowup: true,
          responses_context: { previous_response_id: 'resp_rt_2' },
          extra_fields: { store: true }
        }
      },
      entryEndpoint: '/v1/responses'
    });

    expect(metadata).not.toHaveProperty('responsesContext');
    expect(metadata).not.toHaveProperty('responses_context');
    expect(metadata).not.toHaveProperty('contextSnapshot');
    expect(metadata).not.toHaveProperty('contextMetadataKey');
    expect(metadata).not.toHaveProperty('extraFields');
    expect(metadata).not.toHaveProperty('extra_fields');
    expect(metadata).not.toHaveProperty('responseFormat');
    expect(metadata).not.toHaveProperty('systemInstructions');
    expect(metadata.__rt).not.toHaveProperty('responsesContext');
    expect(metadata.__rt).not.toHaveProperty('responses_context');
    expect(metadata.__rt).not.toHaveProperty('extraFields');
    expect(metadata.__rt).not.toHaveProperty('extra_fields');
  });

  it('does not inherit provider selection metadata for followup reentry', () => {
    const metadata = buildServerToolNestedRequestMetadata({
      baseMetadata: {
        routeName: 'thinking',
        routeHint: 'thinking',
        providerKey: 'crs1.key1.gpt-5.3-codex',
        runtimeKey: 'crs1.key1',
        targetProviderKey: 'crs1.key1.gpt-5.3-codex',
        __routecodexPreselectedRoute: {
          providerKey: 'crs1.key1.gpt-5.3-codex',
          runtimeKey: 'crs1.key1'
        },
        target: { providerKey: 'crs1.key1.gpt-5.3-codex' },
        __rt: {
          serverToolFollowup: true,
          routeName: 'thinking',
          providerKey: 'crs1.key1.gpt-5.3-codex',
          runtimeKey: 'crs1.key1',
          targetProviderKey: 'crs1.key1.gpt-5.3-codex',
          __routecodexPreselectedRoute: {
            providerKey: 'crs1.key1.gpt-5.3-codex',
            runtimeKey: 'crs1.key1'
          },
          target: { providerKey: 'crs1.key1.gpt-5.3-codex' }
        }
      },
      extraMetadata: {
        __rt: { serverToolFollowup: true }
      },
      entryEndpoint: '/v1/responses'
    });

    expect(metadata.routeName).toBe('thinking');
    expect(metadata.routeHint).toBe('thinking');
    expect(metadata).not.toHaveProperty('providerKey');
    expect(metadata).not.toHaveProperty('runtimeKey');
    expect(metadata).not.toHaveProperty('targetProviderKey');
    expect(metadata).not.toHaveProperty('__routecodexPreselectedRoute');
    expect(metadata).not.toHaveProperty('target');
    expect(metadata.__rt).toHaveProperty('serverToolFollowup', true);
    expect(metadata.__rt).toHaveProperty('routeName', 'thinking');
    expect(metadata.__rt).not.toHaveProperty('providerKey');
    expect(metadata.__rt).not.toHaveProperty('runtimeKey');
    expect(metadata.__rt).not.toHaveProperty('targetProviderKey');
    expect(metadata.__rt).not.toHaveProperty('__routecodexPreselectedRoute');
    expect(metadata.__rt).not.toHaveProperty('target');
  });

  it('preserves client route hint header for followup reentry without provider pinning', () => {
    const metadata = buildServerToolNestedRequestMetadata({
      baseMetadata: {
        clientHeaders: {
          'x-route-hint': 'search'
        },
        providerKey: 'minimax.key1.MiniMax-M3',
        targetProviderKey: 'minimax.key1.MiniMax-M3',
        target: { providerKey: 'minimax.key1.MiniMax-M3' },
        __rt: {
          serverToolFollowup: true,
          providerKey: 'minimax.key1.MiniMax-M3',
          targetProviderKey: 'minimax.key1.MiniMax-M3'
        }
      },
      extraMetadata: {
        __rt: { serverToolFollowup: true }
      },
      entryEndpoint: '/v1/responses'
    });

    expect(metadata.routeHint).toBe('search');
    expect(metadata).not.toHaveProperty('providerKey');
    expect(metadata).not.toHaveProperty('targetProviderKey');
    expect(metadata).not.toHaveProperty('target');
    expect(metadata.__rt).not.toHaveProperty('providerKey');
    expect(metadata.__rt).not.toHaveProperty('targetProviderKey');
  });
});
