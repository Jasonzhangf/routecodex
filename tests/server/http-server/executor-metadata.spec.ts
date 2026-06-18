import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import {
  buildRequestMetadata,
  decorateMetadataForAttempt
} from '../../../src/server/runtime/http-server/executor-metadata.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { finalizeRequestExecutorAttemptMetadata } from '../../../src/server/runtime/http-server/executor/request-executor-attempt-state.js';
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
    expect(metadata.sessionId).toBeUndefined();
    expect(metadata.conversationId).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      sessionId: 'conv_from_body_meta',
      conversationId: 'conv_from_body_meta'
    });
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

  it('does not synthesize request sessionId from tmux-only metadata', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-tmux-no-session-1',
      headers: {},
      query: {},
      body: { input: [] },
      metadata: {
        tmuxSessionId: 'tmux_only_scope_1',
        clientTmuxSessionId: 'tmux_only_scope_1'
      }
    } as any);

    expect(metadata.clientTmuxSessionId).toBe('tmux_only_scope_1');
    expect(metadata.tmuxSessionId).toBe('tmux_only_scope_1');
    expect(metadata.sessionId).toBeUndefined();
    expect(metadata.conversationId).toBeUndefined();
  });

  it('attaches request-scoped metadata center with request truth provenance', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-center-1',
      headers: {},
      query: {},
      body: {
        input: [],
        metadata: {
          sessionId: 'sess-meta-center-1',
          conversationId: 'conv-meta-center-1'
        }
      },
      metadata: {}
    } as any);

    const center = MetadataCenter.read(metadata);
    expect(center).toBeDefined();
    const requestTruth = center?.readRequestTruth();
    expect(requestTruth?.sessionId).toBe('sess-meta-center-1');
    expect(requestTruth?.conversationId).toBe('conv-meta-center-1');

    const snapshot = center?.snapshot();
    expect(snapshot?.requestTruth.sessionId?.writtenBy.module).toContain('executor-metadata.ts');
    expect(snapshot?.requestTruth.sessionId?.writtenBy.stage).toBe('ServerReqInbound01ClientRaw');
    expect(Array.isArray(snapshot?.requestTruth.sessionId?.history)).toBe(true);
    expect(snapshot?.requestTruth.sessionId?.history.length).toBeGreaterThan(0);
  });

  it('materializes request truth from factual Codex session headers', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-codex-header-truth-1',
      headers: {
        'user-agent': 'codex-tui/0.128.0',
        originator: 'codex-tui',
        session_id: 'sess-codex-header-truth-1',
        conversation_id: 'conv-codex-header-truth-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    expect(metadata.sessionId).toBeUndefined();
    expect(metadata.conversationId).toBeUndefined();
    const center = MetadataCenter.read(metadata);
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-codex-header-truth-1',
      conversationId: 'conv-codex-header-truth-1'
    });
  });

  it('finalizeRequestExecutorAttemptMetadata keeps request truth from metadata center instead of relay pipeline metadata', () => {
    const metadataForAttempt = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-finalize-meta-center-1',
      headers: {},
      query: {},
      body: {
        input: [],
        metadata: {
          sessionId: 'sess-request-truth-1',
          conversationId: 'conv-request-truth-1'
        }
      },
      metadata: {}
    } as any);
    const relayPipelineMetadata: Record<string, unknown> = {
      sessionId: 'sess-relay-should-not-win',
      conversationId: 'conv-relay-should-not-win',
    };
    const relayCenter = MetadataCenter.attach(relayPipelineMetadata);
    relayCenter.writeContinuationContext(
      'responsesRequestContext',
      {
        sessionId: 'sess-relay-ctx',
        conversationId: 'conv-relay-ctx'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'finalizeRequestExecutorAttemptMetadata keeps request truth from metadata center instead of relay pipeline metadata',
        stage: 'test'
      }
    );

    const { mergedMetadata } = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-finalize-meta-center-1',
      metadataForAttempt,
      pipelineResult: {
        metadata: relayPipelineMetadata
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-finalize-meta-center-1'
    });

    expect(mergedMetadata.sessionId).toBeUndefined();
    expect(mergedMetadata.conversationId).toBeUndefined();
    expect(mergedMetadata.responsesRequestContext).toBeUndefined();

    const center = MetadataCenter.read(mergedMetadata);
    expect(center?.readContinuationContext().responsesRequestContext).toMatchObject({
      sessionId: 'sess-relay-ctx',
      conversationId: 'conv-relay-ctx'
    });
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-request-truth-1',
      conversationId: 'conv-request-truth-1'
    });
  });

  it('preserves metadata center binding across metadata merges', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-merge-1',
      headers: {
        session_id: 'sess-center-merge-1',
        conversation_id: 'conv-center-merge-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    const center = MetadataCenter.read(metadata);
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-center-merge-1',
      conversationId: 'conv-center-merge-1'
    });

    const { mergedMetadata } = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-center-merge-1',
      metadataForAttempt: metadata,
      pipelineResult: {
        metadata: {
          routeName: 'thinking'
        }
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-center-merge-1'
    });

    const mergedCenter = MetadataCenter.read(mergedMetadata);
    expect(mergedCenter?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-center-merge-1',
      conversationId: 'conv-center-merge-1'
    });
  });

  it('merges provider observation from pipeline metadata center without reviving flat target fields', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-provider-observation-merge-1',
      headers: {
        session_id: 'sess-center-provider-observation-merge-1',
        conversation_id: 'conv-center-provider-observation-merge-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    const pipelineMetadata: Record<string, unknown> = {};
    const pipelineCenter = MetadataCenter.attach(pipelineMetadata);
    pipelineCenter.writeProviderObservation(
      'target',
      {
        providerKey: 'minimax.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
        compatibilityProfile: 'openai-responses'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'merges provider observation from pipeline metadata center without reviving flat target fields',
        stage: 'test'
      }
    );
    pipelineCenter.writeProviderObservation(
      'compatibilityProfile',
      'openai-responses',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'merges provider observation from pipeline metadata center without reviving flat target fields',
        stage: 'test'
      }
    );

    const { mergedMetadata } = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-center-provider-observation-merge-1',
      metadataForAttempt: metadata,
      pipelineResult: {
        metadata: pipelineMetadata
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-center-provider-observation-merge-1'
    });

    expect(mergedMetadata.target).toBeUndefined();
    expect(mergedMetadata.compatibilityProfile).toBeUndefined();
    expect(MetadataCenter.read(mergedMetadata)?.readProviderObservation()).toMatchObject({
      compatibilityProfile: 'openai-responses',
      target: {
        providerKey: 'minimax.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
        compatibilityProfile: 'openai-responses'
      }
    });
  });

  it('merges runtime control from pipeline metadata center without reviving flat retry pin fields', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-runtime-control-merge-1',
      headers: {
        session_id: 'sess-center-runtime-control-merge-1',
        conversation_id: 'conv-center-runtime-control-merge-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    const pipelineMetadata: Record<string, unknown> = {};
    const pipelineCenter = MetadataCenter.attach(pipelineMetadata);
    pipelineCenter.writeRuntimeControl(
      'retryProviderKey',
      'provider.key.model',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'merges runtime control from pipeline metadata center without reviving flat retry pin fields',
        stage: 'test'
      }
    );
    pipelineCenter.writeRuntimeControl(
      'preselectedRoute',
      {
        routeName: 'tools',
        providerKey: 'provider.key.model'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'merges runtime control from pipeline metadata center without reviving flat retry pin fields',
        stage: 'test'
      }
    );

    const { mergedMetadata } = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-center-runtime-control-merge-1',
      metadataForAttempt: metadata,
      pipelineResult: {
        metadata: pipelineMetadata
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-center-runtime-control-merge-1'
    });

    expect(mergedMetadata.__routecodexRetryProviderKey).toBeUndefined();
    expect(mergedMetadata.__routecodexPreselectedRoute).toBeUndefined();
    expect(MetadataCenter.read(mergedMetadata)?.readRuntimeControl()).toMatchObject({
      retryProviderKey: 'provider.key.model',
      preselectedRoute: {
        routeName: 'tools',
        providerKey: 'provider.key.model'
      }
    });
  });

  it('preserves request truth metadata center across attempt decoration clones', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-attempt-clone-1',
      headers: {
        session_id: 'sess-center-attempt-clone-1',
        conversation_id: 'conv-center-attempt-clone-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    const decorated = decorateMetadataForAttempt(metadata, 1, new Set<string>());
    const decoratedCenter = MetadataCenter.read(decorated);

    expect(decoratedCenter?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-center-attempt-clone-1',
      conversationId: 'conv-center-attempt-clone-1'
    });

    const { mergedMetadata } = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-center-attempt-clone-1',
      metadataForAttempt: decorated,
      pipelineResult: {
        metadata: {
          routeName: 'search'
        }
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-req-center-attempt-clone-1'
    });

    expect(mergedMetadata.sessionId).toBeUndefined();
    expect(mergedMetadata.conversationId).toBeUndefined();
    expect(MetadataCenter.read(mergedMetadata)?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-center-attempt-clone-1',
      conversationId: 'conv-center-attempt-clone-1'
    });
  });

  it('preserves request truth in metadata center even if legacy top-level session field is later overwritten', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-stale-top-level-1',
      headers: {
        session_id: 'sess-center-stale-1',
        conversation_id: 'conv-center-stale-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: {}
    } as any);

    metadata.sessionId = 'unknown';

    const center = MetadataCenter.read(metadata);
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-center-stale-1',
      conversationId: 'conv-center-stale-1'
    });
  });

  it('enforces request truth write-once in metadata center', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'sess-write-once-1',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'enforces request truth write-once in metadata center',
        stage: 'test'
      }
    );

    expect(() => {
      center.writeRequestTruth(
        'sessionId',
        'sess-write-once-2',
        {
          module: 'tests/server/http-server/executor-metadata.spec.ts',
          symbol: 'enforces request truth write-once in metadata center',
          stage: 'test'
        }
      );
    }).toThrow(/write-once/);
    expect(center.readRequestTruth().sessionId).toBe('sess-write-once-1');
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

    expect(metadata.sessionId).toBeUndefined();
    expect(metadata.conversationId).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      sessionId: conversationSessionId,
      conversationId: conversationSessionId
    });
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

  it('drops stale preselected route on retry attempts with provider exclusions', () => {
    const preselectedRoute = {
      decision: {
        routeName: 'search',
        providerKey: 'minimax.key1.MiniMax-M3',
        pool: ['minimax.key1.MiniMax-M3', 'mimo.key2.mimo-v2.5']
      }
    };
    const baseMetadata = {
      __routecodexPreselectedRoute: preselectedRoute
    };

    const firstAttempt = decorateMetadataForAttempt(baseMetadata, 1, new Set<string>());
    expect(firstAttempt.__routecodexPreselectedRoute).toEqual(preselectedRoute);

    const retryAttempt = decorateMetadataForAttempt(
      baseMetadata,
      2,
      new Set<string>(['minimax.key1.MiniMax-M3'])
    );

    expect(retryAttempt.excludedProviderKeys).toEqual(['minimax.key1.MiniMax-M3']);
    expect(retryAttempt.__routecodexPreselectedRoute).toBeUndefined();
    expect(baseMetadata.__routecodexPreselectedRoute).toBe(preselectedRoute);
  });
});

describe('executor metadata route hint extraction', () => {
  it('uses input metadata routeHint when no route hint header is present', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-route-hint-meta',
      headers: {},
      query: {},
      body: { input: [] },
      metadata: { routeHint: 'search' }
    } as any);

    expect(metadata.routeHint).toBe('search');
  });

  it('uses body metadata routeHint when no header or input metadata routeHint is present', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-route-hint-body',
      headers: {},
      query: {},
      body: { input: [], metadata: { routeHint: 'tools' } },
      metadata: {}
    } as any);

    expect(metadata.routeHint).toBe('tools');
  });
});
