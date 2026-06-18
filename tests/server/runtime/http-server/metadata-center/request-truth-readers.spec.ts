import { describe, expect, it } from '@jest/globals';

import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  readRuntimeControlProjection,
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

  it('keeps client attachment scope separate from request truth', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeClientAttachmentScope(
      'tmuxSessionId',
      'tmux-only',
      {
        module: 'tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts',
        symbol: 'keeps client attachment scope separate from request truth',
        stage: 'test'
      }
    );

    expect(readRuntimeRequestTruthIdentifiers(metadata)).toEqual({});
    expect(center.readClientAttachmentScope()).toEqual({
      tmuxSessionId: 'tmux-only'
    });
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
      'serverToolFollowup',
      true,
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
      serverToolFollowup: true,
      stopMessageExcludeDirect: false,
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
