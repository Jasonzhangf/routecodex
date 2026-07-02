import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolEntryPreflightWithNativeMock = jest.fn();
const isAdapterClientDisconnectedWithNativeMock = jest.fn(() => false);
const readServertoolEntryBaseObjectWithNativeMock = jest.fn((chatResponse: unknown) =>
  chatResponse != null && typeof chatResponse === 'object' && !Array.isArray(chatResponse)
    ? chatResponse
    : null
);
const planServertoolClientDisconnectedErrorWithNativeMock = jest.fn((input: any) => ({
  message: `[servertool] client disconnected: ${String(input?.requestId ?? '')}`,
  code: 'SERVERTOOL_CLIENT_DISCONNECTED',
  category: 'client_disconnect',
  status: 499,
  details: input
}));
const createServertoolProviderProtocolErrorFromPlanMock = jest.fn((plan: any) => {
  const err = new Error(String(plan?.message ?? 'servertool error'));
  (err as Error & { code?: string }).code = String(plan?.code ?? 'SERVERTOOL_CLIENT_DISCONNECTED');
  return err;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    isAdapterClientDisconnectedWithNative: isAdapterClientDisconnectedWithNativeMock,
    planServertoolEntryPreflightWithNative: planServertoolEntryPreflightWithNativeMock,
    readServertoolEntryBaseObjectWithNative: readServertoolEntryBaseObjectWithNativeMock,
    planServertoolClientDisconnectedErrorWithNative: planServertoolClientDisconnectedErrorWithNativeMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan: createServertoolProviderProtocolErrorFromPlanMock
  })
);

const { runServertoolEntryPreflight } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.js'
);

describe('entry-preflight-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolEntryPreflightWithNativeMock.mockReturnValue({
      action: 'continue_to_tool_flow'
    });
  });

  test('keeps entry preflight planning and early-return projection in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('planServertoolEntryPreflightWithNative');
    expect(source).toContain('isAdapterClientDisconnectedWithNative(args.options.adapterContext)');
    expect(source).toContain('readServertoolEntryBaseObjectWithNative(args.options.chatResponse)');
    expect(source).toContain('planServertoolClientDisconnectedErrorWithNative');
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan');
    expect(source).not.toContain('Boolean(base)');
    expect(source).not.toContain("args.options.chatResponse && typeof args.options.chatResponse === 'object'");
    expect(source).not.toContain("args.options.chatResponse != null && typeof args.options.chatResponse === 'object'");
    expect(source).not.toContain('args.options.chatResponse as JsonObject');
    expect(source).not.toContain('base as JsonObject');
    expect(source).toContain('hasBaseObject: base != null');
    expect(source).not.toContain("if (entryPreflightPlan.action === 'return_passthrough_non_object_chat')");
    expect(source).not.toContain("if (entryPreflightPlan.action === 'throw_client_disconnected')");
    expect(source).toContain('switch (entryPreflightPlan.action)');
    expect(source).not.toContain('entryPreflightPlan as { action: unknown }');
    expect(source).toContain('result: { mode: entryPreflightPlan.resultMode, finalChatResponse: args.options.chatResponse }');
    expect(source).not.toContain("result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }");
    expect(source).not.toContain('const passthroughResult =');
  });

  test('returns passthrough result when native preflight says non-object chat', () => {
    planServertoolEntryPreflightWithNativeMock.mockReturnValue({
      action: 'return_passthrough_non_object_chat',
      resultMode: 'passthrough'
    });

    const result = runServertoolEntryPreflight({
      options: {
        requestId: 'req-1',
        chatResponse: 'raw-chat'
      } as any
    });

    expect(result).toEqual({
      action: 'return_result',
      result: { mode: 'passthrough', finalChatResponse: 'raw-chat' }
    });
  });

  test('throws client disconnected error when native preflight says so', () => {
    planServertoolEntryPreflightWithNativeMock.mockReturnValue({
      action: 'throw_client_disconnected'
    });

    expect(() =>
      runServertoolEntryPreflight({
        options: {
          requestId: 'req-2',
          adapterContext: {},
          chatResponse: {}
        } as any
      })
    ).toThrow('[servertool] client disconnected: req-2');
  });

  test('fails fast for unknown native entry preflight action', () => {
    planServertoolEntryPreflightWithNativeMock.mockReturnValue({
      action: 'unknown_entry_preflight_action'
    });

    expect(() =>
      runServertoolEntryPreflight({
        options: {
          requestId: 'req-unknown-entry-preflight',
          adapterContext: {},
          chatResponse: {}
        } as any
      })
    ).toThrow('[servertool] invalid entry preflight action');
  });
});
