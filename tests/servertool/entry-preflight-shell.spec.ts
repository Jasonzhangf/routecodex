import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolEntryPreflightWithNativeMock = jest.fn();
const isAdapterClientDisconnectedMock = jest.fn(() => false);
const createServerToolClientDisconnectedErrorMock = jest.fn((input: any) => {
  const err = new Error(`[servertool] client disconnected: ${String(input?.requestId ?? '')}`);
  (err as Error & { code?: string }).code = 'SERVERTOOL_CLIENT_DISCONNECTED';
  return err;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolEntryPreflightWithNative: planServertoolEntryPreflightWithNativeMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    isAdapterClientDisconnected: isAdapterClientDisconnectedMock,
    createServerToolClientDisconnectedError: createServerToolClientDisconnectedErrorMock
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
    expect(source).toContain('createServerToolClientDisconnectedError');
    expect(source).toContain("result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }");
  });

  test('returns passthrough result when native preflight says non-object chat', () => {
    planServertoolEntryPreflightWithNativeMock.mockReturnValue({
      action: 'return_passthrough_non_object_chat'
    });

    const result = runServertoolEntryPreflight({
      options: {
        requestId: 'req-1',
        chatResponse: 'raw-chat'
      } as any,
      base: null
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
          adapterContext: {}
        } as any,
        base: {}
      })
    ).toThrow('[servertool] client disconnected: req-2');
  });
});
