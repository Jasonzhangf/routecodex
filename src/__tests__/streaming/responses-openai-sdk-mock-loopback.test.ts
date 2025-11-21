import { Readable } from 'stream';
import { createResponsesSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-responses-sse.js';
import { aggregateOpenAIResponsesSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.js';
import { createResponsesSSEStreamFromResponsesJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/responses-json-to-sse.js';

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

describe('Responses mock loopback (origin SSE → aggregate → synth SSE → aggregate)', () => {
  test('text and tool_calls', async () => {
    const chatJson = {
      id: 'chatcmpl_RESP_LB',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: [ { type: 'text', text: '你好，Responses' } ], tool_calls: [ { id: 'call_X', type: 'function', function: { name: 'search', arguments: '{"q":"hello"}' } } ] } }]
    };
    // Origin (mock) SSE
    const originSSE = createResponsesSSEStreamFromChatJson(chatJson, { requestId: 'resp_mock' });
    const originReadable = await toReadableFromStream(originSSE as any);
    const originJSON = await aggregateOpenAIResponsesSSEToJSON(originReadable);
    // Synth SSE from aggregated JSON
    const synthSSE = createResponsesSSEStreamFromResponsesJson(originJSON, { requestId: 'resp_mock_2' });
    const synthReadable = await toReadableFromStream(synthSSE as any);
    const synthJSON = await aggregateOpenAIResponsesSSEToJSON(synthReadable);
    // Compare
    const canonFns = (j: any) => {
      const out = Array.isArray(j?.output) ? j.output : [];
      const fns = out.filter((o: any) => o?.type === 'function_call').map((o: any) => ({ name: o?.name, args: o?.arguments }));
      // 去重
      const seen = new Set<string>();
      const uniq = [] as Array<{name:string;args:string}>;
      for (const f of fns) { const k = `${f.name}|${f.args}`; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
      return uniq.sort((a,b) => (a.name+a.args).localeCompare(b.name+b.args));
    };
    const canonText = (j: any) => {
      try {
        const out = Array.isArray(j?.output) ? j.output : [];
        const msg = out.find((o: any) => o?.type === 'message');
        const parts = Array.isArray(msg?.content) ? msg.content : [];
        const txt = parts.find((p: any) => p?.type === 'output_text');
        return String(txt?.text || '');
      } catch { return ''; }
    };
    expect(canonText(synthJSON)).toBe(canonText(originJSON));
    expect(JSON.stringify(canonFns(synthJSON))).toBe(JSON.stringify(canonFns(originJSON)));
  });
});
