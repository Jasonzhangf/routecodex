import { describe, expect, it } from '@jest/globals';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';
import { runRespOutboundStage2SseStream } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage2_sse_stream/index.js';

class StubStageRecorder implements StageRecorder {
  public entries: Array<{ stage: string; payload: object }> = [];

  record(stage: string, payload: object): void {
    this.entries.push({ stage, payload });
  }
}

describe('resp_outbound stages snapshot payloads', () => {
  it('records anthropic remap payload including tool blocks', () => {
    const recorder = new StubStageRecorder();
    const chatResponse = {
      id: 'chatcmpl_test',
      model: 'glm-4.6',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '执行结果如下：',
            tool_calls: [
              {
                id: 'call_shell',
                type: 'function',
                function: {
                  name: 'shell_command',
                  arguments: '{"cmd":"ls"}'
                }
              }
            ]
          }
        }
      ]
    };

    runRespOutboundStage1ClientRemap({
      payload: chatResponse,
      clientProtocol: 'anthropic-messages',
      requestId: 'req-test',
      stageRecorder: recorder
    });

    expect(recorder.entries).toHaveLength(1);
    const recorded = recorder.entries[0];
    expect(recorded.stage).toBe('chat_process.resp.stage9.client_remap');
    const recordedPayload = recorded.payload as any;
    expect(recordedPayload.type).toBe('message');
    expect(recordedPayload.role).toBe('assistant');
    expect(Array.isArray(recordedPayload.content)).toBe(true);
    const toolUse = (recordedPayload.content as any[]).find((b) => b && b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse.id).toBe('call_shell');
    expect(toolUse.name).toBe('shell_command');
  });

  it('records final payload when streaming is disabled in SSE stage', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = { content: [{ type: 'text', text: 'ok' }] };

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: 'anthropic-messages',
      providerProtocol: 'anthropic-messages',
      requestId: 'req-test',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(recorder.entries).toHaveLength(1);
    const recorded = recorder.entries[0];
    expect(recorded.stage).toBe('chat_process.resp.stage10.sse_stream');
    expect(recorded.payload).toEqual({
      passthrough: false,
      protocol: 'anthropic-messages',
      payload: clientPayload
    });
  });
});
