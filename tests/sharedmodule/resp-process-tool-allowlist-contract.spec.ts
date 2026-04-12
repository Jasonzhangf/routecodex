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
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '{"tool_calls":[{"name":"shell_command","input":{"command":"pwd"}}]}',
              tool_calls: []
            }
          }
        ]
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-allowlist-keep-1',
      clientProtocol: 'openai-chat',
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
    expect(JSON.parse(String(choice?.message?.tool_calls?.[0]?.function?.arguments || '{}')).cmd).toBe('pwd');
  });
});
