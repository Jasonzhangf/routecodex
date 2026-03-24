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

  it('returns stream and records payload when streaming is enabled', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'chatcmpl_stream',
      object: 'chat.completion',
      created: 1730000000,
      model: 'qwen3.5-plus',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'stream ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: 'openai-chat',
      requestId: 'req-test-stream',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    const recorded = recorder.entries[0];
    expect(recorded.stage).toBe('chat_process.resp.stage10.sse_stream');
    expect(recorded.payload).toEqual({
      passthrough: false,
      protocol: 'openai-chat',
      payload: clientPayload
    });
  });

  it('supports gemini-chat streaming path', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'gemini_resp_stream',
      object: 'response',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'gemini stream ok' }]
          }
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: 'gemini-chat',
      requestId: 'req-gemini-stream',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'gemini-chat',
      payload: clientPayload
    });
  });

  it('returns body for gemini-chat when wantsStream=false', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'gemini_resp_non_stream',
      object: 'response',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'gemini non-stream ok' }]
          }
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: 'gemini-chat',
      requestId: 'req-gemini-non-stream',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'gemini-chat',
      payload: clientPayload
    });
  });

  it('normalizes protocol token before streaming decision and codec lookup', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'gemini_resp_stream_normalized',
      object: 'response',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'gemini normalized protocol stream ok' }]
          }
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' GEMINI-CHAT ' as any,
      requestId: 'req-gemini-stream-normalized-protocol',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'gemini-chat',
      payload: clientPayload
    });
  });

  it('normalizes openai-chat protocol token before streaming decision and codec lookup', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'chatcmpl_stream_normalized',
      object: 'chat.completion',
      created: 1730000001,
      model: 'qwen3.5-plus',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'openai chat normalized protocol stream ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' OPENAI-CHAT ' as any,
      requestId: 'req-openai-chat-stream-normalized-protocol',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'openai-chat',
      payload: clientPayload
    });
  });

  it('normalizes openai-responses protocol token before streaming decision and codec lookup', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'resp_stream_normalized',
      object: 'response',
      model: 'gpt-5.3-codex',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'responses normalized protocol stream ok' }]
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' OPENAI-RESPONSES ' as any,
      requestId: 'req-openai-responses-stream-normalized-protocol',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'openai-responses',
      payload: clientPayload
    });
  });

  it('normalizes anthropic-messages protocol token before streaming decision and codec lookup', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'msg_stream_normalized',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-7-sonnet-20250219',
      content: [
        {
          type: 'text',
          text: 'anthropic normalized protocol stream ok'
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' ANTHROPIC-MESSAGES ' as any,
      requestId: 'req-anthropic-messages-stream-normalized-protocol',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'anthropic-messages',
      payload: clientPayload
    });
  });

  it('normalizes openai-responses protocol token in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'resp_non_stream_normalized',
      object: 'response',
      model: 'gpt-5.3-codex',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'responses normalized protocol non-stream ok' }]
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' OPENAI-RESPONSES ' as any,
      requestId: 'req-openai-responses-non-stream-normalized-protocol',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'openai-responses',
      payload: clientPayload
    });
  });
});
