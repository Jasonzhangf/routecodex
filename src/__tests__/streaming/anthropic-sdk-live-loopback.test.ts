import fs from 'fs';
import { Readable } from 'stream';
import { aggregateAnthropicSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-messages-sse-to-json.js';
import { createAnthropicSSEStreamFromAnthropicJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-json-to-sse.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readGLMAnthropicConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm-anthropic/config.json';
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const prov = j?.virtualrouter?.providers?.['glm-anthropic'];
    const baseURL = prov?.baseURL;
    const apiKey = prov?.auth?.apiKey || (Array.isArray(prov?.apiKey) ? prov.apiKey[0] : undefined);
    const model = j?.virtualrouter?.routing?.default?.[0]?.split('.')?.[1] || 'glm-4.6';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch { return null; }
}

function toReadable(text: string): Readable { const r = new Readable({ read() {} }); setImmediate(() => { r.push(text); r.push(null); }); return r; }
function canonContent(j: any) { const c = Array.isArray(j?.content) ? j.content : []; const pick = c.map((x: any) => x?.type === 'text' ? { type:'text', text:String(x?.text||'') } : (x?.type === 'tool_use' ? { type:'tool_use', name:x?.name, input: JSON.stringify(x?.input ?? {}) } : null)).filter(Boolean); return JSON.stringify(pick); }

describe('Anthropic SDK live loopback', () => {
  const cfg = readGLMAnthropicConfig();
  if (!cfg) {
    test('skip: missing glm-anthropic config', () => expect(true).toBe(true));
    return;
  }
  jest.setTimeout(90000);

  test('streaming roundtrip (text/tool_use canonical equivalence)', async () => {
    const url = `${cfg.baseURL.replace(/\/$/,'')}/messages`;
    const body = { model: cfg.model, max_tokens: 256, messages: [{ role: 'user', content: '请用中文问候，并调用 search 工具查询 hello' }], stream: true };
    const headers = { 'content-type':'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' } as any;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) } as any);
    if (!res.ok) {
      const t = await res.text();
      console.warn('[anthropic-live] upstream not ok:', res.status, t.slice(0,256));
      expect(true).toBe(true); // skip when upstream not available
      return;
    }
    const text = await res.text();
    const originJSON = await aggregateAnthropicSSEToJSON(toReadable(text));
    const sse = createAnthropicSSEStreamFromAnthropicJson(originJSON, { requestId: 'anth_live' });
    const text2 = await new Promise<string>((resolve) => { const arr: string[] = []; (sse as any).on('data', (c: any) => arr.push(String(c))); (sse as any).on('end', () => resolve(arr.join(''))); });
    const synthJSON = await aggregateAnthropicSSEToJSON(toReadable(text2));
    expect(canonContent(synthJSON)).toBe(canonContent(originJSON));
  });
});
