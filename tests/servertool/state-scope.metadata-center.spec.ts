import fs from 'node:fs';

import { beforeAll, describe, expect, jest, test } from '@jest/globals';

import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const resolveStopMessageSessionScopeWithNativeMock = jest.fn((metadata: Record<string, unknown>) => {
  const snapshot = metadata.metadataCenterSnapshot as { requestTruth?: Record<string, unknown> } | undefined;
  const sessionId = snapshot?.requestTruth?.sessionId;
  return typeof sessionId === 'string' ? `session:${sessionId}` : undefined;
});

const resolveServertoolStickyKeyWithNativeMock = jest.fn((metadata: Record<string, unknown>) => {
  const snapshot = metadata.metadataCenterSnapshot as { requestTruth?: Record<string, unknown> } | undefined;
  const requestId = snapshot?.requestTruth?.requestId;
  return typeof requestId === 'string' ? requestId : undefined;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    resolveStopMessageSessionScopeWithNative: resolveStopMessageSessionScopeWithNativeMock,
    resolveServertoolStickyKeyWithNative: resolveServertoolStickyKeyWithNativeMock
  })
);

let resolveServertoolPersistentScopeKey: typeof import(
  '../../sharedmodule/llmswitch-core/src/servertool/state-scope.js'
).resolveServertoolPersistentScopeKey;
let resolveServertoolLoopScopeKey: typeof import(
  '../../sharedmodule/llmswitch-core/src/servertool/state-scope.js'
).resolveServertoolLoopScopeKey;

function bindMetadataCenter(): Record<string, unknown> {
  const adapterContext: Record<string, unknown> = {
    metadata: {
      sessionId: 'legacy-metadata-session',
      requestId: 'legacy-metadata-request'
    },
    sessionId: 'legacy-flat-session',
    requestId: 'legacy-flat-request'
  };
  const center = MetadataCenter.attach(adapterContext);
  center.writeRequestTruth(
    'sessionId',
    'snapshot-session',
    {
      module: 'tests/servertool/state-scope.metadata-center.spec.ts',
      symbol: 'bindMetadataCenter',
      stage: 'test'
    }
  );
  center.writeRequestTruth(
    'requestId',
    'snapshot-request',
    {
      module: 'tests/servertool/state-scope.metadata-center.spec.ts',
      symbol: 'bindMetadataCenter',
      stage: 'test'
    }
  );
  return adapterContext;
}

describe('state-scope MetadataCenter owner', () => {
  beforeAll(async () => {
    ({ resolveServertoolPersistentScopeKey, resolveServertoolLoopScopeKey } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/state-scope.js'
    ));
  });

  test('passes only MetadataCenter snapshot to native scope resolvers', () => {
    const adapterContext = bindMetadataCenter();

    expect(resolveServertoolPersistentScopeKey(adapterContext)).toBe('session:snapshot-session');
    expect(resolveServertoolLoopScopeKey(adapterContext)).toBe('snapshot-request');

    expect(resolveStopMessageSessionScopeWithNativeMock).toHaveBeenCalledWith({
      metadataCenterSnapshot: {
        requestTruth: {
          requestId: 'snapshot-request',
          sessionId: 'snapshot-session'
        },
        runtimeControl: {}
      }
    });
    expect(resolveServertoolStickyKeyWithNativeMock).toHaveBeenCalledWith({
      metadataCenterSnapshot: {
        requestTruth: {
          requestId: 'snapshot-request',
          sessionId: 'snapshot-session'
        },
        runtimeControl: {}
      }
    });
  });

  test('source does not read runtime metadata or legacy flat scope fields', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/state-scope.ts',
      'utf8'
    );

    expect(source).not.toContain("from '../conversion/runtime-metadata.js'");
    expect(source).not.toContain('readRuntimeMetadata(');
    expect(source).not.toContain('stopMessageClientInjectSessionScope');
    expect(source).not.toContain('stopMessageClientInjectScope');
    expect(source).toContain('readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter');
  });
});
