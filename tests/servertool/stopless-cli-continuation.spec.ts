import { describe, expect, jest, test } from '@jest/globals';
import { Command } from 'commander';
import path from 'node:path';

import { runServerToolOrchestrationShell as runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js';

import { readNativeFunction } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.js';

function resolveStateKeyRust(record: Record<string, unknown>): string {
  const fn = readNativeFunction('resolveServertoolStateKeyJson');
  if (!fn) {
    throw new Error('resolveServertoolStateKeyJson native unavailable');
  }
  const raw = fn(JSON.stringify(record));
  if (typeof raw !== 'string') {
    throw new Error(`resolveServertoolStateKeyJson native returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as string;
}
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function buildStopChatResponse(content: string = 'need continue'): JsonObject {
  return {
    id: 'chatcmpl-stopless-cli',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  } as JsonObject;
}

function buildFencedStopSchema(schemaJson: string): string {
  return `<rcc_stop_schema>${schemaJson}</rcc_stop_schema>`;
}

function buildInvalidTerminalStopSchemaResponse(): JsonObject {
  return buildStopChatResponse(
    `阶段结束\n${buildFencedStopSchema(JSON.stringify({
      stopreason: 0,
      summary: '阶段结束'
    }))}`
  );
}

function buildAdapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return bindMetadataCenter({
    requestId: overrides.requestId ?? `req-stopless-cli-${unique}`,
    entryEndpoint: overrides.entryEndpoint ?? '/v1/chat/completions',
    providerProtocol: overrides.providerProtocol ?? 'openai-chat',
    sessionId: overrides.sessionId ?? `session-stopless-cli-${unique}`,
    capturedChatRequest: overrides.capturedChatRequest ?? {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'diagnose this' }]
    },
    ...(overrides as object)
  } as AdapterContext);
}

function bindMetadataCenter<T extends Record<string, unknown>>(context: T): T {
  const center = MetadataCenter.attach(context);
  if (typeof context.providerProtocol === 'string' && context.providerProtocol.trim()) {
    center.writeRuntimeControl(
      'providerProtocol',
      context.providerProtocol,
      {
        module: 'tests/servertool/stopless-cli-continuation.spec.ts',
        symbol: 'bindMetadataCenter',
        stage: 'test'
      }
    );
  }
  return context;
}

function bindRequestTruth(metadata: Record<string, unknown>, requestId: string, sessionId?: string): void {
  const center = MetadataCenter.attach(metadata);
  center.writeRequestTruth(
    'requestId',
    requestId,
    {
      module: 'tests/servertool/stopless-cli-continuation.spec.ts',
      symbol: 'bindRequestTruth',
      stage: 'test'
    }
  );
  if (sessionId) {
    center.writeRequestTruth(
      'sessionId',
      sessionId,
      {
        module: 'tests/servertool/stopless-cli-continuation.spec.ts',
        symbol: 'bindRequestTruth',
        stage: 'test'
      }
    );
  }
}

function writeStoplessRuntimeControl(
  metadata: Record<string, unknown>,
  state: Record<string, unknown>
): void {
  const stopless: Record<string, unknown> = {
    flowId: 'stop_message_flow',
    repeatCount: state.repeatCount,
    maxRepeats: state.maxRepeats,
    ...(typeof state.continuationPrompt === 'string'
      ? { continuationPrompt: state.continuationPrompt }
      : {}),
    ...(typeof state.triggerHint === 'string' ? { triggerHint: state.triggerHint } : {}),
    ...(state.schemaFeedback && typeof state.schemaFeedback === 'object'
      ? { schemaFeedback: state.schemaFeedback }
      : {})
  };
  MetadataCenter.attach(metadata).writeRuntimeControl(
    'stopless',
    stopless,
    {
      module: 'tests/servertool/stopless-cli-continuation.spec.ts',
      symbol: 'writeStoplessRuntimeControl',
      stage: 'test'
    },
    'test stopless runtime control'
  );
}

function extractExecCommand(resultChat: any): string {
  const toolCall = resultChat?.choices?.[0]?.message?.tool_calls?.[0];
  expect(toolCall?.function?.name).toBe('exec_command');
  return JSON.parse(toolCall.function.arguments).cmd;
}

function maybeExtractExecCommand(resultChat: any): string | undefined {
  const toolCall = resultChat?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return undefined;
  }
  expect(toolCall?.function?.name).toBe('exec_command');
  return JSON.parse(toolCall.function.arguments).cmd;
}

function extractInput(command: string): Record<string, unknown> {
  const inputJson = command.match(/--input-json '([^']+)'(?=\s--|$)/)?.[1];
  expect(inputJson).toBeDefined();
  return JSON.parse(inputJson ?? '{}') as Record<string, unknown>;
}

async function runStoplessCliStdout(command: string) {
  const input = extractInput(command);
  const repeatCount = command.match(/--repeat-count '([^']+)'/)?.[1];
  const maxRepeats = command.match(/--max-repeats '([^']+)'/)?.[1];
  const sessionId = command.match(/--session-id '([^']+)'/)?.[1];
  const requestId = command.match(/--request-id '([^']+)'/)?.[1];
  const output: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.exitOverride();
  process.env.ROUTECODEX_SERVERTOOL_BIN = path.join(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
  );
  createServertoolCommand(program, {
    log: (line) => output.push(line),
    error: (line) => errors.push(line),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}: ${errors.join('\n')}`);
    }
  });
  await program.parseAsync([
    'node',
    'routecodex',
    'hook',
    'run',
    'stop_message_auto',
    '--input-json',
    JSON.stringify(input),
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(requestId ? ['--request-id', requestId] : []),
    ...(repeatCount ? ['--repeat-count', repeatCount] : []),
    ...(maxRepeats ? ['--max-repeats', maxRepeats] : [])
  ]);
  return JSON.parse(output[0] ?? '{}') as Record<string, any>;
}

function buildResponsesToolOutputRequest(output: Record<string, unknown>) {
  return {
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_servertool_cli',
        output: JSON.stringify(output)
      }
    ]
  };
}

describe('stopless CLI continuation', () => {
  test('direct runtime routeName disables stopless CLI projection', async () => {
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: '',
      __rt: {
        routeName: 'router-direct:thinking'
      } as any
    });
    bindRequestTruth(adapterContext, adapterContext.requestId);

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('direct stop must passthrough'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('direct stopless disable must not reenter');
      }
    });

    expect(result.executed).toBe(false);
    expect(result.chat).toEqual(buildStopChatResponse('direct stop must passthrough'));
  });

  test('resolveStateKey still uses only sessionId (no tmux/conversation/inject fallback)', () => {
    expect(resolveStateKeyRust({
      providerProtocol: 'openai-responses',
      requestId: 'req-stopless-session-only',
      sessionId: 'session-a',
      conversationId: 'conversation-ignored',
      clientTmuxSessionId: 'tmux-ignored',
      stopMessageClientInjectScope: 'conversation:legacy'
    })).toBe('session:session-a');
  });

  test('stopless CLI stdout carries schema guidance with request truth session identity', async () => {
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });
    bindRequestTruth(adapterContext, adapterContext.requestId, adapterContext.sessionId);
    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });
    expect(result.executed).toBe(true);
    const command = extractExecCommand(result.chat);
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
    const message = (result.chat as any).choices?.[0]?.message;
    expect(message?.content).toContain('need more evidence');
    expect(message?.reasoning_text).toBeUndefined();
    expect(message?.reasoning_content).toBeUndefined();
    expect(message?.reasoning).toBeUndefined();
    expect(JSON.stringify(result.chat)).not.toContain('function_call_output');
    expect(command).not.toContain('schemaGuidance');
    const cliStdout = await runStoplessCliStdout(command);
    expect(cliStdout.routeHint).toBe('thinking');
    expect(cliStdout.repeatCount).toBe(1);
    expect(cliStdout.maxRepeats).toBe(3);
    expect(cliStdout.sessionId).toBeUndefined();
    expect(cliStdout.requestId).toBeUndefined();
    expect(cliStdout.schemaGuidance).toBeUndefined();
    expect(cliStdout.modelGuidance).toBeUndefined();
  });

  test('responses resume in metadata center reprojects second-round repeatCount via builtin stopless handler', async () => {
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      providerProtocol: 'openai-responses',
      capturedChatRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    });
    bindRequestTruth(adapterContext, adapterContext.requestId, adapterContext.sessionId);
    writeStoplessRuntimeControl(adapterContext, {
      continuationPrompt: '继续执行原任务',
      repeatCount: 1,
      maxRepeats: 3
    });

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('stopless continuation ready'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    const command = extractExecCommand(result.chat);
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(extractInput(command).repeatCount).toBe(2);
  });

  test('client-facing stopless blackbox advances repeatCount across submit_tool_outputs rounds and stops on round three', async () => {
    const sessionId = `session-stopless-client-blackbox-${Date.now()}`;
    const requestId1 = `req-stopless-client-blackbox-1-${Date.now()}`;
    const round1Context = buildAdapterContext({
      requestId: requestId1,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 stopless 在线验证' }]
      }
    });
    bindRequestTruth(round1Context, requestId1, sessionId);

    const round1 = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: round1Context,
      requestId: requestId1,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless client-facing round 1 must not reenter');
      }
    });
    expect(round1.executed).toBe(true);
    const command1 = extractExecCommand(round1.chat);
    expect(extractInput(command1)).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3
    });
    const stdout1 = await runStoplessCliStdout(command1);
    expect(stdout1.repeatCount).toBe(1);

    const requestId2 = `req-stopless-client-blackbox-2-${Date.now()}`;
    const round2Context = buildAdapterContext({
      requestId: requestId2,
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 stopless 在线验证' }]
      }
    });
    bindRequestTruth(round2Context, requestId2, sessionId);
    writeStoplessRuntimeControl(round2Context, stdout1);

    const round2 = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: round2Context,
      requestId: requestId2,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless client-facing round 2 must not reenter');
      }
    });
    expect(round2.executed).toBe(true);
    const command2 = extractExecCommand(round2.chat);
    expect(extractInput(command2)).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3
    });
    const stdout2 = await runStoplessCliStdout(command2);
    expect(stdout2.repeatCount).toBe(2);

    const requestId3 = `req-stopless-client-blackbox-3-${Date.now()}`;
    const round3Context = buildAdapterContext({
      requestId: requestId3,
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 stopless 在线验证' }]
      }
    });
    bindRequestTruth(round3Context, requestId3, sessionId);
    writeStoplessRuntimeControl(round3Context, stdout2);

    const round3 = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: round3Context,
      requestId: requestId3,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless client-facing round 3 must not reenter');
      }
    });
    expect(round3.executed).toBe(true);
    expect(maybeExtractExecCommand(round3.chat)).toBeUndefined();
    expect((round3.chat as any).choices?.[0]?.finish_reason).toBe('stop');
    expect(JSON.stringify(round3.chat)).toContain('need more evidence');
    expect(JSON.stringify(round3.chat)).not.toContain('stopless budget exhausted');
  });

  test('missing request truth sessionId keeps stopless terminal', async () => {
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: ''
    });
    bindRequestTruth(adapterContext, adapterContext.requestId);

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('missing session truth must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.finish_reason).toBe('stop');
    expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop');
  });

  test('response-side shell projection and request-side built-in restoration stay paired', async () => {
    const sessionId = `session-stopless-paired-${Date.now()}`;
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId
    });
    bindRequestTruth(adapterContext, adapterContext.requestId, sessionId);

    const first = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: `req-stopless-paired-1-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('paired stopless projection must not reenter');
      }
    });
    expect(first.executed).toBe(true);
    expect(maybeExtractExecCommand(first.chat)).toContain('routecodex hook run reasoningStop');

    const secondAdapterContext = buildAdapterContext({
      requestId: `req-stopless-paired-2-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId
    }) as any;
    delete secondAdapterContext.capturedChatRequest;
    secondAdapterContext.__raw_request_body = {
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli',
          output: JSON.stringify({ repeatCount: 1, maxRepeats: 3, sessionId })
        }
      ]
    };

    const second = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: secondAdapterContext,
      requestId: `req-stopless-paired-2-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('paired stopless request restore must not reenter');
      }
    });
    expect(second.executed).toBe(true);
    expect(maybeExtractExecCommand(second.chat)).toBeUndefined();
    expect(JSON.stringify(second.chat)).not.toContain('function_call_output');
    expect(JSON.stringify(second.chat)).not.toContain('old_cli_');
  });

  test('stopless next turn restores runtime state from current tool output instead of persisted file state', async () => {
    const sessionId = `session-stopless-loop-${Date.now()}`;
    const first = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: buildAdapterContext({
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId
      }),
      requestId: `req-stopless-first-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });
    expect(first.executed).toBe(true);
    expect(maybeExtractExecCommand(first.chat)).toBeUndefined();

    const secondAdapterContext = buildAdapterContext({
      requestId: `req-stopless-second-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId
    }) as any;
    delete secondAdapterContext.capturedChatRequest;
    secondAdapterContext.__raw_request_body = {
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli',
          output: JSON.stringify({ repeatCount: 1, maxRepeats: 3, sessionId })
        }
      ]
    };

    const second = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: secondAdapterContext,
      requestId: `req-stopless-second-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });
    expect(second.executed).toBe(true);
    expect(maybeExtractExecCommand(second.chat)).toBeUndefined();
  });

  test('stopless sessionId drives repeatCount end-to-end and does not cross sessions', async () => {
    const sessionA = `session-stopless-e2e-a-${Date.now()}`;
    const requestA1 = `req-stopless-e2e-a-1-${Date.now()}`;
    const firstA = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: (() => {
        const context = bindMetadataCenter({
        ...buildAdapterContext({
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: sessionA
        })
        } as any);
        bindRequestTruth(context, requestA1, sessionA);
        return context;
      })(),
      requestId: requestA1,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(firstA.executed).toBe(true);
    const commandA1 = maybeExtractExecCommand(firstA.chat);
    expect(commandA1).toContain('routecodex hook run reasoningStop');
    const stdoutA1 = await runStoplessCliStdout(commandA1!);
    expect(stdoutA1.sessionId).toBeUndefined();
    expect(stdoutA1.repeatCount).toBe(1);

    const requestA2 = `req-stopless-e2e-a-2-${Date.now()}`;
    const adapterA2 = bindMetadataCenter({
      ...buildAdapterContext({
        requestId: requestA2,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId: sessionA
      })
    } as any);
    bindRequestTruth(adapterA2, requestA2, sessionA);
    writeStoplessRuntimeControl(adapterA2, stdoutA1);
    const secondA = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: adapterA2,
      requestId: requestA2,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(secondA.executed).toBe(true);
    const commandA2 = maybeExtractExecCommand(secondA.chat);
    expect(commandA2).toContain('routecodex hook run reasoningStop');
    expect(extractInput(commandA2!)).toMatchObject({
      repeatCount: 2,
      maxRepeats: 3
    });
    expect(commandA2).not.toContain('--session-id');
    expect(commandA2).not.toContain('--request-id');
    const stdoutA2 = await runStoplessCliStdout(commandA2!);
    expect(stdoutA2.sessionId).toBeUndefined();
    expect(stdoutA2.repeatCount).toBe(2);

    const requestA3 = `req-stopless-e2e-a-3-${Date.now()}`;
    const adapterA3 = bindMetadataCenter({
      ...buildAdapterContext({
        requestId: requestA3,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId: sessionA
      })
    } as any);
    bindRequestTruth(adapterA3, requestA3, sessionA);
    writeStoplessRuntimeControl(adapterA3, stdoutA2);
    const thirdA = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: adapterA3,
      requestId: requestA3,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(thirdA.executed).toBe(true);
    expect(maybeExtractExecCommand(thirdA.chat)).toBeUndefined();
    expect((thirdA.chat as any).choices?.[0]?.finish_reason).toBe('stop');

    const sessionB = `session-stopless-e2e-b-${Date.now()}`;
    const requestB1 = `req-stopless-e2e-b-1-${Date.now()}`;
    const firstB = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: (() => {
        const context = bindMetadataCenter({
        ...buildAdapterContext({
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: sessionB
        })
        } as any);
        bindRequestTruth(context, requestB1, sessionB);
        return context;
      })(),
      requestId: requestB1,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(firstB.executed).toBe(true);
    const commandB1 = maybeExtractExecCommand(firstB.chat);
    expect(commandB1).toContain('routecodex hook run reasoningStop');
    const stdoutB1 = await runStoplessCliStdout(commandB1!);
    expect(stdoutB1.sessionId).toBeUndefined();
    expect(stdoutB1.repeatCount).toBe(1);
  });

  test('stopless first round initializes from empty metadata center and writes repeatCount=1', async () => {
    const sessionId = `session-stopless-init-${Date.now()}`;
    const requestId = `req-stopless-init-${Date.now()}`;
    const adapterContext = bindMetadataCenter({
      ...buildAdapterContext({
        requestId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId
      })
    } as any);
    bindRequestTruth(adapterContext, requestId, sessionId);

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless init path must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    const command = maybeExtractExecCommand(result.chat);
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(extractInput(command!)).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3
    });

    const center = MetadataCenter.read(adapterContext as unknown as Record<string, unknown>);
    const runtimeControl = center?.readRuntimeControl() as Record<string, any> | undefined;
    expect(runtimeControl?.stopless).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      active: true
    });
  });

  test('invalid schema CLI projection keeps MetadataCenter stopless maxRepeats budget', async () => {
    const sessionId = `session-stopless-invalid-budget-${Date.now()}`;
    const requestId = `req-stopless-invalid-budget-${Date.now()}`;
    const adapterContext = bindMetadataCenter({
      ...buildAdapterContext({
        requestId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId
      })
    } as any);
    bindRequestTruth(adapterContext, requestId, sessionId);
    const center = MetadataCenter.read(adapterContext as unknown as Record<string, unknown>);
    expect(center).toBeDefined();
    center?.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 0,
        maxRepeats: 3,
        continuationPrompt: '继续执行',
        active: true
      },
      {
        module: 'tests/servertool/stopless-cli-continuation.spec.ts',
        symbol: 'invalid schema CLI projection keeps MetadataCenter stopless maxRepeats budget',
        stage: 'test'
      }
    );

    const result = await runServerToolOrchestration({
      chat: buildInvalidTerminalStopSchemaResponse(),
      adapterContext,
      requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('invalid schema stopless CLI projection must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    const command = maybeExtractExecCommand(result.chat);
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(extractInput(command!)).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      triggerHint: 'invalid_schema'
    });
    expect(center?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'stop_schema_terminal_missing_fields',
        schemaFeedback: {
          reasonCode: 'stop_schema_terminal_missing_fields',
          missingFields: ['has_evidence', 'evidence']
        },
        active: true
      })
    );
  });

  test('metadata center loop state drives third-round terminal stop when current tool output snapshot is absent', async () => {
    const sessionId = `session-stopless-fallback-${Date.now()}`;
    const requestId = `req-stopless-fallback-${Date.now()}`;
    const adapterContext = bindMetadataCenter({
      ...buildAdapterContext({
        requestId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId
      })
    } as any);
    bindRequestTruth(adapterContext, requestId, sessionId);
    const center = MetadataCenter.read(adapterContext as unknown as Record<string, unknown>);
    center?.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务',
        active: true
      },
      {
        module: 'tests/servertool/stopless-cli-continuation.spec.ts',
        symbol: 'metadata center loop state carries visible repeatCount when current tool output snapshot is absent',
        stage: 'test'
      }
    );

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('saved canonical loop state fallback must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.finish_reason).toBe('stop');
  });

  test('missing session makes stopless terminal instead of projecting CLI', async () => {
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: '   '
    }) as any;
    delete adapterContext.capturedChatRequest;
    delete adapterContext.sessionId;
    delete adapterContext.metadata;
    delete adapterContext.__rt;

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: `req-stopless-missing-session-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('missing-session stopless must not reenter');
      }
    });

    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.finish_reason).toBe('stop');
    expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop');
  });

  test('sentinel unknown session makes stopless terminal instead of projecting CLI', async () => {
    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: bindMetadataCenter({
        ...buildAdapterContext({
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: 'unknown'
        }),
        metadata: {
          sessionId: 'unknown'
        }
      } as any),
      requestId: `req-stopless-unknown-session-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('unknown-session stopless must not reenter');
      }
    });

    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.finish_reason).toBe('stop');
    expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop');
  });

  test('responsesRequestContext-only session makes stopless terminal instead of projecting CLI', async () => {
    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: bindMetadataCenter({
        ...buildAdapterContext({
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: ''
        }),
        metadata: {
          responsesRequestContext: {
            sessionId: 'sess-hidden-relay',
            conversationId: 'conv-hidden-relay'
          }
        }
      } as any),
      requestId: `req-stopless-hidden-relay-session-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('responsesRequestContext-only stopless must not reenter');
      }
    });

    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.finish_reason).toBe('stop');
    expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop');
  });

  test('stopless reaches max repeats and turns terminal instead of looping forever', async () => {
    const sessionId = `session-stopless-terminal-${Date.now()}`;
    const first = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: buildAdapterContext({
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId
      }),
      requestId: `req-stopless-terminal-first-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless terminal path must not reenter');
      }
    });
    const second = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: bindMetadataCenter({
        ...buildAdapterContext({
          requestId: `req-stopless-terminal-second-${Date.now()}`,
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId
        }),
        __raw_request_body: {
          input: [{
            type: 'function_call_output',
            call_id: 'call_servertool_cli',
            output: JSON.stringify({ repeatCount: 1, maxRepeats: 3, sessionId })
          }]
        }
      } as any),
      requestId: `req-stopless-terminal-second-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless terminal path must not reenter');
      }
    });
    const third = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: bindMetadataCenter({
        ...buildAdapterContext({
          requestId: `req-stopless-terminal-third-${Date.now()}`,
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId
        }),
        __raw_request_body: {
          input: [{
            type: 'function_call_output',
            call_id: 'call_servertool_cli',
            output: JSON.stringify({ repeatCount: 2, maxRepeats: 3 })
          }]
        }
      } as any),
      requestId: `req-stopless-terminal-third-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless terminal path must not reenter');
      }
    });

    expect(maybeExtractExecCommand(third.chat)).toBeUndefined();
    expect(JSON.stringify(third.chat)).not.toContain('routecodex hook run reasoningStop');
  });

  test('terminal stopless result stays terminal and does not project CLI', async () => {
    const adapterContext = buildAdapterContext({
      __raw_request_body: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      } as any
    });

    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl-stopless-cli-terminal',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '已完成在线验证。',
                buildFencedStopSchema(
                  '{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round","done_steps":"verified","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"ok"}'
                )
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('terminal stopless result must not reenter');
      }
    });

    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    const visible = JSON.stringify(result.chat);
    expect(visible).not.toContain('routecodex hook run stop_message_auto');
    expect(visible).not.toContain('routecodex hook run reasoningStop');
    expect(visible).not.toContain('exec_command');
  });

  test('stopless projects CLI and never reenters pipeline', async () => {
    const reenterPipeline = jest.fn(async () => ({
      body: {
        id: 'chatcmpl-should-not-run',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'unexpected' }, finish_reason: 'stop' }]
      } as JsonObject
    }));
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).not.toHaveBeenCalled();
    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect(JSON.stringify(result.chat)).not.toContain('stop_message_auto');
  });
});
