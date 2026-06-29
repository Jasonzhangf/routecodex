import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildClientExecCliProjectionOutputWithNative = jest.fn();
const buildClientVisibleProjectionShellWithNative = jest.fn();
const buildServertoolCliProjectionExecutionContextWithNative = jest.fn();
const parseServertoolCliProjectionToolArgumentsWithNative = jest.fn();
const isServertoolClientExecCliProjectionToolCallWithNative = jest.fn();
const collectServertoolAdditionalClientToolCallsWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    buildClientExecCliProjectionOutputWithNative,
    buildClientVisibleProjectionShellWithNative,
    buildServertoolCliProjectionExecutionContextWithNative,
    parseServertoolCliProjectionToolArgumentsWithNative
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
    buildClientExecCliProjectionOutputWithNative.mockReturnValue({
      toolName: 'web_search',
      flowId: 'servertool_cli_projection',
      execCommand: "routecodex hook run web_search --input-json '{}'"
    });
    buildClientVisibleProjectionShellWithNative.mockReturnValue({
      ok: true
    });
    buildServertoolCliProjectionExecutionContextWithNative.mockReturnValue({
      flowId: 'servertool_cli_projection'
    });
    parseServertoolCliProjectionToolArgumentsWithNative.mockReturnValue({});
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
    expect(buildClientExecCliProjectionOutputWithNative).toHaveBeenCalledWith({
      toolName: 'web_search',
      flowId: 'servertool_cli_projection',
      input: {},
      repeatCount: 0,
      maxRepeats: 0
    });
    expect(parseServertoolCliProjectionToolArgumentsWithNative).toHaveBeenCalledWith({
      arguments: '{}'
    });
    expect(buildClientVisibleProjectionShellWithNative).toHaveBeenCalledWith({
      requestId: 'req-1',
      clientCallId: expect.stringMatching(/^call_servertool_cli_[a-f0-9]+$/),
      nativeProjection: {
        toolName: 'web_search',
        flowId: 'servertool_cli_projection',
        execCommand: "routecodex hook run web_search --input-json '{}'"
      },
      reasoningText: '继续执行本地 hook web_search。',
      additionalToolCalls: [
        { id: 'call_other', type: 'function', function: { name: 'exec_command', arguments: '{}' } }
      ]
    });
    expect(buildServertoolCliProjectionExecutionContextWithNative).toHaveBeenCalledWith({
      requestId: 'req-1',
      clientCallId: expect.stringMatching(/^call_servertool_cli_[a-f0-9]+$/),
      toolName: 'web_search'
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

  test('cli projection shell does not own tool argument parsing', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function parseToolArguments(');
    expect(source).not.toContain('JSON.parse(value)');
    expect(source).toContain('parseServertoolCliProjectionToolArgumentsWithNative(');
  });
});
