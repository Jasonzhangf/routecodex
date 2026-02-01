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

    // NOTE: response tool filters are strict and do not "repair" text markup into tool_calls.
    // Text tool markup should remain visible for debugging instead of being silently upgraded.
    expect(typeof msg.content).toBe('string');
    expect(String(msg.content)).toContain('tool:exec_command');
    expect(Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0).toBe(0);
  });
});
