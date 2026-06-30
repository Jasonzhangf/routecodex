import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const buildClientExecCliProjectionOutputWithNative = jest.fn();
const buildClientVisibleProjectionShellWithNative = jest.fn();
const buildServertoolCliProjectionExecutionContextWithNative = jest.fn();
const buildServertoolCliProjectionRuntimeBranchWithNative = jest.fn();
const parseServertoolCliProjectionToolArgumentsWithNative = jest.fn();
const collectServertoolAdditionalClientToolCallsWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    buildClientExecCliProjectionOutputWithNative,
    buildClientVisibleProjectionShellWithNative,
    buildServertoolCliProjectionExecutionContextWithNative,
    buildServertoolCliProjectionRuntimeBranchWithNative,
    parseServertoolCliProjectionToolArgumentsWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    collectServertoolAdditionalClientToolCallsWithNative
  })
);

const {
  buildServertoolCliProjectionBranchResult
} = await import('../../sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.js');

describe('cli-projection-runtime-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildClientExecCliProjectionOutputWithNative.mockReturnValue({
      toolName: 'web_search',
      flowId: 'servertool_cli_projection',
      execCommand: "routecodex hook run web_search --input-json '{}'"
    });
    buildServertoolCliProjectionRuntimeBranchWithNative.mockReturnValue({
      chatResponse: { ok: true },
      execution: { flowId: 'servertool_cli_projection' }
    });
    parseServertoolCliProjectionToolArgumentsWithNative.mockReturnValue({});
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
    expect(buildClientExecCliProjectionOutputWithNative).not.toHaveBeenCalled();
    expect(parseServertoolCliProjectionToolArgumentsWithNative).not.toHaveBeenCalled();
    expect(buildClientVisibleProjectionShellWithNative).not.toHaveBeenCalled();
    expect(buildServertoolCliProjectionExecutionContextWithNative).not.toHaveBeenCalled();
    expect(buildServertoolCliProjectionRuntimeBranchWithNative).toHaveBeenCalledWith({
      requestId: 'req-1',
      toolName: 'web_search',
      toolArguments: '{}',
      additionalToolCalls: [
        { id: 'call_other', type: 'function', function: { name: 'exec_command', arguments: '{}' } }
      ]
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

  test('cli projection shell does not own tool argument parsing', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts', 'utf8')
    );

    expect(source).not.toContain('function parseToolArguments(');
    expect(source).not.toContain('JSON.parse(value)');
    expect(source).not.toContain('randomUUID');
    expect(source).not.toContain('parseServertoolCliProjectionToolArgumentsWithNative');
    expect(source).not.toContain('buildClientExecCliProjectionOutputWithNative');
    expect(source).not.toContain('buildClientVisibleProjectionShellWithNative');
    expect(source).not.toContain('buildServertoolCliProjectionExecutionContextWithNative');
    expect(source).not.toContain('servertool_cli_projection');
    expect(source).not.toContain('reasoningText');
    expect(source).not.toContain('继续执行本地 hook');
    expect(source).toContain('buildServertoolCliProjectionRuntimeBranchWithNative({');
    expect(source).toContain('const additionalToolCalls = collectServertoolAdditionalClientToolCallsWithNative({');
    expect(source).not.toContain('function buildClientVisibleProjectionShellForRuntime(');
    expect(source).not.toContain('const nativeProjection = buildClientExecCliProjectionOutputWithNative({');
    expect(source).not.toContain('const chatResponse = buildClientVisibleProjectionShellWithNative({');
    expect(source).not.toContain('const execution = buildServertoolCliProjectionExecutionContextWithNative({');
    expect(source).toContain('finalChatResponse: branch.chatResponse as JsonObject');
    expect(source).toContain('execution: branch.execution as {');
    expect(source).not.toContain('const projectionShellInput = {');
    expect(source).not.toContain('buildClientVisibleProjectionShellWithNative(projectionShellInput)');
    expect(source).not.toContain('export function isClientExecCliProjectionToolCall(');
    expect(source).not.toContain('export const collectAdditionalClientToolCalls');
  });
});
