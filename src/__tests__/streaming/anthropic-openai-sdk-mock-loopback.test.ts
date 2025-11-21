import { Readable } from 'stream';
import { createAnthropicSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-anthropic-sse.js';
import { aggregateAnthropicSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-messages-sse-to-json.js';
import { createAnthropicSSEStreamFromAnthropicJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-json-to-sse.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function toReadableFromStream(s: NodeJS.ReadableStream): Promise<Readable> {
  return new Promise((resolve) => {
    const arr: string[] = [];
    (s as any).on('data', (c: any) => arr.push(String(c)));
    (s as any).on('end', () => {
      const r = new Readable({ read() {} });
      setImmediate(() => { r.push(arr.join('')); r.push(null); });
      resolve(r);
    });
  });
}

describe('Anthropic mock loopback (origin SSE → aggregate → synth SSE → aggregate)', () => {
  test('text and tool_use', async () => {
    const chatJson = {
      id: 'chatcmpl_ANTH_LB',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [ { id: 'call_Y', type: 'function', function: { name: 'search', arguments: '{"q":"hi"}' } } ] } }]
    };
    // Origin SSE (from Chat JSON → Anthropic SSE)
    const originSSE = createAnthropicSSEStreamFromChatJson(chatJson, { requestId: 'anth_mock' });
    const originReadable = await toReadableFromStream(originSSE as any);
    const originJSON = await aggregateAnthropicSSEToJSON(originReadable);
    // Synth SSE from aggregated Anthropic JSON
    const synthSSE = createAnthropicSSEStreamFromAnthropicJson(originJSON, { requestId: 'anth_mock_2' });
    const synthReadable = await toReadableFromStream(synthSSE as any);
    const synthJSON = await aggregateAnthropicSSEToJSON(synthReadable);
    // Compare
    const t1 = JSON.stringify(originJSON?.content || []);
    const t2 = JSON.stringify(synthJSON?.content || []);
    expect(t2).toBe(t1);
  });
});

