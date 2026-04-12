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
    expect(result.governedPayload.choices?.[0]?.message?.content ?? '').toBe('');

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
  });
  it('drops harvested tool calls when the name is outside the current request tool list', async () => {
    const outputText = [
      '<function_calls>```bash',
      'pwd',
      '```</function_calls>',
      '保留正文'
    ].join('\n');

    const result = await runRespProcessStage1ToolGovernance({
      payload: {
        object: 'response',
        id: 'resp_stage1_wrapper_allowlist',
        model: 'gpt-test',
        status: 'completed',
        output_text: outputText,
        output: []
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage1-wrapper-allowlist',
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
                  properties: {
                    patch: { type: 'string' }
                  },
                  required: ['patch'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    });

    expect(result.governedPayload.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(0);
    expect(result.governedPayload.choices?.[0]?.finish_reason).toBe('stop');
    expect(String(result.governedPayload.choices?.[0]?.message?.content ?? '')).toContain('保留正文');
  });
});
