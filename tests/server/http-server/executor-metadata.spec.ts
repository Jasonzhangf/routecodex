import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import {
  buildRequestMetadata,
  decorateMetadataForAttempt
} from '../../../src/server/runtime/http-server/executor-metadata.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { finalizeRequestExecutorAttemptMetadata } from '../../../src/server/runtime/http-server/executor/request-executor-attempt-state.js';
import {
  buildMetadataCenterRustSnapshot,
  writeMetadataCenterSlot
} from '../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';
import {
  getClientConnectionAbortSignal,
  trackClientConnectionState
} from '../../../src/server/utils/client-connection-state.js';
import { encodeSessionClientApiKey } from '../../../src/utils/session-client-token.js';

describe('executor metadata session daemon extraction', () => {
  it('does not derive providerProtocol from the client entry endpoint', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      requestId: 'req-meta-provider-protocol-entry-1',
      headers: {},
      query: {},
      body: { messages: [] },
      metadata: {}
    } as any);

    expect(MetadataCenter.read(metadata)?.readRuntimeControl().providerProtocol).toBeUndefined();
    expect(metadata.providerProtocol).toBeUndefined();
  });

  it('preserves providerProtocol across retry attempts while releasing provider pins', () => {
    const initialMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(initialMetadata);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves providerProtocol across retry attempts while releasing provider pins',
        stage: 'test_setup'
      },
      'seed previous attempt provider protocol'
    );
    center.writeRuntimeControl(
      'retryProviderKey',
      'provider.first',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves providerProtocol across retry attempts while releasing provider pins',
        stage: 'test_setup'
      },
      'seed stale retry provider pin'
    );

    const retryMetadata = decorateMetadataForAttempt(initialMetadata, 2, new Set(['provider.first']));

    expect(MetadataCenter.read(retryMetadata)).toBe(center);
    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(center.readRuntimeControl().retryProviderKey).toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(retryMetadata).runtimeControl?.providerProtocol).toBe('openai-responses');
    expect(buildMetadataCenterRustSnapshot(retryMetadata).runtimeControl?.retryProviderKey).toBeUndefined();
  });

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

  it('projects request body session identifiers into inbound metadata and request truth', () => {
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
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      sessionId: 'conv_from_body_meta',
      conversationId: 'conv_from_body_meta'
    });
  });

  it('projects responses client_metadata session id into executor metadata and request truth', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-client-metadata-session',
      headers: {},
      query: {},
      body: {
        model: 'gpt-5.4',
        client_metadata: {
          session_id: '019f34fe-5f32-7c71-8931-9ab3d18422a3',
          thread_id: '019f34fe-5f32-7c71-8931-9ab3d18422a3',
          turn_id: '019f3cdf-9e6c-7ab3-bd5e-336ba07236d3'
        },
        input: []
      },
      metadata: {}
    } as any);

    expect(metadata.sessionId).toBe('019f34fe-5f32-7c71-8931-9ab3d18422a3');
    expect(metadata.conversationId).toBe('019f34fe-5f32-7c71-8931-9ab3d18422a3');
    expect(metadata.logSessionColorKey).toBe('019f34fe-5f32-7c71-8931-9ab3d18422a3');
    expect(metadata.sessionId).not.toBe('019f3cdf-9e6c-7ab3-bd5e-336ba07236d3');
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      sessionId: '019f34fe-5f32-7c71-8931-9ab3d18422a3',
      conversationId: '019f34fe-5f32-7c71-8931-9ab3d18422a3'
    });
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
  });

  it('synthesizes stable request sessionId from tmux-only metadata', () => {
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

    const expectedSessionId = 'rcc-session:tmux_only_scope_1';
    expect(metadata.clientTmuxSessionId).toBe('tmux_only_scope_1');
    expect(metadata.tmuxSessionId).toBe('tmux_only_scope_1');
    expect(metadata.sessionId).toBe(expectedSessionId);
    expect(metadata.conversationId).toBe(expectedSessionId);
    expect(metadata.logSessionColorKey).toBe(expectedSessionId);
    expect(MetadataCenter.read(metadata)?.readRequestTruth().sessionId).toBe(expectedSessionId);
    expect(MetadataCenter.read(metadata)?.readRequestTruth().conversationId).toBe(expectedSessionId);
  });

  it('builds request session identity from inbound codex scope', () => {
    const turnMetadata = JSON.stringify({
      scope: {
        tmux_session: 'tmux_log_scope_1'
      },
      cwd: '/tmp/routecodex-log-scope'
    });
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-log-session-1',
      headers: {
        'user-agent': 'codex-cli',
        'x-codex-turn-metadata': encodeURIComponent(turnMetadata)
      },
      query: {},
      body: { input: [] },
      metadata: {}
    } as any);

    const expectedSessionId = 'rcc-session:codex:tmux_log_scope_1:tmp_routecodex-log-scope';
    expect(metadata.sessionId).toBe(expectedSessionId);
    expect(metadata.conversationId).toBe(expectedSessionId);
    expect(metadata.clientTmuxSessionId).toBe('tmux_log_scope_1');
    expect(metadata.workdir).toBe('/tmp/routecodex-log-scope');
    expect(metadata.logSessionColorKey).toBe(expectedSessionId);
    expect(MetadataCenter.read(metadata)?.readRequestTruth().sessionId).toBe(expectedSessionId);
    expect(MetadataCenter.read(metadata)?.readRequestTruth().conversationId).toBe(expectedSessionId);
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

  it('preserves requestTruth session identity across stopless submit_tool_outputs rounds', () => {
    const round1 = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-stopless-round1',
      headers: {},
      query: {},
      body: {
        input: [],
        metadata: {
          sessionId: 'sess-meta-stopless-roundtrip-1',
          conversationId: 'conv-meta-stopless-roundtrip-1'
        }
      },
      metadata: {}
    } as any);
    const round1Center = MetadataCenter.read(round1);
    expect(round1Center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-meta-stopless-roundtrip-1',
      conversationId: 'conv-meta-stopless-roundtrip-1'
    });

    const round2 = buildRequestMetadata({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      method: 'POST',
      requestId: 'req-meta-stopless-round2',
      headers: {
        'session-id': 'sess-meta-stopless-roundtrip-1',
        'thread-id': 'sess-meta-stopless-roundtrip-1'
      },
      query: {},
      body: {
        tool_outputs: [
          {
            tool_call_id: 'call_servertool_cli_round1',
            output: JSON.stringify({
              ok: true,
              toolName: 'stop_message_auto',
              flowId: 'stop_message_flow',
              repeatCount: 1,
              maxRepeats: 3
            })
          }
        ],
        metadata: {
          sessionId: 'sess-meta-stopless-roundtrip-1',
          conversationId: 'conv-meta-stopless-roundtrip-1'
        }
      },
      metadata: {}
    } as any);
    const round2Center = MetadataCenter.read(round2);
    expect(round2Center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-meta-stopless-roundtrip-1',
      conversationId: 'conv-meta-stopless-roundtrip-1'
    });
  });

  it('keeps stopless runtimeControl progression in metadata center across round writes', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-stopless-runtime-progress',
      headers: {},
      query: {},
      body: {
        input: [],
        metadata: {
          sessionId: 'sess-meta-stopless-runtime-progress',
          conversationId: 'conv-meta-stopless-runtime-progress'
        }
      },
      metadata: {}
    } as any);
    const center = MetadataCenter.read(metadata);
    expect(center).toBeDefined();

    center?.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        active: true,
        triggerHint: 'stop_schema_missing'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'keeps stopless runtimeControl progression in metadata center across round writes',
        stage: 'test'
      }
    );
    expect(center?.readRuntimeControl().stopless).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      active: true,
      triggerHint: 'stop_schema_missing'
    });

    center?.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        active: true,
        triggerHint: 'stop_schema_missing'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'keeps stopless runtimeControl progression in metadata center across round writes',
        stage: 'test'
      }
    );
    expect(center?.readRuntimeControl().stopless).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3,
      active: true,
      triggerHint: 'stop_schema_missing'
    });
    expect(center?.readRuntimeControl().stopless).not.toMatchObject({
      repeatCount: 1
    });
  });

  it('preserves prebound metadata center request truth from handler metadata for resumed relay requests', () => {
    const upstreamMetadata: Record<string, unknown> = {
      routeHint: 'search/gateway-priority-5555-priority-search',
    };
    const center = MetadataCenter.attach(upstreamMetadata);
    center.writeRequestTruth(
      'sessionId',
      'sess-prebound-relay-1',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves prebound metadata center request truth from handler metadata for resumed relay requests',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'conv-prebound-relay-1',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves prebound metadata center request truth from handler metadata for resumed relay requests',
        stage: 'test'
      }
    );
    center.writeContinuationContext(
      'responsesResume',
      {
        responseId: 'resp-prebound-relay-1',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        routeHint: 'search/gateway-priority-5555-priority-search',
        sessionId: 'sess-prebound-relay-1',
        conversationId: 'conv-prebound-relay-1',
        continuationOwner: 'relay'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves prebound metadata center request truth from handler metadata for resumed relay requests',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'retryProviderKey',
      'minimonth.key1.MiniMax-M2.7',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'preserves prebound metadata center request truth from handler metadata for resumed relay requests',
        stage: 'test'
      }
    );

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      method: 'POST',
      requestId: 'req-prebound-relay-1',
      headers: {},
      query: {},
      body: {
        response_id: 'resp-prebound-relay-1',
        tool_outputs: [{ call_id: 'call-1', output: 'ok' }],
      },
      metadata: upstreamMetadata
    } as any);

    const rebound = MetadataCenter.read(metadata);
    expect(rebound).toBe(center);
    expect(rebound?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-prebound-relay-1',
      conversationId: 'conv-prebound-relay-1'
    });
    expect(rebound?.readContinuationContext().responsesResume).toMatchObject({
      responseId: 'resp-prebound-relay-1',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      routeHint: 'search/gateway-priority-5555-priority-search',
      sessionId: 'sess-prebound-relay-1',
      conversationId: 'conv-prebound-relay-1',
      continuationOwner: 'relay'
    });
    expect(rebound?.readRuntimeControl()).toMatchObject({
      retryProviderKey: 'minimonth.key1.MiniMax-M2.7'
    });
  });

  it('writes stopMessageEnabled runtime control when latest responses user input carries stopless directive', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-meta-stopless-directive-1',
      headers: {},
      query: {},
      body: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '请继续处理，并在准备结束时遵守要求。<**stopless:on**>'
              }
            ]
          }
        ]
      },
      metadata: {}
    } as any);

    const center = MetadataCenter.read(metadata);
    expect(center?.readRuntimeControl()).toMatchObject({
      stopMessageEnabled: true
    });
    expect(metadata.stopMessageEnabled).toBeUndefined();
    expect(metadata.routecodexPortStopMessageEnabled).toBeUndefined();
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

    expect(metadata.sessionId).toBe('sess-codex-header-truth-1');
    expect(metadata.conversationId).toBe('conv-codex-header-truth-1');
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
    const requestCenter = MetadataCenter.read(metadataForAttempt);
    expect(requestCenter).toBeDefined();
    MetadataCenter.bind(relayPipelineMetadata, requestCenter!);
    const relayCenter = MetadataCenter.read(relayPipelineMetadata)!;
    relayCenter.writeContinuationContext(
      'responsesResume',
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
    expect(center?.readContinuationContext().responsesResume).toMatchObject({
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
    const requestCenter = MetadataCenter.read(metadata);
    expect(requestCenter).toBeDefined();
    MetadataCenter.bind(pipelineMetadata, requestCenter!);
    const pipelineCenter = MetadataCenter.read(pipelineMetadata)!;
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
    const requestCenter = MetadataCenter.read(metadata);
    expect(requestCenter).toBeDefined();
    MetadataCenter.bind(pipelineMetadata, requestCenter!);
    const pipelineCenter = MetadataCenter.read(pipelineMetadata)!;
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

  it('inherits continuation context MetadataCenter truth from input metadata instead of creating a fresh center', () => {
    const inputMetadata: Record<string, unknown> = {};
    const inputCenter = MetadataCenter.attach(inputMetadata);
    inputCenter.writeContinuationContext(
      'responsesResume',
      {
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        restoredFromResponseId: 'resp_prev_1',
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'inherits continuation context MetadataCenter truth from input metadata instead of creating a fresh center',
        stage: 'test'
      }
    );

    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-center-continuation-inherit-1',
      headers: {
        session_id: 'sess-center-continuation-inherit-1',
        conversation_id: 'conv-center-continuation-inherit-1'
      },
      query: {},
      body: {
        input: []
      },
      metadata: inputMetadata
    } as any);

    expect(MetadataCenter.read(metadata)).toBe(inputCenter);
    expect(MetadataCenter.read(metadata)?.readContinuationContext().responsesResume).toMatchObject({
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      restoredFromResponseId: 'resp_prev_1'
    });
  });

  it('writes resume routeHint and providerKey into runtime_control for submit_tool_outputs replay requests', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      method: 'POST',
      requestId: 'req-center-submit-resume-1',
      headers: {},
      query: {},
      body: {
        input: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }],
        metadata: {
          responsesResume: {
            routeHint: 'search/gateway-priority-5555-priority-search',
            providerKey: 'minimonth.key1.MiniMax-M2.7',
            sessionId: 'sess-submit-resume-1',
            conversationId: 'conv-submit-resume-1'
          }
        }
      },
      metadata: {
        requestId: 'req-center-submit-resume-1',
        __metadataCenter: {
          version: 1,
          requestTruth: {
            sessionId: {
              value: 'sess-submit-resume-1',
              status: 'active',
              writer: {
                module: 'tests/server/http-server/executor-metadata.spec.ts',
                symbol: 'projects resume routeHint and providerKey into flat metadata for submit_tool_outputs replay requests',
                stage: 'test'
              }
            },
            conversationId: {
              value: 'conv-submit-resume-1',
              status: 'active',
              writer: {
                module: 'tests/server/http-server/executor-metadata.spec.ts',
                symbol: 'projects resume routeHint and providerKey into flat metadata for submit_tool_outputs replay requests',
                stage: 'test'
              }
            }
          },
          continuationContext: {
            responsesResume: {
              value: {
                routeHint: 'search/gateway-priority-5555-priority-search',
                providerKey: 'minimonth.key1.MiniMax-M2.7',
                sessionId: 'sess-submit-resume-1',
                conversationId: 'conv-submit-resume-1'
              },
              status: 'active',
              writer: {
                module: 'tests/server/http-server/executor-metadata.spec.ts',
                symbol: 'projects resume routeHint and providerKey into flat metadata for submit_tool_outputs replay requests',
                stage: 'test'
              }
            }
          },
          providerObservation: {},
          runtimeControl: {
            routeHint: {
              value: 'search/gateway-priority-5555-priority-search',
              status: 'active',
              writer: {
                module: 'tests/server/http-server/executor-metadata.spec.ts',
                symbol: 'projects resume routeHint and providerKey into flat metadata for submit_tool_outputs replay requests',
                stage: 'test'
              }
            },
            retryProviderKey: {
              value: 'minimonth.key1.MiniMax-M2.7',
              status: 'active',
              writer: {
                module: 'tests/server/http-server/executor-metadata.spec.ts',
                symbol: 'projects resume routeHint and providerKey into flat metadata for submit_tool_outputs replay requests',
                stage: 'test'
              }
            }
          }
        }
      }
    } as any);

    expect(metadata.routeHint).toBeUndefined();
    expect(metadata.retryProviderKey).toBeUndefined();
    expect(metadata.responsesResume).toMatchObject({
      routeHint: 'search/gateway-priority-5555-priority-search',
      providerKey: 'minimonth.key1.MiniMax-M2.7'
    });
    expect(MetadataCenter.read(metadata)?.readRuntimeControl()).toMatchObject({
      routeHint: 'search/gateway-priority-5555-priority-search',
      retryProviderKey: 'minimonth.key1.MiniMax-M2.7'
    });
  });

  it('keeps responsesResume session scope out of request truth while preserving runtime_control route pin', () => {
    const requestMetadata: Record<string, unknown> = {};
    const requestCenter = MetadataCenter.attach(requestMetadata);
    requestCenter.writeContinuationContext(
      'responsesResume',
      {
        routeHint: 'search/gateway-priority-5555-priority-search',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'sess-submit-resume-center-1',
        conversationId: 'conv-submit-resume-center-1'
      },
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'projects resumed responsesResume session truth and route pin into flat metadata when request truth is only carried by MetadataCenter',
        stage: 'test'
      }
    );
    requestCenter.writeRuntimeControl(
      'routeHint',
      'search/gateway-priority-5555-priority-search',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'projects resumed responsesResume session truth and route pin into flat metadata when request truth is only carried by MetadataCenter',
        stage: 'test'
      }
    );
    requestCenter.writeRuntimeControl(
      'retryProviderKey',
      'minimonth.key1.MiniMax-M2.7',
      {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'projects resumed responsesResume session truth and route pin into flat metadata when request truth is only carried by MetadataCenter',
        stage: 'test'
      }
    );
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      method: 'POST',
      requestId: 'req-center-submit-resume-center-1',
      headers: {},
      query: {},
      body: {
        response_id: 'resp-submit-resume-center-1',
        tool_outputs: [{ call_id: 'call_1', output: 'ok' }],
      },
      metadata: requestMetadata
    } as any);

    expect(metadata.sessionId).toBeUndefined();
    expect(metadata.conversationId).toBeUndefined();
    expect(metadata.routeHint).toBeUndefined();
    expect(metadata.retryProviderKey).toBeUndefined();
    expect(metadata.responsesResume).toMatchObject({
      routeHint: 'search/gateway-priority-5555-priority-search',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      sessionId: 'sess-submit-resume-center-1',
      conversationId: 'conv-submit-resume-center-1'
    });
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      requestId: 'req-center-submit-resume-center-1',
      entryEndpoint: '/v1/responses.submit_tool_outputs'
    });
    expect(MetadataCenter.read(metadata)?.readRequestTruth().sessionId).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRequestTruth().conversationId).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRuntimeControl()).toMatchObject({
      routeHint: 'search/gateway-priority-5555-priority-search',
      retryProviderKey: 'minimonth.key1.MiniMax-M2.7'
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

});

describe('client connection timeout hint', () => {
  it('marks disconnected after x-request-timeout-ms hint', async () => {
    const req = new EventEmitter() as any;
    req.headers = { 'x-request-timeout-ms': '5' };
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    expect(state.disconnected).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(state.disconnected).toBe(true);
  });

  it('treats x-stainless-timeout as seconds, not milliseconds', async () => {
    const req = new EventEmitter() as any;
    req.headers = { 'x-stainless-timeout': '1' };
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;

    const state = trackClientConnectionState(req, res);
    expect(state.disconnected).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(state.disconnected).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 980));
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
    req.headers = { 'x-request-timeout-ms': '5' };
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
    req.headers = { 'x-request-timeout-ms': '5' };
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

  it('drops stale preselected route carriers on retry attempts with provider exclusions', () => {
    const preselectedRoute = {
      target: {
        providerKey: 'minimax.key1.MiniMax-M3'
      },
      decision: {
        routeName: 'search',
        providerKey: 'minimax.key1.MiniMax-M3',
        pool: ['minimax.key1.MiniMax-M3', 'mimo.key2.mimo-v2.5']
      }
    };
    const baseMetadata = {
      __rt: {
        preselectedRoute
      }
    };
    writeMetadataCenterSlot({
      target: baseMetadata,
      family: 'runtime_control',
      key: 'preselectedRoute',
      value: preselectedRoute,
      writer: {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'drops stale preselected route carriers on retry attempts with provider exclusions',
        stage: 'test'
      },
      reason: 'simulate router-direct relay handoff'
    });
    writeMetadataCenterSlot({
      target: baseMetadata,
      family: 'runtime_control',
      key: 'providerProtocol',
      value: 'openai-responses',
      writer: {
        module: 'tests/server/http-server/executor-metadata.spec.ts',
        symbol: 'drops stale preselected route carriers on retry attempts with provider exclusions',
        stage: 'test'
      },
      reason: 'simulate router-direct relay handoff'
    });

    const firstAttempt = decorateMetadataForAttempt(baseMetadata, 1, new Set<string>());
    expect((firstAttempt.__rt as { preselectedRoute?: unknown }).preselectedRoute).toEqual(preselectedRoute);
    expect(MetadataCenter.read(firstAttempt)?.readRuntimeControl().preselectedRoute).toEqual(preselectedRoute);

    const retryAttempt = decorateMetadataForAttempt(
      baseMetadata,
      2,
      new Set<string>(['minimax.key1.MiniMax-M3'])
    );

    expect(retryAttempt.excludedProviderKeys).toEqual(['minimax.key1.MiniMax-M3']);
    expect((retryAttempt.__rt as { preselectedRoute?: unknown }).preselectedRoute).toBeUndefined();
    expect(MetadataCenter.read(retryAttempt)?.readRuntimeControl().preselectedRoute).toBeUndefined();
    expect(MetadataCenter.read(retryAttempt)?.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(buildMetadataCenterRustSnapshot(retryAttempt).runtimeControl?.preselectedRoute).toBeUndefined();
    expect(buildMetadataCenterRustSnapshot(retryAttempt).runtimeControl?.providerProtocol).toBe('openai-responses');
    expect((baseMetadata.__rt as { preselectedRoute?: unknown }).preselectedRoute).toBe(preselectedRoute);
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

    expect(metadata.routeHint).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRuntimeControl().routeHint).toBeUndefined();
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

    expect(metadata.routeHint).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRuntimeControl().routeHint).toBe('tools');
  });

  it('uses servertool web_search CLI result routeHint from submitted tool output', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      method: 'POST',
      requestId: 'req-route-hint-web-search-cli',
      headers: {},
      query: {},
      body: {
        tool_outputs: [{
          call_id: 'call_web_search_1',
          output: JSON.stringify({
            toolName: 'web_search',
            flowId: 'web_search_flow',
            routeHint: 'web_search'
          })
        }]
      },
      metadata: {}
    } as any);

    expect(metadata.routeHint).toBeUndefined();
    expect(MetadataCenter.read(metadata)?.readRuntimeControl().routeHint).toBe('web_search');
  });

  it('uses servertool vision CLI result routeHint from responses input output item', () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-route-hint-vision-cli',
      headers: {},
      query: {},
      body: {
        input: [{
          type: 'function_call_output',
          call_id: 'call_vision_1',
          output: JSON.stringify({
            toolName: 'vision_auto',
            flowId: 'vision_flow',
            routeHint: 'multimodal'
          })
        }]
      },
      metadata: {}
    } as any);

    expect(metadata.routeHint).toBe('multimodal');
    expect(MetadataCenter.read(metadata)?.readRuntimeControl().routeHint).toBe('multimodal');
  });
});
