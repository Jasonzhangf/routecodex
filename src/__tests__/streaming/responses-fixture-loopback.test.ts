import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { aggregateOpenAIResponsesSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.js';
import { createResponsesSSEStreamFromResponsesJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/responses-json-to-sse.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function toReadable(text: string): Readable {
  const r = new Readable({ read() {} });
  setImmediate(() => { r.push(text); r.push(null); });
  return r;
}

function canonFns(j: any) {
  const out = Array.isArray(j?.output) ? j.output : [];
  const fns = out.filter((o: any) => o?.type === 'function_call').map((o: any) => ({ name: o?.name, args: o?.arguments }));
  const seen = new Set<string>();
  const uniq: Array<{ name: string; args: string }> = [];
  for (const f of fns) { const k = `${f.name}|${f.args}`; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
  return uniq.sort((a,b) => (a.name+a.args).localeCompare(b.name+b.args));
}

function canonText(j: any) {
  try {
    const out = Array.isArray(j?.output) ? j.output : [];
    const msg = out.find((o: any) => o?.type === 'message');
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    const txt = parts.find((p: any) => p?.type === 'output_text');
    return String(txt?.text || '');
  } catch { return ''; }
}

describe('Responses fixture loopback (SSE file → aggregate → synth SSE → aggregate)', () => {
  const fixturesDir = path.join(process.cwd(), 'src', '__tests__', 'fixtures', 'responses-sse');
  const files = fs.existsSync(fixturesDir) ? fs.readdirSync(fixturesDir).filter(f => f.endsWith('.sse')) : [];

  if (files.length === 0) {
    test('no fixtures found; skipping Responses fixture loopback suite', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const fname of files) {
    test(`loopback ${fname}`, async () => {
      const full = path.join(fixturesDir, fname);
      const text = fs.readFileSync(full, 'utf-8');
      const originJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text));
      const sse = createResponsesSSEStreamFromResponsesJson(originJSON, { requestId: `resp_fx_${Date.now()}` });
      const text2 = await new Promise<string>((resolve) => { const arr: string[] = []; (sse as any).on('data', (c: any) => arr.push(String(c))); (sse as any).on('end', () => resolve(arr.join(''))); });
      const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text2));
      expect(canonText(synthJSON)).toBe(canonText(originJSON));
      expect(JSON.stringify(canonFns(synthJSON))).toBe(JSON.stringify(canonFns(originJSON)));
    });
  }
});

