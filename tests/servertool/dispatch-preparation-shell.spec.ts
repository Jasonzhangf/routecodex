import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindProviderProtocol(adapterContext: Record<string, unknown>, providerProtocol = 'openai-responses'): void {
  const center = MetadataCenter.attach(adapterContext);
  if (!center.readRuntimeControl().providerProtocol) {
    center.writeRuntimeControl(
      'providerProtocol',
      providerProtocol,
      {
        module: 'tests/servertool/dispatch-preparation-shell.spec.ts',
        symbol: 'bindProviderProtocol',
        stage: 'test'
      }
    );
  }
}

const buildServertoolDispatchPlanInputMock = jest.fn((input: any) => input);
const planServertoolToolCallDispatchWithNativeMock = jest.fn((input: any) => ({
  executableToolCalls: Array.isArray(input?.toolCalls) ? input.toolCalls : [],
  skippedToolCalls: [],
  noopToolCalls: []
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    buildServertoolDispatchPlanInputWithNative: buildServertoolDispatchPlanInputMock,
    planServertoolToolCallDispatchWithNative: planServertoolToolCallDispatchWithNativeMock
  })
);

const { prepareServertoolDispatchStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.js'
);

describe('dispatch-preparation-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps MetadataCenter snapshot and dispatch plan in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain("from '../conversion/runtime-metadata.js'");
    expect(source).not.toContain('readRuntimeMetadata(');
    expect(source).toContain('readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter');
    expect(source).not.toContain('resolveServertoolRuntimePreCommandState');
    expect(source).not.toContain('applyPreCommandHooksToToolCalls');
    expect(source).toContain('planServertoolToolCallDispatchWithNative');
    expect(source).toContain('buildServertoolDispatchPlanInputWithNative({');
    expect(source).not.toContain('const dispatchPlanInput =');
  });

  test('builds dispatch plan without pre-command mutation', () => {
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-responses');
    const toolCalls = [{ id: 'call_1', name: 'web_search', arguments: '{}' }];
    const result = prepareServertoolDispatchStage({
      options: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        adapterContext
      } as any,
      toolCalls,
      includeToolCallNames: null,
      excludeToolCallNames: null
    });

    expect(buildServertoolDispatchPlanInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls,
        runtimeMetadata: {
          metadataCenterSnapshot: {
            requestTruth: {},
            runtimeControl: expect.objectContaining({
              providerProtocol: 'openai-responses'
            })
          }
        }
      })
    );
    expect(result.dispatchPlan.executableToolCalls).toEqual(toolCalls);
  });

  test('does not locally require providerProtocol when MetadataCenter is bound', () => {
    const adapterContext: Record<string, unknown> = {};
    MetadataCenter.attach(adapterContext);
    const result = prepareServertoolDispatchStage({
      options: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        adapterContext
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      includeToolCallNames: null,
      excludeToolCallNames: null
    });

    expect(buildServertoolDispatchPlanInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMetadata: {
          metadataCenterSnapshot: {
            requestTruth: {},
            runtimeControl: {},
            providerObservation: {}
          }
        }
      })
    );
    expect(result.dispatchPlan.executableToolCalls).toEqual([{ id: 'call_1', name: 'web_search', arguments: '{}' }]);
  });
});
