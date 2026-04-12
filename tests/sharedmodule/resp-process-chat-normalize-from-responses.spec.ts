import { runRespProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js';

describe('resp_process_stage1_tool_governance: canonical chat invariant', () => {
  it('coerces OpenAI Responses-shaped payload into chat before tool text harvesting', async () => {
    const responsesLike: any = {
      id: 'resp_test_1',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: 'test-model',
      status: 'completed',
      output: [],
      output_text: `
tool:exec_command (tool:exec_command)
  <command>which flutter</command>
  <timeout_ms>10000</timeout_ms>
  </tool:exec_command>
      `.trim()
    };

    const result = await runRespProcessStage1ToolGovernance({
      payload: responsesLike,
      entryEndpoint: '/v1/responses',
      requestId: 'req_test_resp_process_normalize',
      clientProtocol: 'openai-responses'
    });

    const governed: any = result.governedPayload;
    expect(governed).toBeDefined();
    expect(Array.isArray(governed.choices)).toBe(true);
    expect(governed.choices.length).toBeGreaterThan(0);

    const msg = governed.choices[0]?.message;
    expect(msg).toBeDefined();

    expect(Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0).toBe(1);
    expect(msg?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    expect(JSON.parse(String(msg?.tool_calls?.[0]?.function?.arguments || '{}')).cmd).toBe('which flutter');
    expect(msg.content).toBeNull();
    expect(governed.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests JSON tool_calls wrapper when upstream emits empty tool_calls array', async () => {
    const payload: any = {
      id: 'chat_test_empty_tool_calls',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}},{"name":"shell_command","input":{"command":"bd --no-db list --status in_progress"}}]}',
            tool_calls: []
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/messages',
      requestId: 'req_test_empty_tool_calls_json_wrapper',
      clientProtocol: 'anthropic-messages'
    });

    const governed: any = result.governedPayload;
    const calls = Array.isArray(governed?.choices?.[0]?.message?.tool_calls) ? governed.choices[0].message.tool_calls : [];
    expect(calls.length).toBe(2);
    expect(calls[0]?.function?.name).toBe('exec_command');
    expect(calls[1]?.function?.name).toBe('exec_command');
    expect(JSON.parse(String(calls[0]?.function?.arguments || '{}')).cmd).toBe('bd --no-db ready');
    expect(JSON.parse(String(calls[1]?.function?.arguments || '{}')).cmd).toBe('bd --no-db list --status in_progress');
    expect(governed?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('does not duplicate apply_patch when content echoes tool_calls JSON beside structured tool_calls', async () => {
    const payload: any = {
      id: 'chat_test_apply_patch_no_duplicate',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'qwen3.6-plus',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '{"tool_calls":[{"name":"apply_patch","input":{"patch":"*** Begin Patch\\n*** Add File:hello.txt\\n+hello\\n*** EndPatch"}}]}',
            tool_calls: [
              {
                id: 'reasoning_choice_1_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments:
                    '{"input":"*** Begin Patch\\n*** Add File: hello.txt\\n+hello\\n+*** EndPatch\\n*** End Patch","patch":"*** Begin Patch\\n*** Add File: hello.txt\\n+hello\\n+*** EndPatch\\n*** End Patch"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const result = await runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/responses',
      requestId: 'req_test_apply_patch_no_duplicate',
      clientProtocol: 'openai-responses'
    });

    const governed: any = result.governedPayload;
    const calls = Array.isArray(governed?.choices?.[0]?.message?.tool_calls) ? governed.choices[0].message.tool_calls : [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe('apply_patch');
  });

  it('harvests reasoning_content native tool call without [思考] wrapper and strips time tag noise', async () => {
    const payload: any = {
      id: 'chat_test_reasoning_native_tool',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'glm-5',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            reasoning_content: [
              '[Time/Date]: utc=`2026-03-10T12:19:19.410Z` local=`2026-03-10 20:19:19.410 +08:00` tz=`Asia/Shanghai` nowMs=`1773145159410` ntpOffsetMs=`33`',
              'exec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>'
            ].join('\n')
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/responses',
      requestId: 'req_test_reasoning_native_tool',
      clientProtocol: 'openai-responses'
    });

    const governed: any = result.governedPayload;
    const choice = governed?.choices?.[0];
    expect(choice?.message?.tool_calls).toHaveLength(1);
    expect(choice?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    expect(choice?.message?.reasoning_content).toBeUndefined();
    expect(choice?.finish_reason).toBe('tool_calls');
  });
});
