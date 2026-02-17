import { runRespProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js';

describe('chat_process response universal repair before tool governance', () => {
  it('does not infer tool calls from plain text markup', async () => {
    const payload = {
      id: 'chatcmpl-x',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content:
              '<invoke name="exec_command"><parameter name="cmd">pwd</parameter><parameter name="workdir">/tmp</parameter></invoke>'
          }
        }
      ]
    } as any;

    const result = await runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/responses',
      requestId: 'req_universal_repair_1',
      clientProtocol: 'openai-responses'
    });
    const choice = (result.governedPayload as any).choices[0];
    const message = choice.message;

    expect(message.tool_calls ?? []).toHaveLength(0);
    expect(choice.finish_reason).toBe('stop');
  });

  it('strips orphan closing tags before governance', async () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Done.\n</parameter>\n</function>\n</tool_call>'
          }
        }
      ]
    } as any;

    const result = await runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req_universal_repair_2',
      clientProtocol: 'openai-chat'
    });

    expect((result.governedPayload as any).choices[0].message.content).toBe('Done.');
  });
});
