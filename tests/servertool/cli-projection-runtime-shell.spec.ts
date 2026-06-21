import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildServertoolCliProjectionForToolCall = jest.fn();
const buildServertoolCliProjectionExecutionContextWithNative = jest.fn();
const isServertoolClientExecCliProjectionToolCallWithNative = jest.fn();
const collectServertoolAdditionalClientToolCallsWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js',
  () => ({
    buildServertoolCliProjectionForToolCall
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    buildServertoolCliProjectionExecutionContextWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    collectServertoolAdditionalClientToolCallsWithNative,
    isServertoolClientExecCliProjectionToolCallWithNative
  })
);

const {
  buildServertoolCliProjectionBranchResult,
  collectAdditionalClientToolCalls,
  isClientExecCliProjectionToolCall
} = await import('../../sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.js');

describe('cli-projection-runtime-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildServertoolCliProjectionForToolCall.mockReturnValue({
      clientCallId: 'call_exec_1',
      toolName: 'web_search',
      chatResponse: { ok: true }
    });
    buildServertoolCliProjectionExecutionContextWithNative.mockReturnValue({
      flowId: 'servertool_cli_projection'
    });
    isServertoolClientExecCliProjectionToolCallWithNative.mockImplementation((input: any) => ({
      executionMode: input?.executionMode
    }?.executionMode === 'client_exec_cli_projection'));
    collectServertoolAdditionalClientToolCallsWithNative.mockReturnValue([
      { id: 'call_other', type: 'function', function: { name: 'exec_command', arguments: '{}' } }
    ]);
  });

  test('builds cli projection branch result from projected tool index', () => {
    const result = buildServertoolCliProjectionBranchResult({
      options: { requestId: 'req-1' } as any,
      base: { choices: [] } as any,
      executableToolCalls: [
        {
          id: 'call_projected',
          name: 'web_search',
          arguments: '{}',
          executionMode: 'client_exec_cli_projection'
        } as any
      ],
      projectedToolCallIndex: 0
    });

    expect(collectServertoolAdditionalClientToolCallsWithNative).toHaveBeenCalledWith({
      base: { choices: [] },
      projectedToolCallId: 'call_projected'
    });
    expect(buildServertoolCliProjectionForToolCall).toHaveBeenCalledWith({
      options: { requestId: 'req-1' },
      toolCall: {
        id: 'call_projected',
        name: 'web_search',
        arguments: '{}',
        executionMode: 'client_exec_cli_projection'
      },
      additionalToolCalls: [
        { id: 'call_other', type: 'function', function: { name: 'exec_command', arguments: '{}' } }
      ],
      reasoningText: '继续执行本地 hook web_search。'
    });
    expect(result).toEqual({
      mode: 'tool_flow',
      finalChatResponse: { ok: true },
      execution: { flowId: 'servertool_cli_projection' }
    });
  });

  test('throws when native branch plan points to missing tool call index', () => {
    expect(() =>
      buildServertoolCliProjectionBranchResult({
        options: { requestId: 'req-2' } as any,
        base: {} as any,
        executableToolCalls: [],
        projectedToolCallIndex: 3
      })
    ).toThrow('[servertool] native execution-branch projected missing tool call index: 3');
  });

  test('keeps cli projection execution-mode check in native helper', () => {
    expect(
      isClientExecCliProjectionToolCall({
        id: 'call_1',
        name: 'tool',
        arguments: '{}',
        executionMode: 'client_exec_cli_projection'
      } as any)
    ).toBe(true);
    expect(isServertoolClientExecCliProjectionToolCallWithNative).toHaveBeenCalledWith({
      executionMode: 'client_exec_cli_projection'
    });
  });

  test('collects additional client tool calls through native helper', () => {
    expect(collectAdditionalClientToolCalls({ choices: [] } as any, 'call_projected')).toEqual([
      { id: 'call_other', type: 'function', function: { name: 'exec_command', arguments: '{}' } }
    ]);
  });
});
