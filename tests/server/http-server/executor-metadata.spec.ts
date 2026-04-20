import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import {
  buildRequestMetadata,
  decorateMetadataForAttempt
} from '../../../src/server/runtime/http-server/executor-metadata.js';
import { getSessionClientRegistry } from '../../../src/server/runtime/http-server/session-client-registry.js';
import {
  getClientConnectionAbortSignal,
  trackClientConnectionState
} from '../../../src/server/utils/client-connection-state.js';
import { encodeSessionClientApiKey } from '../../../src/utils/session-client-token.js';

describe('executor metadata session daemon extraction', () => {
  it('extracts sessionDaemonId from apikey bearer suffix', () => {
    const apiKey = encodeSessionClientApiKey('sk-base', 'sessiond_meta_1');
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-1',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'codex'
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_1' }
    } as any);

    expect(metadata.clientDaemonId).toBe('sessiond_meta_1');
    expect(metadata.sessionDaemonId).toBe('sessiond_meta_1');
    expect(metadata.sessionId).toBe('conv_meta_1');
    expect(metadata.clientInjectReady).toBe(false);
    expect(metadata.clientInjectReason).toBe('tmux_session_missing');
  });

  it('extracts tmuxSessionId directly from apikey bearer suffix without daemon registry lookup', () => {
    const apiKey = encodeSessionClientApiKey('sk-base', 'sessiond_meta_1', 'tmux_meta_direct_1');
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-1b',
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_1b' }
    } as any);

    expect(metadata.clientDaemonId).toBe('sessiond_meta_1');
    expect(metadata.sessionDaemonId).toBe('sessiond_meta_1');
    expect(metadata.clientTmuxSessionId).toBe('tmux_meta_direct_1');
    expect(metadata.tmuxSessionId).toBe('tmux_meta_direct_1');
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
  });

  it('prefers explicit daemon header when present', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-2',
      headers: {
        'x-routecodex-client-daemon-id': 'sessiond_header_1',
        authorization: `Bearer ${encodeSessionClientApiKey('sk-base', 'sessiond_other')}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_2' }
    } as any);

    expect(metadata.clientDaemonId).toBe('sessiond_header_1');
    expect(metadata.sessionDaemonId).toBe('sessiond_header_1');
  });

  it('extracts session identifiers from request body metadata when input.metadata is empty', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/messages',
      method: 'POST',
      requestId: 'req-meta-3',
      headers: {
        'x-routecodex-session-daemon-id': 'sessiond_header_2'
      },
      query: {},
      body: {
        messages: [{ role: 'user', content: 'ping' }],
        metadata: {
          sessionId: 'conv_from_body_meta',
          conversationId: 'conv_from_body_meta'
        }
      },
      metadata: {}
    } as any);

    expect(metadata.clientDaemonId).toBe('sessiond_header_2');
    expect(metadata.sessionDaemonId).toBe('sessiond_header_2');
    expect(metadata.sessionId).toBe('conv_from_body_meta');
    expect(metadata.conversationId).toBe('conv_from_body_meta');
  });

  it('resolves workdir from session daemon registry without inferring tmux scope', () => {
    const daemonId = 'sessiond_meta_workdir_1';
    const registry = getSessionClientRegistry();
    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65560/inject',
      tmuxSessionId: 'tmux_meta_workdir_1',
      workdir: '/tmp/routecodex-meta-workdir-1'
    });

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-4',
      headers: {
        authorization: `Bearer ${encodeSessionClientApiKey('sk-base', daemonId)}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_4' }
    } as any);

    expect(metadata.clientDaemonId).toBe(daemonId);
    expect(metadata.sessionDaemonId).toBe(daemonId);
    expect(metadata.clientWorkdir).toBe('/tmp/routecodex-meta-workdir-1');
    expect(metadata.workdir).toBe('/tmp/routecodex-meta-workdir-1');
    expect(metadata.clientTmuxSessionId).toBeUndefined();
    expect(metadata.tmuxSessionId).toBeUndefined();
    expect(metadata.clientInjectReady).toBe(false);
    expect(metadata.clientInjectReason).toBe('tmux_session_missing');
    registry.unregister(daemonId);
  });

  it('does not bind tmux session from daemon registry when request lacks tmux scope', () => {
    const daemonId = 'sessiond_meta_no_tmux_1';
    const registry = getSessionClientRegistry();
    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65562/inject',
      tmuxSessionId: 'tmux_registry_should_not_bind',
      workdir: '/tmp/routecodex-meta-workdir-2'
    });

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-4b',
      headers: {
        authorization: `Bearer ${encodeSessionClientApiKey('sk-base', daemonId)}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_4b' }
    } as any);

    expect(metadata.clientDaemonId).toBe(daemonId);
    expect(metadata.sessionDaemonId).toBe(daemonId);
    expect(metadata.clientTmuxSessionId).toBeUndefined();
    expect(metadata.tmuxSessionId).toBeUndefined();
    expect(metadata.clientInjectReady).toBe(false);
    expect(metadata.clientInjectReason).toBe('tmux_session_missing');
    registry.unregister(daemonId);
  });

  it('prefers explicit tmuxSessionId from request metadata over daemon registry value', () => {
    const daemonId = 'sessiond_meta_tmux_prefer_1';
    const registry = getSessionClientRegistry();
    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65561/inject',
      tmuxSessionId: 'tmux_meta_registry_1'
    });

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-5',
      headers: {
        authorization: `Bearer ${encodeSessionClientApiKey('sk-base', daemonId)}`
      },
      query: {},
      body: { messages: [] },
      metadata: { tmuxSessionId: 'tmux_meta_explicit_1' }
    } as any);

    expect(metadata.clientDaemonId).toBe(daemonId);
    expect(metadata.sessionDaemonId).toBe(daemonId);
    expect(metadata.clientTmuxSessionId).toBe('tmux_meta_explicit_1');
    expect(metadata.tmuxSessionId).toBe('tmux_meta_explicit_1');
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
    registry.unregister(daemonId);
  });

  it('extracts tmux session id from x-codex-turn-metadata JSON payload', () => {
    const turnMetadata = JSON.stringify({
      scope: {
        tmux_session: 'tmux_turn_meta_1'
      }
    });
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-turn-1',
      headers: {
        'x-codex-turn-metadata': turnMetadata
      },
      query: {},
      body: { input: [] },
      metadata: {}
    } as any);

    expect(metadata.clientTmuxSessionId).toBe('tmux_turn_meta_1');
    expect(metadata.tmuxSessionId).toBe('tmux_turn_meta_1');
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
  });

  it('extracts tmux session id from URL-encoded base64 turn metadata in client headers', () => {
    const encodedTurnMeta = encodeURIComponent(
      Buffer.from(JSON.stringify({ clientTmuxSessionId: 'tmux_turn_meta_2' }), 'utf8').toString('base64')
    );
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-turn-2',
      headers: {},
      query: {},
      body: { input: [] },
      metadata: {
        clientHeaders: {
          'x-codex-turn-metadata': encodedTurnMeta
        }
      }
    } as any);

    expect(metadata.clientTmuxSessionId).toBe('tmux_turn_meta_2');
    expect(metadata.tmuxSessionId).toBe('tmux_turn_meta_2');
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
  });

  it('extracts workdir from URL-encoded base64 turn metadata in client headers', () => {
    const encodedTurnMeta = encodeURIComponent(
      Buffer.from(JSON.stringify({ workdir: '/tmp/turn-meta-workdir-2' }), 'utf8').toString('base64')
    );
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-turn-workdir-2',
      headers: {},
      query: {},
      body: { input: [] },
      metadata: {
        clientHeaders: {
          'x-codex-turn-metadata': encodedTurnMeta
        }
      }
    } as any);

    expect(metadata.clientWorkdir).toBe('/tmp/turn-meta-workdir-2');
    expect(metadata.workdir).toBe('/tmp/turn-meta-workdir-2');
  });

  it('binds tmux scope by session/workdir when request has no direct tmux metadata', () => {
    const daemonId = 'sessiond_bind_workdir_1';
    const tmuxSessionId = 'rcc_bind_tmux_1';
    const conversationSessionId = 'conv_bind_workdir_1';
    const workdir = '/tmp/routecodex-bind-workdir-1';
    const registry = getSessionClientRegistry();
    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65563/inject',
      tmuxSessionId,
      workdir,
      clientType: 'codex'
    });

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-bind-1',
      headers: {
        'x-codex-turn-metadata': JSON.stringify({
          turn_id: '019c88d2-06ce-7851-b4b0-85952784add8',
          workspaces: {
            '/tmp/routecodex-bind-workdir-1': { has_changes: true }
          },
          sandbox: 'none'
        }),
        session_id: conversationSessionId,
        'user-agent': 'codex_cli_rs/0.104.0',
        originator: 'codex_cli_rs'
      },
      query: {},
      body: { input: [] },
      metadata: {
        clientHeaders: {
          'x-codex-turn-metadata': JSON.stringify({
            turn_id: '019c88d2-06ce-7851-b4b0-85952784add8',
            workspaces: {
              '/tmp/routecodex-bind-workdir-1': { has_changes: true }
            },
            sandbox: 'none'
          }),
          session_id: conversationSessionId,
          'user-agent': 'codex_cli_rs/0.104.0',
          originator: 'codex_cli_rs'
        }
      }
    } as any);

    expect(metadata.sessionId).toBe(conversationSessionId);
    expect(metadata.conversationId).toBe(conversationSessionId);
    expect(metadata.workdir).toBe(workdir);
    expect(metadata.clientTmuxSessionId).toBe(tmuxSessionId);
    expect(metadata.tmuxSessionId).toBe(tmuxSessionId);
    expect(metadata.stopMessageClientInjectSessionScope).toBe(`tmux:${tmuxSessionId}`);
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
    expect(metadata.clientDaemonId).toBe(daemonId);
    expect(metadata.sessionDaemonId).toBe(daemonId);
    expect(registry.resolveBoundTmuxSession(conversationSessionId)).toBe(tmuxSessionId);

    registry.unbindConversationSession(conversationSessionId);
    registry.unregister(daemonId);
  });

  it('resolves tmux scope from conversation binding when request carries sessionId only', () => {
    const daemonId = 'sessiond_meta_binding_1';
    const tmuxSessionId = 'tmux_meta_binding_1';
    const workdir = '/tmp/routecodex-meta-binding-1';
    const conversationSessionId = 'conv_meta_binding_1';
    const registry = getSessionClientRegistry();

    registry.register({
      daemonId,
      callbackUrl: 'http://127.0.0.1:65562/inject',
      tmuxSessionId,
      workdir
    });
    registry.bindConversationSession({
      conversationSessionId,
      daemonId,
      tmuxSessionId,
      workdir
    });

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-6',
      headers: {},
      query: {},
      body: { input: [] },
      metadata: { sessionId: conversationSessionId }
    } as any);

    expect(metadata.sessionId).toBe(conversationSessionId);
    expect(metadata.clientTmuxSessionId).toBe(tmuxSessionId);
    expect(metadata.tmuxSessionId).toBe(tmuxSessionId);
    expect(metadata.clientWorkdir).toBeUndefined();
    expect(metadata.workdir).toBeUndefined();
    expect(metadata.clientInjectReady).toBe(true);
    expect(metadata.clientInjectReason).toBe('tmux_session_ready');
    expect(metadata.stopMessageClientInjectSessionScope).toBe(`tmux:${tmuxSessionId}`);
    expect(metadata.clientDaemonId).toBe(daemonId);
    expect(metadata.sessionDaemonId).toBe(daemonId);

    registry.unbindConversationSession(conversationSessionId);
    registry.unregister(daemonId);
  });
});

describe('client connection timeout hint', () => {
  it('marks disconnected after x-stainless-timeout hint', async () => {
    const req = new EventEmitter() as any;
    req.headers = { 'x-stainless-timeout': '5' };
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    expect(state.disconnected).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(state.disconnected).toBe(true);
  });

  it('aborts provider signal when client request aborts', () => {
    const req = new EventEmitter() as any;
    req.headers = {};
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    const signal = getClientConnectionAbortSignal(state);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    req.emit('aborted');

    expect(state.disconnected).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect((signal as AbortSignal & { reason?: Error }).reason?.message).toContain('CLIENT_REQUEST_ABORTED');
  });

  it('clears timeout hint watcher on normal finish', async () => {
    const req = new EventEmitter() as any;
    req.headers = { 'x-stainless-timeout': '5' };
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    expect(state.disconnected).toBe(false);

    res.writableFinished = true;
    res.writableEnded = true;
    res.emit('finish');

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(state.disconnected).toBe(false);
  });

  it('does not clear timeout hint watcher on request close before response completes', async () => {
    const req = new EventEmitter() as any;
    req.headers = { 'x-stainless-timeout': '5' };
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    req.emit('close');

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(state.disconnected).toBe(true);
  });

  it('preserves client abort signal through decorateMetadataForAttempt clones', () => {
    const req = new EventEmitter() as any;
    req.headers = {};
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    const metadata = decorateMetadataForAttempt(
      { clientConnectionState: state },
      1,
      new Set<string>()
    );
    const signal = getClientConnectionAbortSignal(metadata);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    req.emit('aborted');

    expect(signal?.aborted).toBe(true);
  });
});
