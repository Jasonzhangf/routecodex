import { describe, it, expect } from '@jest/globals';
import { ChatSseToJsonConverter } from '../sse-to-json/chat-sse-to-json-converter.js';

function createStream(chunks: string[]): AsyncIterable<string> {
  return (async function* stream() {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

describe('ChatSseToJsonConverter deepseek-web patch stream compatibility', () => {
  it('reconstructs assistant content from deepseek patch SSE frames', async () => {
    const ssePayload = `event: ready
data: {"request_message_id":1,"response_message_id":2}

data: {"v":{"response":{"message_id":2,"status":"WIP","content":""}}}

data: {"p":"response/content","o":"APPEND","v":"{\\""}

data: {"v":"tool"}

data: {"v":"_calls"}

data: {"v":"\\":["}

data: {"v":"{\\"name\\":\\"continue_execution\\",\\"input\\":{}}"}

data: {"v":"]}"}

data: {"p":"response/accumulated_token_usage","o":"SET","v":690}

data: {"p":"response/status","v":"FINISHED"}

event: finish
data: {}
`;

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(createStream([ssePayload]), {
      requestId: 'req_deepseek_patch',
      model: 'deepseek-chat'
    });

    expect(response.model).toBe('deepseek-chat');
    expect(response.choices).toHaveLength(1);
    expect(response.choices?.[0]?.finish_reason).toBe('stop');
    expect(response.choices?.[0]?.message?.content).toContain(
      '{"tool_calls":[{"name":"continue_execution","input":{}}]}'
    );
  });

  it('handles multi-line data frames without dropping deepseek patch chunks', async () => {
    const ssePayload = `data: {"v":{"response":{"message_id":2,"status":"WIP","content":""}}}

data: {"p":"response/content","o":"APPEND","v":"{\\""}
data: {"v":"tool_calls\\":[{\\"name\\":\\"continue_execution\\",\\"input\\":{}}]}"}

data: {"p":"response/status","v":"FINISHED"}

event: finish
data: {}
`;

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(createStream([ssePayload]), {
      requestId: 'req_deepseek_patch_multiline_data',
      model: 'deepseek-chat'
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices?.[0]?.finish_reason).toBe('stop');
    expect(response.choices?.[0]?.message?.content).toContain(
      '{"tool_calls":[{"name":"continue_execution","input":{}}]}'
    );
  });

  it('reconstructs reasoning_content from deepseek thinking patch frames', async () => {
    const ssePayload = `event: ready
data: {"request_message_id":1,"response_message_id":2}

data: {"v":{"response":{"message_id":2,"status":"WIP","content":"","thinking_content":""}}}

data: {"p":"response/thinking_content","o":"APPEND","v":"<tool_call>\\n"}

data: {"v":"{\\"name\\":\\"exec_command\\",\\"arguments\\":{\\"cmd\\":\\"bash -lc 'pwd'\\"}}"}

data: {"v":"\\n</tool_call>"}

data: {"p":"response/status","v":"FINISHED"}

event: finish
data: {}
`;

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(createStream([ssePayload]), {
      requestId: 'req_deepseek_thinking_patch',
      model: 'deepseek-chat'
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices?.[0]?.finish_reason).toBe('stop');
    expect(response.choices?.[0]?.message?.content ?? '').toBe('');
    expect(response.choices?.[0]?.message?.reasoning_content).toContain('<tool_call>');
    expect(response.choices?.[0]?.message?.reasoning_content).toContain('"name":"exec_command"');
  });

  it('classifies deepseek toast context-length errors as stream errors instead of patch text', async () => {
    const ssePayload = `event: toast
data: {"type":"error","message":"达到对话长度上限，请开启新对话","finish_reason":"context_length_exceeded"}

event: finish
data: {}
`;

    const converter = new ChatSseToJsonConverter();
    await expect(
      converter.convertSseToJson(createStream([ssePayload]), {
        requestId: 'req_deepseek_toast_ctx_limit',
        model: 'deepseek-chat'
      })
    ).rejects.toMatchObject({
      code: 'CHAT_STREAM_ERROR',
      context: expect.objectContaining({
        errorData: expect.objectContaining({
          finish_reason: 'context_length_exceeded'
        })
      })
    });
  });

  it('classifies nested deepseek patch failure payloads as context-length errors', async () => {
    const ssePayload = `data: {"v":{"response":{"message_id":2,"status":"FAILED","error":{"code":"context_length_exceeded","message":"达到对话长度上限，请开启新对话"}}}}

event: finish
data: {}
`;

    const converter = new ChatSseToJsonConverter();
    await expect(
      converter.convertSseToJson(createStream([ssePayload]), {
        requestId: 'req_deepseek_patch_ctx_limit',
        model: 'deepseek-chat'
      })
    ).rejects.toMatchObject({
      code: 'CHAT_STREAM_ERROR',
      context: expect.objectContaining({
        errorData: expect.objectContaining({
          finish_reason: 'context_length_exceeded'
        })
      })
    });
  });

  it('salvages deepseek-web patch content when upstream terminates after partial content', async () => {
    async function* terminatedPatchStream() {
      yield `event: ready
data: {"request_message_id":1,"response_message_id":2}

data: {"v":{"response":{"message_id":2,"status":"WIP","content":""}}}

data: {"p":"response/content","o":"APPEND","v":"hello "}

data: {"v":"world"}

`;
      throw Object.assign(new Error('terminated'), { code: 'TERMINATED' });
    }

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(terminatedPatchStream(), {
      requestId: 'req_deepseek_patch_terminated_salvage',
      model: 'deepseek-chat'
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices?.[0]?.finish_reason).toBe('stop');
    expect(response.choices?.[0]?.message?.content).toContain('hello world');
  });
});
