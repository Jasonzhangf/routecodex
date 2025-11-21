import { Readable } from 'stream';
import { createAnthropicSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-anthropic-sse.js';
import { aggregateAnthropicSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-messages-sse-to-json.js';

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

describe('Anthropic SSE aggregate → JSON', () => {
  test('text branch', async () => {
    const chatJson = { id: 'chatcmpl_ANT1', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: '你好，Claude' } }] };
    const sse = createAnthropicSSEStreamFromChatJson(chatJson, { requestId: 'anth_text' });
    const readable = await toReadableFromStream(sse as any);
    const aggregated = await aggregateAnthropicSSEToJSON(readable);
    const txt = aggregated?.content?.find((c: any) => c?.type === 'text')?.text || '';
    expect(txt.includes('Claude')).toBe(true);
  });

  test('tool branch', async () => {
    const chatJson = { id: 'chatcmpl_ANT2', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'search', arguments: '{"q":"hi"}' } }] } }] };
    const sse = createAnthropicSSEStreamFromChatJson(chatJson, { requestId: 'anth_tool' });
    const readable = await toReadableFromStream(sse as any);
    const aggregated = await aggregateAnthropicSSEToJSON(readable);
    const tool = aggregated?.content?.find((c: any) => c?.type === 'tool_use');
    expect(tool?.name).toBe('search');
    const inputStr = typeof tool?.input === 'string' ? tool?.input : JSON.stringify(tool?.input);
    expect(inputStr.includes('hi')).toBe(true);
  });
});

