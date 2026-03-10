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
});
