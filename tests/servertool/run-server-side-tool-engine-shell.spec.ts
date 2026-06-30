import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runServertoolEntryPreflight = jest.fn();
const extractToolCallsFromResponseStage = jest.fn();
const resolveServertoolEntryContext = jest.fn();
const runServertoolResponseStagePrePass = jest.fn();
const runServertoolExecutionStage = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.js',
  () => ({
    runServertoolEntryPreflight
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.js',
  () => ({
    extractToolCallsFromResponseStage
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/entry-context-shell.js',
  () => ({
    resolveServertoolEntryContext
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.js',
  () => ({
    runServertoolResponseStagePrePass
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.js',
  () => ({
    runServertoolExecutionStage
  })
);

const { orchestrateServertoolEngine } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js'
);

describe('run-server-side-tool-engine-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('owns the full engine orchestration chain as a dedicated shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('runServertoolEntryPreflight');
    expect(source).toContain('extractToolCallsFromResponseStage');
    expect(source).toContain('resolveServertoolEntryContext');
    expect(source).toContain('runServertoolResponseStagePrePass');
    expect(source).toContain('runServertoolExecutionStage');
    expect(source).not.toContain('const base =');
    expect(source).not.toContain("typeof options.chatResponse === 'object'");
  });

  test('returns preflight early result when preflight short-circuits', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: { ok: 'short' } }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-preflight',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { ok: 'short' } });
    expect(extractToolCallsFromResponseStage).not.toHaveBeenCalled();
  });

  test('returns passthrough when entry context rejects non-object base', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true }
    });
    extractToolCallsFromResponseStage.mockReturnValue([]);
    resolveServertoolEntryContext.mockReturnValue({ action: 'return_non_object_base' });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-non-object',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({
      mode: 'passthrough',
      finalChatResponse: { ok: true }
    });
    expect(runServertoolResponseStagePrePass).not.toHaveBeenCalled();
  });

  test('forwards pre-pass early result without entering execution stage', async () => {
    runServertoolEntryPreflight.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true }
    });
    extractToolCallsFromResponseStage.mockReturnValue([{ id: 'call_1', name: 'web_search' }]);
    resolveServertoolEntryContext.mockReturnValue({
      action: 'continue',
      baseObject: { ok: true },
      contextBase: { base: { ok: true }, toolCalls: [], adapterContext: {}, requestId: 'req-pass', entryEndpoint: 'openai', providerProtocol: 'openai-chat' },
      includeToolCallNames: null,
      excludeToolCallNames: null,
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });
    runServertoolResponseStagePrePass.mockResolvedValue({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: { early: true } }
    });

    await expect(
      orchestrateServertoolEngine({
        chatResponse: { ok: true },
        adapterContext: {},
        entryEndpoint: '/v1/responses',
        requestId: 'req-pass',
        providerProtocol: 'openai-responses'
      } as any)
    ).resolves.toEqual({ mode: 'passthrough', finalChatResponse: { early: true } });
    expect(runServertoolExecutionStage).not.toHaveBeenCalled();
  });
});
