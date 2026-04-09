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

  it('normalizes structured reasoning for openai-chat client outbound', () => {
    const clientPayload = runRespOutboundStage1ClientRemap({
      payload: {
        id: 'chatcmpl_reasoning_outbound',
        object: 'chat.completion',
        created: 1730000001,
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
              reasoning: {
                summary: [{ type: 'summary_text', text: '先确认目标' }],
                content: [{ type: 'reasoning_text', text: '再检查代码路径' }],
                encrypted_content: 'opaque-sig'
              }
            }
          }
        ]
      } as any,
      clientProtocol: 'openai-chat',
      requestId: 'req-openai-chat-reasoning'
    }) as any;

    const message = clientPayload?.choices?.[0]?.message;
    expect(message?.reasoning).toBe('再检查代码路径');
    expect(message?.reasoning_content).toBe('再检查代码路径');
    expect(Array.isArray(message?.reasoning_details)).toBe(true);
    expect(message?.reasoning_details).toEqual([
      { type: 'summary_text', text: '先确认目标' },
      { type: 'reasoning_text', text: '再检查代码路径' },
      { type: 'reasoning.encrypted_content', encrypted_content: 'opaque-sig' }
    ]);
    expect(clientPayload?.choices?.[0]?.finish_reason).toBe('stop');
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

  it('normalizes openai-responses protocol token with tabs/newlines in stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'resp_stream_normalized_tab_newline',
      object: 'response',
      model: 'gpt-5.3-codex',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'responses protocol with tab/newline stream ok' }]
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: '\tOPENAI-RESPONSES\n' as any,
      requestId: 'req-openai-responses-stream-normalized-tab-newline',
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

  it('normalizes openai-chat protocol token in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'chatcmpl_non_stream_normalized',
      object: 'chat.completion',
      created: 1730000002,
      model: 'qwen3.5-plus',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'openai chat normalized protocol non-stream ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' OPENAI-CHAT ' as any,
      requestId: 'req-openai-chat-non-stream-normalized-protocol',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'openai-chat',
      payload: clientPayload
    });
  });

  it('normalizes gemini-chat protocol token in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'gemini_resp_non_stream_normalized',
      object: 'response',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'gemini normalized protocol non-stream ok' }]
          }
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' GEMINI-CHAT ' as any,
      requestId: 'req-gemini-chat-non-stream-normalized-protocol',
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

  it('normalizes gemini-chat protocol token with tabs/newlines in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'gemini_resp_non_stream_normalized_tab_newline',
      object: 'response',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'gemini protocol with tab/newline non-stream ok' }]
          }
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: '\tGEMINI-CHAT\n' as any,
      requestId: 'req-gemini-chat-non-stream-normalized-tab-newline',
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

  it('keeps unknown protocol in non-stream path even when wantsStream=true', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'unknown_protocol_non_stream',
      object: 'response',
      model: 'custom-model',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'unknown protocol should stay non-stream' }]
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' UNKNOWN-PROTOCOL ' as any,
      requestId: 'req-unknown-protocol-non-stream',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: ' UNKNOWN-PROTOCOL ',
      payload: clientPayload
    });
  });

  it('keeps near-known protocol variant in non-stream path when wantsStream=true', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'near_known_protocol_non_stream',
      object: 'response',
      model: 'custom-model',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'near-known protocol variant should stay non-stream' }]
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' OPENAI-CHAT-PREVIEW ' as any,
      requestId: 'req-near-known-protocol-non-stream',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: ' OPENAI-CHAT-PREVIEW ',
      payload: clientPayload
    });
  });

  it('normalizes anthropic-messages protocol token in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'msg_non_stream_normalized',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-7-sonnet-20250219',
      content: [
        {
          type: 'text',
          text: 'anthropic normalized protocol non-stream ok'
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: ' ANTHROPIC-MESSAGES ' as any,
      requestId: 'req-anthropic-messages-non-stream-normalized-protocol',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'anthropic-messages',
      payload: clientPayload
    });
  });

  it('normalizes anthropic-messages protocol token with tabs/newlines in non-stream branch', async () => {
    const recorder = new StubStageRecorder();
    const clientPayload = {
      id: 'msg_non_stream_normalized_tab_newline',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-7-sonnet-20250219',
      content: [
        {
          type: 'text',
          text: 'anthropic protocol with tab/newline non-stream ok'
        }
      ]
    } as any;

    const result = await runRespOutboundStage2SseStream({
      clientPayload,
      clientProtocol: '\tANTHROPIC-MESSAGES\n' as any,
      requestId: 'req-anthropic-messages-non-stream-normalized-tab-newline',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body).toEqual(clientPayload);
    expect(result.stream).toBeUndefined();
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.payload).toEqual({
      passthrough: false,
      protocol: 'anthropic-messages',
      payload: clientPayload
    });
  });
});
