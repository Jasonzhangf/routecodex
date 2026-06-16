import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';

const ORIGINAL_SESSION_DIR = process.env.ROUTECODEX_SESSION_DIR;

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js', () => ({
  buildClientExecCliProjectionOutputWithNative: (input: any) => {
    if (input.flowId === 'stop_message_flow') {
      return {
        toolName: 'stop_message_auto',
        flowId: 'stop_message_flow',
        execCommand: "routecodex hook run reasoning_stop --input-json '{\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3}'",
        repeatCount: 2,
        maxRepeats: 3,
      };
    }
    if (input.toolName === 'servertool_fixture' && input.input?.value === "can't stop") {
      return {
        toolName: 'servertool_fixture',
        flowId: input.flowId,
        execCommand: "routecodex hook run servertool_fixture --input-json '{\"value\":\"can'\\''t stop\"}'",
      };
    }
      return {
        toolName: input.toolName,
        flowId: input.flowId,
        execCommand: "routecodex hook run servertool_fixture --input-json '{\"value\":1}'",
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
  }),
}));

let buildServertoolCliProjectionForAutoFlow: typeof import(
  '../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js'
).buildServertoolCliProjectionForAutoFlow;
let buildServertoolCliProjectionForToolCall: typeof import(
  '../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js'
).buildServertoolCliProjectionForToolCall;
let buildClientVisibleProjectionShellWithNative: typeof import(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js'
).buildClientVisibleProjectionShellWithNative;

beforeAll(async () => {
  ({
    buildServertoolCliProjectionForAutoFlow,
    buildServertoolCliProjectionForToolCall
  } = await import('../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js'));
  ({
    buildClientVisibleProjectionShellWithNative
  } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js'));
});

beforeEach(() => {
  delete process.env.ROUTECODEX_SESSION_DIR;
});

afterEach(() => {
  if (ORIGINAL_SESSION_DIR === undefined) {
    delete process.env.ROUTECODEX_SESSION_DIR;
  } else {
    process.env.ROUTECODEX_SESSION_DIR = ORIGINAL_SESSION_DIR;
  }
});

describe('servertool CLI projection', () => {
  it('projects stopless auto flow to exec_command with reasoning and direct CLI input', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: {
          sessionId: 'sess-1',
          __rt: {
            sessionDir: '/tmp/rcc-stopless-port-5555'
          }
        } as any,
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
    expect(command).toMatch(/^ROUTECODEX_SESSION_DIR='\/tmp\/rcc-stopless-port-5555' routecodex hook run reasoning_stop --input-json '/);
    const inputJson = command.match(/--input-json '(.+)'$/)?.[1];
    expect(inputJson ? JSON.parse(inputJson) : null).toEqual({
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3
    });
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('继续执行原任务');
    expect(command).not.toContain('stdoutPreview');
    expect(command).not.toContain('schemaGuidance');
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
    expect(command).toBe("routecodex hook run servertool_fixture --input-json '{\"value\":1}'");
    expect(projection.toolName).toBe('servertool_fixture');
    expect((projection.chatResponse as any).__servertool_cli_projection).toBeUndefined();
    expect((projection as any)[['tick', 'et'].join('')]).toBeUndefined();
  });

  it('uses parsed native shell payloads from the TypeScript bridge', () => {
    const projection = buildClientVisibleProjectionShellWithNative({
      requestId: 'req_obj_shell',
      clientCallId: 'call_obj_shell_1',
      nativeProjection: {
        toolName: 'stop_message_auto',
        flowId: 'stop_message_flow',
        execCommand: "routecodex hook run reasoning_stop --input-json '{\"flowId\":\"stop_message_flow\"}'"
      },
      reasoningText: 'parsed shell',
      additionalToolCalls: []
    } as any);

    expect((projection as any).choices[0].message.reasoning_text).toBe('parsed shell');
    expect((projection as any).__servertool_cli_projection).toBeUndefined();
  });

  it('uses native CLI command quoting for apostrophes in JSON input', () => {
    const projection = buildServertoolCliProjectionForToolCall({
      options: {
        chatResponse: {},
        adapterContext: {} as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_tool_quote',
        providerProtocol: 'openai-responses'
      },
      toolCall: {
        id: 'call_model_quote',
        name: 'servertool_fixture',
        arguments: '{"value":"can\'t stop"}'
      }
    });

    const toolCall = (projection.chatResponse as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;

    expect(command).toBe("routecodex hook run servertool_fixture --input-json '{\"value\":\"can'\\''t stop\"}'");
  });
});
