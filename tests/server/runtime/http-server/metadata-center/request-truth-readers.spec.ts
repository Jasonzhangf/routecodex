import { describe, expect, it } from '@jest/globals';

import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  readRuntimeControlProjection,
  readRuntimeDebugSnapshotProjection,
  readRuntimeProviderObservationProjection,
  readRuntimeRequestTruthIdentifiers,
  readRuntimeServerToolProjection,
} from '../../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.js';

describe('request-truth-readers', () => {
  it('prefers MetadataCenter request truth over flat metadata fields', () => {
    const metadata: Record<string, unknown> = {
      sessionId: 'flat-session',
      conversationId: 'flat-conversation'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'center-session',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'request-truth-readers',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'center-conversation',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'request-truth-readers',
        stage: 'test'
      }
    );

    expect(readRuntimeRequestTruthIdentifiers(metadata)).toEqual({
      sessionId: 'center-session',
      conversationId: 'center-conversation'
    });
  });

  it('does not synthesize request session truth from tmux-only metadata', () => {
    expect(readRuntimeRequestTruthIdentifiers({
      clientTmuxSessionId: 'tmux-only',
      tmuxSessionId: 'tmux-only-fallback'
    })).toEqual({});
  });

  it('does not fall back to flat metadata session fields without metadata center request truth', () => {
    expect(readRuntimeRequestTruthIdentifiers({
      sessionId: 'flat-session',
      session_id: 'flat-session-legacy',
      conversationId: 'flat-conversation',
      conversation_id: 'flat-conversation-legacy'
    })).toEqual({});
  });

  it('keeps debug snapshot slots out of request truth and releases them with the center', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeDebugSnapshot(
      'traceMarkers',
      ['debug-only'],
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'keeps debug snapshot slots out of request truth and releases them with the center',
        stage: 'test'
      }
    );

    expect(readRuntimeRequestTruthIdentifiers(metadata)).toEqual({});
    expect(center.readDebugSnapshot()).toEqual({
      traceMarkers: ['debug-only']
    });
    expect(readRuntimeDebugSnapshotProjection(metadata)).toEqual({
      traceMarkers: ['debug-only']
    });

    center.markReleased(
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'keeps debug snapshot slots out of request truth and releases them with the center',
        stage: 'test'
      },
      'test-release'
    );

    expect(center.snapshot().debugSnapshot.traceMarkers?.status).toBe('released');
  });

  it('reads normalized hubStageTop from MetadataCenter debug snapshot', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeDebugSnapshot(
      'hubStageTop',
      [
        { stage: 'resp_inbound.stage1_codec_decode', totalMs: 118.6, count: 1, avgMs: 118.6, maxMs: 118.6 },
        { stage: 'resp_outbound.stage2_client_projection', totalMs: 19.2 },
        { stage: ' ', totalMs: 30 },
      ],
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized hubStageTop from MetadataCenter debug snapshot',
        stage: 'test'
      }
    );

    expect(readRuntimeDebugSnapshotProjection(metadata)).toEqual({
      hubStageTop: [
        {
          stage: 'resp_inbound.stage1_codec_decode',
          totalMs: 119,
          count: 1,
          avgMs: 119,
          maxMs: 119
        },
        {
          stage: 'resp_outbound.stage2_client_projection',
          totalMs: 19
        }
      ]
    });
  });

  it('reads normalized provider observation fields from MetadataCenter', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeProviderObservation(
      'target',
      {
        modelId: 'gpt-5.4-target',
        compatibilityProfile: 'responses'
      },
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized provider observation fields from MetadataCenter',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'assignedModelId',
      'gpt-5.4-assigned',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized provider observation fields from MetadataCenter',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'clientModelId',
      'gpt-5.4-client',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized provider observation fields from MetadataCenter',
        stage: 'test'
      }
    );

    expect(readRuntimeProviderObservationProjection(metadata)).toEqual({
      target: {
        modelId: 'gpt-5.4-target',
        compatibilityProfile: 'responses'
      },
      assignedModelId: 'gpt-5.4-assigned',
      clientModelId: 'gpt-5.4-client',
    });
  });

  it('reads normalized runtime control fields from MetadataCenter', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'routeHint',
      ' tools ',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized runtime control fields from MetadataCenter',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'retryProviderKey',
      ' provider.key.model ',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized runtime control fields from MetadataCenter',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'preselectedRoute',
      {
        routeName: 'tools',
        providerKey: 'provider.key.model'
      },
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized runtime control fields from MetadataCenter',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'stopMessageExcludeDirect',
      false,
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads normalized runtime control fields from MetadataCenter',
        stage: 'test'
      }
    );

    expect(readRuntimeControlProjection(metadata)).toEqual({
      routeHint: 'tools',
      retryProviderKey: 'provider.key.model',
      preselectedRoute: {
        routeName: 'tools',
        providerKey: 'provider.key.model'
      },
      stopMessageExcludeDirect: false,
    });
  });

  it('does not project dead servertoolResponseOrchestration runtime control residue', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    (center.writeRuntimeControl as (
      key: string,
      value: unknown,
      writtenBy: { module: string; symbol: string; stage: string },
      reason?: string
    ) => void)(
      'servertoolResponseOrchestration',
      true,
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'does not project dead servertoolResponseOrchestration runtime control residue',
        stage: 'test'
      },
      'legacy dead slot injection'
    );

    expect(center.readRuntimeControl()).toEqual({});
    expect(readRuntimeControlProjection(metadata)).toEqual({});
  });

  it('reads stopless runtime control from MetadataCenter only', () => {
    const metadata: Record<string, unknown> = {
      stopless: {
        repeatCount: 99,
        maxRepeats: 1
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'stopless',
      {
        sessionId: 'sess-1',
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        continuationPrompt: '继续执行',
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason']
        },
        active: true,
        updatedAt: 123
      },
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'reads stopless runtime control from MetadataCenter only',
        stage: 'test'
      }
    );

    expect(readRuntimeControlProjection(metadata)).toEqual({
      stopless: {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        continuationPrompt: '继续执行',
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason']
        },
        active: true,
        updatedAt: 123
      }
    });
  });

  it('builds servertool projection from request truth and provider observation', () => {
    const metadata: Record<string, unknown> = {
      modelId: 'flat-model-should-not-win'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'center-session',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'builds servertool projection from request truth and provider observation',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'center-conversation',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'builds servertool projection from request truth and provider observation',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'target',
      {
        modelId: 'gpt-5.4-target',
        compatibilityProfile: 'responses'
      },
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'builds servertool projection from request truth and provider observation',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'assignedModelId',
      'gpt-5.4-assigned',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'builds servertool projection from request truth and provider observation',
        stage: 'test'
      }
    );

    expect(readRuntimeServerToolProjection(metadata)).toEqual({
      sessionId: 'center-session',
      conversationId: 'center-conversation',
      assignedModelId: 'gpt-5.4-assigned',
      compatibilityProfile: 'responses'
    });
  });
});
