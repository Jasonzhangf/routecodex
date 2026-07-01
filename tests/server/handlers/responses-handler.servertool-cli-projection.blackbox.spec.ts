import { runServerToolOrchestrationShell as runServerToolOrchestration } from '../../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js';
import { buildResponsesPayloadFromChatWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import fs from 'node:fs';
import path from 'node:path';

function extractCommandInput(command: string): Record<string, unknown> {
  const match = command.match(/--input-json '([^']+)'(?=\s--|$)/);
  return match ? JSON.parse(match[1]) as Record<string, unknown> : {};
}

function isolateSessionDir(label: string): void {
  const dir = path.join(process.cwd(), '.tmp', 'jest-servertool-blackbox', `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.ROUTECODEX_SESSION_DIR = dir;
}

function bindStoplessMetadataCenter<T extends Record<string, unknown>>(adapterContext: T): T {
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl(
    'providerProtocol',
    'openai-responses',
    {
      module: 'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
      symbol: 'bindStoplessMetadataCenter',
      stage: 'test'
    }
  );
  if (typeof adapterContext.requestId === 'string' && adapterContext.requestId.trim()) {
    center.writeRequestTruth(
      'requestId',
      adapterContext.requestId.trim(),
      {
        module: 'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
        symbol: 'bindStoplessMetadataCenter',
        stage: 'test'
      }
    );
  }
  if (typeof adapterContext.sessionId === 'string' && adapterContext.sessionId.trim()) {
    center.writeRequestTruth(
      'sessionId',
      adapterContext.sessionId.trim(),
      {
        module: 'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
        symbol: 'bindStoplessMetadataCenter',
        stage: 'test'
      }
    );
  }
  return adapterContext;
}

function bindStoplessLoopState<T extends Record<string, unknown>>(adapterContext: T, args: {
  repeatCount: number;
  maxRepeats: number;
  continuationPrompt?: string;
  active?: boolean;
  triggerHint?: string;
}): T {
  const bound = bindStoplessMetadataCenter(adapterContext);
  const center = MetadataCenter.attach(bound);
  center.writeRuntimeControl(
    'stopless',
    {
      flowId: 'stop_message_flow',
      repeatCount: args.repeatCount,
      maxRepeats: args.maxRepeats,
      active: args.active ?? true,
      ...(typeof args.continuationPrompt === 'string'
        ? { continuationPrompt: args.continuationPrompt }
        : {}),
      ...(typeof args.triggerHint === 'string' ? { triggerHint: args.triggerHint } : {})
    },
    {
      module: 'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
      symbol: 'bindStoplessLoopState',
      stage: 'test'
    }
  );
  return bound;
}

describe('servertool CLI projection blackbox', () => {
  it('intercepts terminal reasoningStop and releases it as a normal stop response', async () => {
    let reenterCount = 0;
    const reenterPipeline = async () => {
      reenterCount += 1;
      return { body: {} };
    };
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_reasoning_stop_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '完成，准备收尾。',
              tool_calls: [
                {
                  id: 'call_reasoning_stop_blackbox',
                  type: 'function',
                  function: {
                    name: 'reasoningStop',
                    arguments: '{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"1","done_steps":"done","next_step":"无","next_suggested_path":"无","needs_user_input":false,"learned":"ok"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      adapterContext: bindStoplessMetadataCenter({
        requestId: 'req_reasoning_stop_blackbox',
        sessionId: 'sess-reasoning-stop-blackbox',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true
      } as any),
      requestId: 'req_reasoning_stop_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(reenterCount).toBe(0);
    expect(result.executed).toBe(true);
    expect((result.chat as any).choices[0].finish_reason).toBe('stop');
    expect((result.chat as any).choices[0].message.tool_calls).toBeUndefined();
    expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop');
    expect(String((result.chat as any).choices[0].message.content ?? '')).toBe('完成，准备收尾。');
  });

  it('projects non-terminal reasoningStop tool calls to client exec_command', async () => {
    let reenterCount = 0;
    const reenterPipeline = async () => {
      reenterCount += 1;
      return { body: {} };
    };
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_reasoning_stop_continue_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '还不能停。',
              tool_calls: [
                {
                  id: 'call_reasoning_stop_continue_blackbox',
                  type: 'function',
                  function: {
                    name: 'reasoningStop',
                    arguments: '{"stopreason":2,"reason":"not done","has_evidence":1,"evidence":"partial","issue_cause":"still running","excluded_factors":"not blocked","diagnostic_order":"1","done_steps":"partial","next_step":"run next verification","next_suggested_path":"继续执行","needs_user_input":false,"learned":""}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      adapterContext: bindStoplessMetadataCenter({
        requestId: 'req_reasoning_stop_continue_blackbox',
        sessionId: 'sess-reasoning-stop-continue-blackbox',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true
      } as any),
      requestId: 'req_reasoning_stop_continue_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(reenterCount).toBe(0);
    expect(result.executed).toBe(true);
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect((result.chat as any).choices[0].finish_reason).toBe('tool_calls');
    expect(toolCall.function.name).toBe('exec_command');
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(command).not.toContain('stop_message_auto');
  });

  it('projects malformed reasoningStop arguments to client exec_command instead of leaking the raw internal tool', async () => {
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_reasoning_stop_malformed_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '工具参数损坏。',
              tool_calls: [
                {
                  id: 'call_reasoning_stop_malformed_blackbox',
                  type: 'function',
                  function: {
                    name: 'reasoningStop',
                    arguments: '{"stopreason":2,"reason":"still running"'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      adapterContext: bindStoplessMetadataCenter({
        requestId: 'req_reasoning_stop_malformed_blackbox',
        sessionId: 'sess-reasoning-stop-malformed-blackbox',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true
      } as any),
      requestId: 'req_reasoning_stop_malformed_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('malformed reasoningStop must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect((result.chat as any).choices[0].finish_reason).toBe('tool_calls');
    expect(toolCall.function.name).toBe('exec_command');
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(JSON.stringify(result.chat)).not.toContain('"reasoningStop"');
  });

  it('returns exec_command projection and does not reenter for intercepted servertool call', async () => {
    let reenterCount = 0;
    const reenterPipeline = async () => {
      reenterCount += 1;
      return { body: {} };
    };
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_servertool_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_model_blackbox',
                  type: 'function',
                  function: {
                    name: 'servertool_fixture',
                    arguments: '{"value":1}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      adapterContext: bindStoplessMetadataCenter({ sessionId: 'sess-blackbox' } as any),
      requestId: 'req_servertool_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(reenterCount).toBe(0);
    expect(result.executed).toBe(true);
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect(toolCall.function.name).toBe('exec_command');
    expect(command).toContain("routecodex hook run servertool_fixture --input-json '{\"value\":1}'");
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--request-id');
    expect(command).not.toContain(['--', 'tic', 'ket'].join(''));
    expect(command).not.toContain(['st', 'cli_'].join(''));
    expect(command).not.toContain(['rcc', '_cli_'].join(''));
  });

  it('projects stopless CLI input with continuation prompt and repeat counters', async () => {
    isolateSessionDir('stopless-lifecycle');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_projection_lifecycle',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段完成：已定位 stopless 投影问题，但还缺少线上复测证据。'
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        requestId: 'req_stop_cli_lifecycle',
        sessionId: 'sess-stop-cli-lifecycle',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any, {
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_lifecycle',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    const input = extractCommandInput(command);
    expect(input.flowId).toBe('stop_message_flow');
    expect(input.continuationPrompt).toBeUndefined();
    expect(input.schemaGuidance).toBeUndefined();
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('继续执行');
    expect(command).not.toContain('schemaFeedback');
    expect(command).not.toContain('stopreason');
    expect(command).not.toContain('--request-id');
    expect(command).not.toContain('--session-id');
    for (const forbidden of [
      'stopless',
      'servertool',
      '第一轮',
      '第二轮',
      '第三轮',
      '必须调用',
      '证据不足',
      '用户目标',
      '已排除因素',
      '排查顺序'
    ]) {
      expect(command).not.toContain(forbidden);
    }
    expect(input.repeatCount).toBe(2);
    expect(input.maxRepeats).toBe(3);

    const responsesPayload = buildResponsesPayloadFromChatWithNative(result.chat as any, {
      requestId: 'req_stop_cli_lifecycle'
    }) as Record<string, any>;
    const reasoning = responsesPayload.output.find((item: any) => item.type === 'reasoning');
    expect(reasoning?.summary?.[0]?.type).toBe('summary_text');
    expect(reasoning?.summary?.[0]?.text).toContain('已定位 stopless 投影问题');
    expect(reasoning?.content).toBeUndefined();
    expect(JSON.stringify(responsesPayload)).not.toContain('<rcc_stop_schema>');
    expect(JSON.stringify(responsesPayload)).not.toContain('</rcc_stop_schema>');
  });

  it('strips inline reasoningStop schema residue from responses summary without truncating useful text', async () => {
    const responsesPayload = buildResponsesPayloadFromChatWithNative({
      id: 'chatcmpl_stop_projection_inline_schema_residue',
      object: 'chat.completion',
      model: 'gpt-test',
      created: 1700000000,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '阶段结果：计数已修复。',
            reasoning: {
              summary: [
                {
                  type: 'summary_text',
                  text: '阶段结果：计数已修复。 reasoningStop with2 -> next_step: "继续补 provider 黑盒并重放线上样本" Jason, 我继续执行。'
                }
              ]
            },
            tool_calls: [
              {
                id: 'call_exec_inline_schema_residue',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}'
                }
              }
            ]
          }
        }
      ]
    } as any, {
      requestId: 'req_stop_projection_inline_schema_residue'
    }) as Record<string, any>;

    const serialized = JSON.stringify(responsesPayload);
    const reasoning = responsesPayload.output.find((item: any) => item.type === 'reasoning');
    const summaryText = String(reasoning?.summary?.[0]?.text ?? '');
    expect(serialized).not.toContain('reasoningStop');
    expect(serialized).not.toContain('next_step');
    expect(summaryText).toContain('阶段结果：计数已修复。');
    expect(summaryText).toContain('继续补 provider 黑盒并重放线上样本');
    expect(summaryText).not.toContain('Jason, 我继续执行');
    expect(summaryText.trim()).not.toBe('**Thinking**');
  });

  it('re-projects stop_message_auto on submit_tool_outputs resume when current response stops again', async () => {
    isolateSessionDir('resume-reproject');
    const validResumeCommand = "routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3}'";
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_after_cli_result',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'stopless continuation ready'
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        sessionId: 'sess-stop-cli-loop-guard-resume-reproject',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __raw_request_body: {
          model: 'gpt-5.5',
          input: [
            { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] },
            {
              type: 'function_call',
              call_id: 'call_servertool_cli_stop_1',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: validResumeCommand
              })
            },
            {
              type: 'function_call_output',
              call_id: 'call_servertool_cli_stop_1',
              output: '{"ok":true,"kind":"stop_message_auto","tool":"stop_message_auto","summary":"stopless continuation ready"}'
            }
          ]
        }
      } as any, {
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_loop_guard',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stop_message_auto CLI projection must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect(toolCall.function.name).toBe('exec_command');
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(command).not.toContain('stop_message_auto');
    expect(extractCommandInput(command).repeatCount).toBe(2);
  });

  it('blackbox keeps schema feedback out of final stopless exec_command payload', async () => {
    isolateSessionDir('schema-feedback-lock');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_schema_feedback_lock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段完成，但缺 schema。'
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        requestId: 'req_stop_cli_schema_feedback_lock',
        sessionId: 'sess-stop-cli-schema-feedback-lock',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any, {
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_schema_feedback_lock',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('schema feedback blackbox must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    const command = JSON.parse(toolCall.function.arguments).cmd;
    const input = extractCommandInput(command);
    expect(input.triggerHint).toBe('no_schema');
    expect(input.schemaFeedback).toBeUndefined();
    expect(command).not.toContain('schemaFeedback');
    expect(command).not.toContain('stopreason');
  });

  it('blackbox keeps projecting valid continue schema instead of treating it as consecutive no_schema', async () => {
    isolateSessionDir('third-no-schema-terminal');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_third_no_schema_terminal',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '还是没补 schema，但已经完成日志排查。',
                '<rcc_stop_schema>',
                '{"stopreason":2,"reason":"continue","next_step":"继续循环"}',
                '</rcc_stop_schema>',
                'reasoningStop with2 -> next_step: "不要再投 CLI，应直接回传当前总结"'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        sessionId: 'sess-stop-cli-third-no-schema-terminal',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any, {
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_third_no_schema_terminal',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('third no_schema terminal must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    const payload = result.chat as any;
    expect(JSON.stringify(payload)).toContain('routecodex hook run reasoningStop');
    const toolCall = payload.choices?.[0]?.message?.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('exec_command');
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect(extractCommandInput(command)).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 3,
      maxRepeats: 3,
      triggerHint: 'non_terminal_schema'
    });
  });

  it('returns terminal allow-stop result without re-projecting exec_command', async () => {
    isolateSessionDir('allow-stop-terminal');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_allow_stop_terminal',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '已完成在线验证。',
                '<rcc_stop_schema>',
                '{"stopreason":0,"reason":"已完成 allow-stop live 验证","has_evidence":1,"evidence":"5555 live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round allow stop","done_steps":"allow-stop response","next_step":"","next_suggested_path":"无需后续动作","learned":"summary must be markdown","needs_user_input":false}',
                '</rcc_stop_schema>'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        sessionId: 'sess-stop-cli-allow-stop-terminal',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any, {
        repeatCount: 0,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_allow_stop_terminal',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('allow-stop terminal result must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    const payload = result.chat as any;
    expect(JSON.stringify(payload)).not.toContain('routecodex servertool run stop_message_auto');
    expect(payload.required_action).toBeUndefined();
    const message = payload.choices?.[0]?.message;
    expect(String(message?.content)).toBe('已完成在线验证。');
    expect(String(message?.content)).not.toContain('"stopreason"');
    expect(String(message?.content)).not.toContain('<rcc_stop_schema>');
    expect(String(message?.content)).not.toContain('</rcc_stop_schema>');
    expect(message?.reasoning_text).toBeUndefined();
    expect(message?.reasoning_content).toBeUndefined();
    expect(message?.reasoning).toBeUndefined();

    const responsesPayload = buildResponsesPayloadFromChatWithNative(payload, {
      requestId: 'req_stop_cli_allow_stop_terminal'
    }) as Record<string, any>;
    expect(Array.isArray(responsesPayload.output)).toBe(true);
    expect(responsesPayload.output.some((item: any) => item?.type === 'reasoning')).toBe(false);
    expect(String(responsesPayload.output_text)).toBe('已完成在线验证。');
    expect(JSON.stringify(responsesPayload)).not.toContain('stopreason');
    expect(JSON.stringify(responsesPayload)).not.toContain('needs_user_input');
    expect(JSON.stringify(responsesPayload)).not.toContain('has_evidence');
    expect(JSON.stringify(responsesPayload)).not.toContain('<rcc_stop_schema>');
    expect(JSON.stringify(responsesPayload)).not.toContain('</rcc_stop_schema>');
  });

  it('strips stopless reasoning residue from final responses terminal payload after finish_reason stop closeout', async () => {
    isolateSessionDir('terminal-stop-reasoning-strip');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_terminal_strip_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '已完成。',
                '<rcc_stop_schema>{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"1","done_steps":"done","next_step":"无","next_suggested_path":"无","needs_user_input":false,"learned":"ok"}</rcc_stop_schema>'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessMetadataCenter({
        requestId: 'req_stop_terminal_strip_blackbox',
        sessionId: 'sess-stop-terminal-strip-blackbox',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any),
      requestId: 'req_stop_terminal_strip_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('terminal stop closeout must not reenter');
      }
    });

    expect(result.executed).toBe(true);
    const payload = result.chat as any;
    expect(payload.choices?.[0]?.finish_reason).toBe('stop');
    expect(String(payload.choices?.[0]?.message?.content)).toBe('已完成。');
    expect(payload.choices?.[0]?.message?.reasoning).toBeUndefined();
    expect(payload.choices?.[0]?.message?.reasoning_text).toBeUndefined();

    const responsesPayload = buildResponsesPayloadFromChatWithNative(payload, {
      requestId: 'req_stop_terminal_strip_blackbox'
    }) as Record<string, any>;
    expect(Array.isArray(responsesPayload.output)).toBe(true);
    expect(responsesPayload.output.some((item: any) => item?.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(responsesPayload)).not.toContain('reasoning_summary');
    expect(JSON.stringify(responsesPayload)).not.toContain('<rcc_stop_schema>');
    expect(JSON.stringify(responsesPayload)).not.toContain('stopreason');
    expect(String(responsesPayload.output_text)).toBe('已完成。');
  });

  it('does not let malformed legacy CLI history suppress current stopless re-projection', async () => {
    isolateSessionDir('legacy-shape');
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_after_legacy_cli_result',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'stopless continuation ready'
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: bindStoplessLoopState({
        sessionId: 'sess-stop-cli-legacy-shape-reproject',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __raw_request_body: {
          model: 'gpt-5.5',
          input: [
            { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] },
            {
              type: 'function_call',
              call_id: 'call_servertool_cli_stop_legacy_1',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: "routecodex servertool run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3}'"
              })
            },
            {
              type: 'function_call_output',
              call_id: 'call_servertool_cli_stop_legacy_1',
              output: '{"ok":true,"kind":"stop_message_auto","tool":"stop_message_auto","summary":"stopless continuation ready"}'
            }
          ]
        }
      } as any, {
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行原任务'
      }),
      requestId: 'req_stop_cli_legacy_shape_guard',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stop_message_auto CLI projection must not reenter server-side followup');
      }
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe('exec_command');
    const command = JSON.parse(toolCall.function.arguments).cmd;
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(command).not.toContain('stop_message_auto');
  });

});
