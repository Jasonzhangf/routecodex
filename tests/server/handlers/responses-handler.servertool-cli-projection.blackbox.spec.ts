import { runServerToolOrchestration } from '../../../sharedmodule/llmswitch-core/src/servertool/engine.js';

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
    expect(command).toBe("routecodex servertool run servertool_fixture --input-json '{\"value\":1}'");
    expect(command).not.toContain(['--', 'tic', 'ket'].join(''));
    expect(command).not.toContain(['st', 'cli_'].join(''));
    expect(command).not.toContain(['rcc', '_cli_'].join(''));
  });

  it('projects stopless CLI input with continuation prompt and repeat counters', async () => {
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stop_projection_lifecycle',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
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
    const match = command.match(/--input-json '(.+)'$/);
    expect(match).toBeTruthy();
    const input = JSON.parse(match?.[1] ?? '{}');
    expect(input.flowId).toBe('stop_message_flow');
    expect(input.continuationPrompt).toContain('继续执行');
    expect(input.repeatCount).toBeGreaterThanOrEqual(1);
    expect(input.maxRepeats).toBeGreaterThanOrEqual(1);
  });

  it('does not re-project stop_message_auto after its exec_command output is already in request history', async () => {
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
        sessionId: 'sess-stop-cli-loop-guard',
        routecodexPortStopMessageEnabled: true,
        stopMessageEnabled: true,
        __raw_request_body: {
          model: 'gpt-5.5',
          input: [
            { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] },
            {
              type: 'function_call',
              call_id: 'call_servertool_cli_stop_1',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: "routecodex servertool run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"stdoutPreview\":\"stopless continuation ready\"}'"
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
        throw new Error('stop_message_auto CLI result must not trigger followup reentry');
      }
    });

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(JSON.stringify(result.chat)).not.toContain('routecodex servertool run stop_message_auto');
    expect(JSON.stringify(result.chat)).not.toContain('call_servertool_cli_');
  });
});
