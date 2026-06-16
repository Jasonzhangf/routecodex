import { runServerToolOrchestration } from '../../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { buildResponsesPayloadFromChatWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import fs from 'node:fs';
import path from 'node:path';

function extractCommandInput(command: string): Record<string, unknown> {
  const match = command.match(/--input-json '([^']+)'(?=\s--session-id|\s--request-id|$)/);
  return match ? JSON.parse(match[1]) as Record<string, unknown> : {};
}

function isolateSessionDir(label: string): void {
  const dir = path.join(process.cwd(), '.tmp', 'jest-servertool-blackbox', `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.ROUTECODEX_SESSION_DIR = dir;
}

describe('servertool CLI projection blackbox', () => {
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
      adapterContext: { sessionId: 'sess-blackbox' } as any,
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
    expect(command).toContain("--session-id 'sess-blackbox'");
    expect(command).toContain("--request-id 'req_servertool_blackbox'");
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
      adapterContext: {
        sessionId: 'sess-stop-cli-lifecycle',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: {
          stopMessageState: {
            stopMessageText: '继续执行原任务',
            stopMessageMaxRepeats: 3,
            stopMessageUsed: 1,
            stopMessageStageMode: 'on'
          }
        }
      } as any,
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
    expect(command).not.toMatch(/Stop schema|stop schema|stopreason/);
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('继续执行');
    for (const forbidden of [
      'schema',
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
    expect(input.repeatCount).toBeGreaterThanOrEqual(0);
    expect(input.maxRepeats).toBeGreaterThanOrEqual(1);

    const responsesPayload = buildResponsesPayloadFromChatWithNative(result.chat as any, {
      requestId: 'req_stop_cli_lifecycle'
    }) as Record<string, any>;
    const reasoning = responsesPayload.output.find((item: any) => item.type === 'reasoning');
    expect(reasoning?.summary?.[0]?.type).toBe('summary_text');
    expect(reasoning?.summary?.[0]?.text).toContain('阶段完成');
    expect(reasoning?.content).toBeUndefined();
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
      adapterContext: {
        sessionId: 'sess-stop-cli-loop-guard-resume-reproject',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: {
          stopMessageState: {
            stopMessageText: '继续执行原任务',
            stopMessageMaxRepeats: 3,
            stopMessageUsed: 1,
            stopMessageStageMode: 'on'
          }
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
      } as any,
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
    expect(command).toContain('routecodex hook run stop_message_auto');
    expect(extractCommandInput(command).repeatCount).toBe(2);
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
                '{"stopreason":0,"reason":"已完成 allow-stop live 验证","has_evidence":1,"evidence":"5555 live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round allow stop","done_steps":"allow-stop response","next_step":"","next_suggested_path":"","learned":"summary must be markdown"}'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext: {
        sessionId: 'sess-stop-cli-allow-stop-terminal',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: {
          stopMessageState: {
            stopMessageText: '继续执行原任务',
            stopMessageMaxRepeats: 3,
            stopMessageUsed: 0,
            stopMessageStageMode: 'on'
          }
        }
      } as any,
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
    expect(String(message?.content)).toContain('## 完成内容');
    expect(String(message?.content)).not.toContain('"stopreason"');
    expect(message?.reasoning_text).toBeUndefined();
    expect(message?.reasoning_content).toBeUndefined();
    expect(message?.reasoning).toBeUndefined();

    const responsesPayload = buildResponsesPayloadFromChatWithNative(payload, {
      requestId: 'req_stop_cli_allow_stop_terminal'
    }) as Record<string, any>;
    expect(Array.isArray(responsesPayload.output)).toBe(true);
    expect(responsesPayload.output.some((item: any) => item?.type === 'reasoning')).toBe(false);
    expect(String(responsesPayload.output_text)).toContain('## 完成内容');
    expect(JSON.stringify(responsesPayload)).not.toContain('stopreason');
    expect(JSON.stringify(responsesPayload)).not.toContain('needs_user_input');
    expect(JSON.stringify(responsesPayload)).not.toContain('has_evidence');
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
      adapterContext: {
        sessionId: 'sess-stop-cli-legacy-shape-reproject',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: {
          stopMessageState: {
            stopMessageText: '继续执行原任务',
            stopMessageMaxRepeats: 3,
            stopMessageUsed: 1,
            stopMessageStageMode: 'on'
          }
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
      } as any,
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
    expect(JSON.parse(toolCall.function.arguments).cmd).toContain('routecodex hook run stop_message_auto');
  });
});
