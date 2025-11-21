import { Readable } from 'stream';
import { createResponsesSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-responses-sse.js';
import { aggregateOpenAIResponsesSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function toReadableFromStream(s: NodeJS.ReadableStream): Promise<Readable> {
  return new Promise((resolve) => {
    const pt = new Readable({ read() {} });
    const arr: string[] = [];
    (s as any).on('data', (c: any) => arr.push(String(c)));
    (s as any).on('end', () => {
      const r = new Readable({ read() {} });
      setImmediate(() => { r.push(arr.join('')); r.push(null); });
      resolve(r);
    });
  });
}

describe('Responses SSE aggregate → JSON', () => {
  test('text branch', async () => {
    const chatJson = {
      id: 'chatcmpl_RESP1',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好，Responses' } }]
    };
    const sse = createResponsesSSEStreamFromChatJson(chatJson, { requestId: 'resp_text' });
    const readable = await toReadableFromStream(sse as any);
    const aggregated = await aggregateOpenAIResponsesSSEToJSON(readable);
    const outputs = aggregated?.output || [];
    const msg = outputs.find((o: any) => o?.type === 'message');
    const text = msg?.content?.[0]?.text || '';
    expect(text.includes('Responses')).toBe(true);
  });

  test('tool branch', async () => {
    const chatJson = {
      id: 'chatcmpl_RESP2',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_X', type: 'function', function: { name: 'search', arguments: '{"q":"hello"}' } }] } }]
    };
    const sse = createResponsesSSEStreamFromChatJson(chatJson, { requestId: 'resp_tool' });
    const readable = await toReadableFromStream(sse as any);
    const aggregated = await aggregateOpenAIResponsesSSEToJSON(readable);
    const outputs = aggregated?.output || [];
    const fn = outputs.find((o: any) => o?.type === 'function_call');
    expect(fn?.name).toBe('search');
    expect(fn?.arguments).toBe('{"q":"hello"}');
  });
});

