import {
  jest
} from '@jest/globals';

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js', () => ({
  buildClientExecCliProjectionOutputWithNative: (input: any) => {
    if (input.toolName === 'stop_message_auto') {
      return {
        toolName: 'stop_message_auto',
        flowId: 'stop_message_flow',
        execCommand: "routecodex servertool run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续执行原任务\",\"repeatCount\":2,\"maxRepeats\":3}'",
        continuationPrompt: '继续执行原任务',
        repeatCount: 2,
        maxRepeats: 3,
        schemaGuidance: { requiredFields: ['stopreason'] },
      };
    }
    return {
      toolName: input.toolName,
      flowId: input.flowId,
      execCommand: `routecodex servertool run ${input.toolName} --input-json '${JSON.stringify(input.input)}'`,
    };
  },
  buildClientVisibleProjectionShellWithNative: (input: any) => ({
    id: `chatcmpl_${input.clientCallId}`,
    object: 'chat.completion',
    created: 0,
    model: 'routecodex-servertool-cli',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_text: input.reasoningText,
          reasoning_content: input.reasoningText,
          reasoning: {
            summary: [{ type: 'summary_text', text: input.reasoningText }]
          },
          tool_calls: [
            {
              id: input.clientCallId,
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: input.nativeProjection.execCommand })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    __servertool_cli_projection: {
      clientCallId: input.clientCallId,
      toolName: input.nativeProjection.toolName,
      requestId: input.requestId
    }
  }),
}));

const {
  buildServertoolCliProjectionForAutoFlow,
  buildServertoolCliProjectionForToolCall
} = await import('../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js');

describe('servertool CLI projection', () => {
  it('projects stopless auto flow to exec_command with reasoning and direct CLI input', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: { sessionId: 'sess-1' } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_stop_1',
        providerProtocol: 'openai-responses'
      },
      flowId: 'stop_message_flow',
      reasoningText: 'full stop summary',
      stdoutPreview: 'continue',
      input: {
        continuationPrompt: '继续执行原任务',
        repeatCount: 2,
        maxRepeats: 3
      }
    });

    const message = (projection.chatResponse as any).choices[0].message;
    const command = JSON.parse(message.tool_calls[0].function.arguments).cmd;

    expect(message.reasoning_content).toBe('full stop summary');
    expect(message.reasoning.summary[0].text).toBe('full stop summary');
    expect(message.reasoning.content).toBeUndefined();
    expect(message.tool_calls[0].function.name).toBe('exec_command');
    expect(command).toBe("routecodex servertool run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续执行原任务\",\"repeatCount\":2,\"maxRepeats\":3}'");
    expect(command).not.toContain(['--', 'tic', 'ket'].join(''));
    expect(command).not.toContain(['st', 'cli_'].join(''));
    expect(command).not.toContain(['rcc', '_cli_'].join(''));
    expect((projection as any)[['tick', 'et'].join('')]).toBeUndefined();
  });

  it('projects basic servertool tool call without executing handler or restoring model identity', () => {
    const projection = buildServertoolCliProjectionForToolCall({
      options: {
        chatResponse: {},
        adapterContext: {} as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_tool_1',
        providerProtocol: 'openai-responses'
      },
      toolCall: {
        id: 'call_model_1',
        name: 'servertool_fixture',
        arguments: '{"value":1}'
      }
    });

    const toolCall = (projection.chatResponse as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;

    expect(toolCall.function.name).toBe('exec_command');
    expect(command).toBe("routecodex servertool run servertool_fixture --input-json '{\"value\":1}'");
    expect(projection.toolName).toBe('servertool_fixture');
    expect((projection.chatResponse as any).__servertool_cli_projection).toMatchObject({
      toolName: 'servertool_fixture',
      requestId: 'req_tool_1'
    });
    expect((projection as any)[['tick', 'et'].join('')]).toBeUndefined();
  });
});
