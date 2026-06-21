import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const readRuntimeMetadataMock = jest.fn(() => undefined);
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
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    readRuntimeMetadata: readRuntimeMetadataMock
  })
);

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
  '../../sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.js',
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
    readRuntimeMetadataMock.mockReturnValue({ preCommandState: { tag: 'runtime' } });
    resolveServertoolRuntimePreCommandStateMock.mockReturnValue({ tag: 'resolved' });
  });

  test('keeps runtime metadata, pre-command hooks and dispatch plan in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('readRuntimeMetadata');
    expect(source).toContain('resolveServertoolRuntimePreCommandState');
    expect(source).toContain('applyPreCommandHooksToToolCalls');
    expect(source).toContain('planServertoolToolCallDispatchWithNative');
  });

  test('builds dispatch plan after pre-command application', () => {
    const toolCalls = [{ id: 'call_1', name: 'web_search', arguments: '{}' }];
    const result = prepareServertoolDispatchStage({
      options: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      toolCalls,
      baseObject: { choices: [] } as any,
      baseForExecution: { choices: [] } as any,
      includeToolCallNames: null,
      excludeToolCallNames: null
    });

    expect(readRuntimeMetadataMock).toHaveBeenCalled();
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
        toolCalls
      })
    );
    expect(result.dispatchPlan.executableToolCalls).toEqual(toolCalls);
  });
});
