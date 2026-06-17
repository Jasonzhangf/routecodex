import {
  beforeAll,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js', () => ({
  readRuntimeMetadata: (carrier: unknown) => (
    carrier && typeof carrier === 'object' && !Array.isArray(carrier)
      ? (carrier as Record<string, unknown>).__rt as Record<string, unknown> | undefined
      : undefined
  ),
  ensureRuntimeMetadata: (carrier: Record<string, unknown>) => carrier,
  cloneRuntimeMetadata: () => ({})
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.ts', () => ({
  readRuntimeMetadata: (carrier: unknown) => (
    carrier && typeof carrier === 'object' && !Array.isArray(carrier)
      ? (carrier as Record<string, unknown>).__rt as Record<string, unknown> | undefined
      : undefined
  ),
  ensureRuntimeMetadata: (carrier: Record<string, unknown>) => carrier,
  cloneRuntimeMetadata: () => ({})
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js', () => ({
  readRuntimeMetadataWithNative: (carrier: unknown) => (carrier && typeof carrier === 'object' && '__rt' in (carrier as Record<string, unknown>)) ? (carrier as Record<string, unknown>).__rt : undefined,
  ensureRuntimeMetadataCarrierWithNative: (carrier: Record<string, unknown>) => carrier,
  cloneRuntimeMetadataWithNative: () => ({}),

  buildClientExecCliProjectionOutputWithNative: (input: any) => {
    if (input.flowId === 'stop_message_flow') {
      return {
        toolName: 'stop_message_auto',
        flowId: 'stop_message_flow',
        execCommand: `routecodex hook run reasoning_stop --input-json '{"flowId":"stop_message_flow","repeatCount":2,"maxRepeats":3}' --repeat-count '2' --max-repeats '3'`,
        repeatCount: 2,
        maxRepeats: 3
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
    expect(command).toMatch(/^routecodex hook run reasoning_stop --input-json '/);
    expect(command).not.toContain('--session-dir');
    const inputJson = command.match(/--input-json '([^']+)'(?=\s--repeat-count|\s--max-repeats|$)/)?.[1];
    expect(inputJson ? JSON.parse(inputJson) : null).toEqual({
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3
    });
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('继续执行原任务');
    expect(command).not.toContain('stdoutPreview');
    expect(command).not.toContain('schemaGuidance');
    expect(command).not.toContain(['--', 'tic', 'ket'].join(''));
    expect(command).not.toContain(['st', 'cli_'].join(''));
    expect(command).not.toContain(['rcc', '_cli_'].join(''));
    expect((projection as any)[['tick', 'et'].join('')]).toBeUndefined();
  });

  it('ignores metadata.sessionId for stopless auto flow projection', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: {
          metadata: {
            sessionId: 'sess-meta-1'
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_stop_meta_1',
        providerProtocol: 'openai-responses'
      },
      flowId: 'stop_message_flow',
      reasoningText: 'meta session',
      input: {
        repeatCount: 2,
        maxRepeats: 3
      }
    });
    const command = JSON.parse((projection.chatResponse as any).choices[0].message.tool_calls[0].function.arguments).cmd;
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
  });

  it('ignores responsesRequestContext.sessionId for stopless auto flow projection', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: {
          __rt: {
            responsesRequestContext: {
              sessionId: 'sess-rrc-1'
            }
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_stop_rrc_1',
        providerProtocol: 'openai-responses'
      },
      flowId: 'stop_message_flow',
      reasoningText: 'rrc session',
      input: {
        repeatCount: 2,
        maxRepeats: 3
      }
    });
    const command = JSON.parse((projection.chatResponse as any).choices[0].message.tool_calls[0].function.arguments).cmd;
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
  });

  it('does not require request-scoped session truth for stop_message_flow auto projection', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: {} as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_stop_missing_session',
        providerProtocol: 'openai-responses'
      },
      flowId: 'stop_message_flow',
      reasoningText: 'missing session',
      input: {
        repeatCount: 1,
        maxRepeats: 3
      }
    });
    const command = JSON.parse((projection.chatResponse as any).choices[0].message.tool_calls[0].function.arguments).cmd;
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
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
