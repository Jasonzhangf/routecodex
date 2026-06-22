import { describe, expect, jest, test } from '@jest/globals';
import { Command } from 'commander';
import path from 'node:path';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { resolveStateKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
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
  MetadataCenter.attach(context);
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
    expect(resolveStateKey({
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
    expect(maybeExtractExecCommand(result.chat)).toBeUndefined();
    expect((result.chat as any).choices?.[0]?.message?.content).toContain('need more evidence');
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
    expect(maybeExtractExecCommand(first.chat)).toBeUndefined();

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
    const firstA = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: buildAdapterContext({
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId: sessionA
      }),
      requestId: `req-stopless-e2e-a-1-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(firstA.executed).toBe(true);
    expect(maybeExtractExecCommand(firstA.chat)).toBeUndefined();

    const secondA = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: bindMetadataCenter({
        ...buildAdapterContext({
          requestId: `req-stopless-e2e-a-2-${Date.now()}`,
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: sessionA
        }),
        __raw_request_body: {
          input: [{
            type: 'function_call_output',
            call_id: 'call_servertool_cli',
            output: JSON.stringify({ repeatCount: 1, maxRepeats: 3, sessionId: sessionA })
          }]
        }
      } as any),
      requestId: `req-stopless-e2e-a-2-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(secondA.executed).toBe(true);
    expect(maybeExtractExecCommand(secondA.chat)).toBeUndefined();

    const sessionB = `session-stopless-e2e-b-${Date.now()}`;
    const firstB = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext: buildAdapterContext({
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId: sessionB
      }),
      requestId: `req-stopless-e2e-b-1-${Date.now()}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless session e2e must not reenter');
      }
    });
    expect(firstB.executed).toBe(true);
    expect(maybeExtractExecCommand(firstB.chat)).toBeUndefined();
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
        },
        __rt: {
          sessionId: 'unknown',
          responsesRequestContext: {
            sessionId: 'unknown'
          }
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
        },
        __rt: {
          responsesRequestContext: {
            sessionId: 'sess-hidden-relay-rt',
            conversationId: 'conv-hidden-relay-rt'
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
