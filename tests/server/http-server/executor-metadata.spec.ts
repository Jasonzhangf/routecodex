import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import { buildRequestMetadata } from '../../../src/server/runtime/http-server/executor-metadata.js';
import { getClockClientRegistry } from '../../../src/server/runtime/http-server/clock-client-registry.js';
import { trackClientConnectionState } from '../../../src/server/utils/client-connection-state.js';
import { encodeClockClientApiKey } from '../../../src/utils/clock-client-token.js';

describe('executor metadata clock daemon extraction', () => {
  it('extracts clockDaemonId from apikey bearer suffix', () => {
    const apiKey = encodeClockClientApiKey('sk-base', 'clockd_meta_1');
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

    expect(metadata.clockDaemonId).toBe('clockd_meta_1');
    expect(metadata.sessionId).toBe('conv_meta_1');
  });

  it('prefers explicit daemon header when present', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-2',
      headers: {
        'x-routecodex-clock-daemon-id': 'clockd_header_1',
        authorization: `Bearer ${encodeClockClientApiKey('sk-base', 'clockd_other')}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_2' }
    } as any);

    expect(metadata.clockDaemonId).toBe('clockd_header_1');
  });

  it('extracts session identifiers from request body metadata when input.metadata is empty', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/messages',
      method: 'POST',
      requestId: 'req-meta-3',
      headers: {
        'x-routecodex-clock-daemon-id': 'clockd_header_2'
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

    expect(metadata.clockDaemonId).toBe('clockd_header_2');
    expect(metadata.sessionId).toBe('conv_from_body_meta');
    expect(metadata.conversationId).toBe('conv_from_body_meta');
  });

  it('resolves workdir from clock daemon registry when request metadata omits it', () => {
    const daemonId = 'clockd_meta_workdir_1';
    const registry = getClockClientRegistry();
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
        authorization: `Bearer ${encodeClockClientApiKey('sk-base', daemonId)}`
      },
      query: {},
      body: { messages: [] },
      metadata: { sessionId: 'conv_meta_4' }
    } as any);

    expect(metadata.clockDaemonId).toBe(daemonId);
    expect(metadata.workdir).toBe('/tmp/routecodex-meta-workdir-1');
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
});
