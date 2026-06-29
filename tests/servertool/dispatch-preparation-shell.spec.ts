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

const resolveServertoolRuntimePreCommandStateMock = jest.fn(() => undefined);
const applyPreCommandHooksToToolCallsMock = jest.fn(() => {});
const buildServertoolDispatchPlanInputMock = jest.fn((input: any) => input);
const planServertoolToolCallDispatchWithNativeMock = jest.fn((input: any) => ({
  executableToolCalls: Array.isArray(input?.toolCalls) ? input.toolCalls : [],
  skippedToolCalls: [],
  noopToolCalls: []
}));
const patchToolCallArgumentsByIdMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.js',
  () => ({
    resolveServertoolRuntimePreCommandState: resolveServertoolRuntimePreCommandStateMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.js',
  () => ({
    applyPreCommandHooksToToolCalls: applyPreCommandHooksToToolCallsMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js',
  () => ({
    buildServertoolDispatchPlanInput: buildServertoolDispatchPlanInputMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolToolCallDispatchWithNative: planServertoolToolCallDispatchWithNativeMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js',
  () => ({
    patchToolCallArgumentsById: patchToolCallArgumentsByIdMock
  })
);

const { prepareServertoolDispatchStage } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.js'
);

describe('dispatch-preparation-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveServertoolRuntimePreCommandStateMock.mockReturnValue({ tag: 'resolved' });
  });

  test('keeps runtime metadata, pre-command hooks and dispatch plan in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.ts',
        'utf8'
      )
    );

    expect(source).not.toContain("from '../conversion/runtime-metadata.js'");
    expect(source).not.toContain('readRuntimeMetadata(');
    expect(source).toContain('readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter');
    expect(source).toContain('resolveServertoolRuntimePreCommandState');
    expect(source).toContain('applyPreCommandHooksToToolCalls');
    expect(source).toContain('planServertoolToolCallDispatchWithNative');
  });

  test('builds dispatch plan after pre-command application', () => {
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-responses');
    const toolCalls = [{ id: 'call_1', name: 'web_search', arguments: '{}' }];
    const result = prepareServertoolDispatchStage({
      options: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        adapterContext
      } as any,
      toolCalls,
      baseObject: { choices: [] } as any,
      baseForExecution: { choices: [] } as any,
      includeToolCallNames: null,
      excludeToolCallNames: null
    });

    expect(resolveServertoolRuntimePreCommandStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      })
    );
    expect(applyPreCommandHooksToToolCallsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls
      })
    );
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

  test('fails fast when metadata center runtimeControl.providerProtocol is absent', () => {
    expect(() => prepareServertoolDispatchStage({
      options: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        adapterContext: {}
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      baseObject: { choices: [] } as any,
      baseForExecution: { choices: [] } as any,
      includeToolCallNames: null,
      excludeToolCallNames: null
    })).toThrow('Servertool dispatch preparation requires metadata center runtime_control.providerProtocol');
  });

  test('prefers bound metadata center providerProtocol when resolving pre-command runtime state', () => {
    const adapterContext: Record<string, unknown> = {};
    const center = MetadataCenter.attach(adapterContext);
    center.writeRuntimeControl(
      'providerProtocol',
      'anthropic-messages',
      {
        module: 'tests/servertool/dispatch-preparation-shell.spec.ts',
        symbol: 'prefers bound metadata center providerProtocol when resolving pre-command runtime state',
        stage: 'test'
      }
    );

    prepareServertoolDispatchStage({
      options: {
        requestId: 'req-center-provider-protocol',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat',
        adapterContext
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      baseObject: { choices: [] } as any,
      baseForExecution: { choices: [] } as any,
      includeToolCallNames: null,
      excludeToolCallNames: null
    });

    expect(resolveServertoolRuntimePreCommandStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerProtocol: 'anthropic-messages'
      })
    );
  });
});
