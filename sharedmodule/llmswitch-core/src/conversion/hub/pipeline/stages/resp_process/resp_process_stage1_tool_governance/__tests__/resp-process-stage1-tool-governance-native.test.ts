import { describe, expect, it } from '@jest/globals';

import { runRespProcessStage1ToolGovernance } from '../index.js';

function createStageRecorder(target: Array<{ stage: string; payload: Record<string, unknown> }>) {
  return {
    record(stage: string, payload: object) {
      target.push({ stage, payload: payload as Record<string, unknown> });
    }
  };
}

describe('resp-process-stage1-tool-governance native wrapper', () => {
  it('normalizes non-canonical responses payload and harvests text tool calls before governance', async () => {
    const stageRecords: Array<{ stage: string; payload: Record<string, unknown> }> = [];

    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp_stage1_wrapper',
        model: 'gpt-test',
        status: 'completed',
        output_text: '<function_calls>```bash\npwd\n```</function_calls>',
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-wrapper',
      clientProtocol: 'openai-responses',
      stageRecorder: createStageRecorder(stageRecords)
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    expect(result.governedPayload.choices?.[0]?.message?.content).toBe('');

    const canonicalizeRecord = stageRecords.find(
      (entry) => entry.stage === 'chat_process.resp.stage6.canonicalize_chat_completion'
    );
    expect(canonicalizeRecord?.payload).toMatchObject({
      converted: true,
      shapeSanitized: true,
      harvestedToolCalls: 1
    });
    expect(
      (canonicalizeRecord?.payload.canonicalPayload as any)?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name
    ).toBe('exec_command');
    expect(
      (canonicalizeRecord?.payload.canonicalPayload as any)?.choices?.[0]?.message?.tool_calls?.[0]?.id
    ).toBe('call_1');
    expect(
      (canonicalizeRecord?.payload.canonicalPayload as any)?.choices?.[0]?.message?.tool_calls?.[0]?.call_id
    ).toBe('call_1');
  });
});
