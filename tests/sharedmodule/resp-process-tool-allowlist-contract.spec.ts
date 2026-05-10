import { runRespProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js';

describe('resp_process_stage1_tool_governance: request tool allowlist contract', () => {
  it('drops harvested undeclared tool calls and preserves text for responses payloads', async () => {
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp_allowlist_drop_1',
        model: 'gpt-test',
        status: 'completed',
        output_text:
          '<function_calls>{"tool_calls":[{"name":"view_file","input":{"path":"/tmp/a.txt"}}]}</function_calls>\n保留正文',
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-allowlist-drop-1',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                parameters: {
                  type: 'object',
                  properties: { patch: { type: 'string' } },
                  required: ['patch'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    const choice = (result.governedPayload as any).choices?.[0];
    expect(choice?.finish_reason).toBe('stop');
    expect(choice?.message?.tool_calls ?? []).toHaveLength(0);
    expect(String((result.governedPayload as any).__responses_output_text_meta?.value ?? '')).toContain('view_file');
    expect(String((result.governedPayload as any).__responses_output_text_meta?.value ?? '')).toContain('保留正文');
  });

  it('keeps normalized shell aliases when exec_command is declared', async () => {
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp-allowlist-keep-1',
        model: 'gpt-test',
        status: 'completed',
        output_text:
          '<function_calls>{"tool_calls":[{"name":"shell_command","input":{"command":"pwd"}}]}</function_calls>',
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-allowlist-keep-1',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                parameters: {
                  type: 'object',
                  properties: { cmd: { type: 'string' } },
                  required: ['cmd'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    const choice = (result.governedPayload as any).choices?.[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message?.tool_calls ?? []).toHaveLength(1);
    expect(choice?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(choice?.message?.tool_calls?.[0]?.function?.arguments || '{}'));
    // console.log(JSON.stringify(args));
    expect(args.cmd ?? args.command).toBe('pwd');
  });

  it('harvests request_user_input tool calls when declared and preserves nested question shape', async () => {
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp-allowlist-request-user-input-1',
        model: 'gpt-test',
        status: 'completed',
        output_text:
          '<function_calls>{"tool_calls":[{"name":"request_user_input","input":{"questions":[{"header":"Mode","id":"mode","question":"Pick one","options":[{"label":"A","description":"use mode A"},{"label":"B","description":"use mode B"}]}]}}]}</function_calls>',
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-allowlist-request-user-input-1',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'request_user_input',
                parameters: {
                  type: 'object',
                  properties: {
                    questions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          header: { type: 'string' },
                          question: { type: 'string' },
                          options: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string' },
                                description: { type: 'string' }
                              },
                              required: ['label', 'description'],
                              additionalProperties: false
                            }
                          }
                        },
                        required: ['id', 'header', 'question', 'options'],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ['questions'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    const choice = (result.governedPayload as any).choices?.[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message?.tool_calls ?? []).toHaveLength(1);
    expect(choice?.message?.tool_calls?.[0]?.function?.name).toBe('request_user_input');
    const args = JSON.parse(String(choice?.message?.tool_calls?.[0]?.function?.arguments || '{}'));
    expect(args.questions?.[0]?.id).toBe('mode');
    expect(args.questions?.[0]?.header).toBe('Mode');
    expect(args.questions?.[0]?.question).toBe('Pick one');
    expect(args.questions?.[0]?.options?.[0]?.label).toBe('A');
    expect(args.questions?.[0]?.options?.[0]?.description).toBe('use mode A');
  });

  it('drops harvested request_user_input calls when not declared and preserves original text', async () => {
    const rawContent =
      '<function_calls>{"tool_calls":[{"name":"request_user_input","input":{"questions":[{"header":"Mode","id":"mode","question":"Pick one","options":[{"label":"A","description":"use mode A"},{"label":"B","description":"use mode B"}]}]}}]}</function_calls>\n保留正文';
    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp-allowlist-request-user-input-drop-1',
        model: 'gpt-test',
        status: 'completed',
        output_text: rawContent,
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-allowlist-request-user-input-drop-1',
      clientProtocol: 'openai-responses',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                parameters: {
                  type: 'object',
                  properties: { cmd: { type: 'string' } },
                  required: ['cmd'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    const choice = (result.governedPayload as any).choices?.[0];
    expect(choice?.finish_reason).toBe('stop');
    expect(choice?.message?.tool_calls ?? []).toHaveLength(0);
    expect(String((result.governedPayload as any).__responses_output_text_meta?.value ?? '')).toContain('request_user_input');
    expect(String((result.governedPayload as any).__responses_output_text_meta?.value ?? '')).toContain('保留正文');
  });
});
