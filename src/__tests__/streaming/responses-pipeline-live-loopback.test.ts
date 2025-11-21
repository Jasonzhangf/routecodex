import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { PipelineManager } from '../../modules/pipeline/index.js';
import type { PipelineManagerConfig, PipelineRequest } from '../../modules/pipeline/index.js';
import { aggregateOpenAIResponsesSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readC4MConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/c4m/config.v1.json';
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const prov = j?.virtualrouter?.providers?.c4m;
    const baseURL = prov?.baseURL;
    const apiKey = prov?.auth?.apiKey || (Array.isArray(prov?.apiKey) ? prov.apiKey[0] : undefined);
    const model = Object.keys(prov?.models || {})[0] || 'gpt-4.1-mini';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch { return null; }
}

function latestProviderRequest() {
  const dir = '/Users/fanzhang/.routecodex/codex-samples/openai-responses';
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('_provider-request.json'));
  if (!files.length) return null;
  files.sort((a,b)=> fs.statSync(path.join(dir,b)).mtimeMs - fs.statSync(path.join(dir,a)).mtimeMs);
  try { return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8')); } catch { return null; }
}

function dropMaxTokenVariants(body: any) {
  const keys = Object.keys(body || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'maxtoken' || kl === 'maxtokens') delete (body as any)[k];
    if (k === 'maxToken' || k === 'maxTokens' || k === 'max_tokens') delete (body as any)[k];
  }
  return body;
}

function toReadable(text: string): Readable { const r = new Readable({ read() {} }); setImmediate(() => { r.push(text); r.push(null); }); return r; }
function canonFns(j: any) {
  const out = Array.isArray(j?.output) ? j.output : [];
  const fns = out.filter((o: any) => o?.type === 'function_call').map((o: any) => ({ name: o?.name, args: o?.arguments }));
  const seen = new Set<string>(); const uniq: Array<{name:string;args:string}> = [];
  for (const f of fns) { const k = `${f.name}|${f.args}`; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
  return uniq.sort((a,b) => (a.name+a.args).localeCompare(b.name+b.args));
}
function canonText(j: any) {
  try { const out = Array.isArray(j?.output) ? j.output : []; const msg = out.find((o: any) => o?.type === 'message'); const parts = Array.isArray(msg?.content) ? msg.content : []; const txt = parts.find((p: any) => p?.type === 'output_text'); return String(txt?.text || ''); } catch { return ''; }
}

describe('Responses pipeline live loopback via real PipelineManager (c4m provider)', () => {
  const cfg = readC4MConfig();
  if (!cfg) {
    test('skip: missing c4m config', () => expect(true).toBe(true));
    return;
  }
  jest.setTimeout(120000);

  async function createManager(): Promise<{ manager: PipelineManager; pipelineId: string }> {
    const pipelineId = 'c4m.responses';
    const managerConfig: PipelineManagerConfig = {
      pipelines: [
        {
          id: pipelineId,
          provider: { type: 'responses' },
          modules: {
            llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } },
            workflow: { type: 'streaming-control', config: {} },
            compatibility: { type: 'compatibility', config: {} },
            provider: {
              type: 'responses',
              config: {
                providerType: 'responses',
                baseUrl: cfg.baseURL,
                auth: { type: 'apikey', apiKey: cfg.apiKey },
                overrides: { headers: { Accept: 'application/json' }, endpoint: '/responses' }
              }
            }
          }
        }
      ]
    };
    const dummyErrorCenter: any = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: any = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();
    return { manager, pipelineId };
  }

  test('streaming roundtrip (pipeline synthesized SSE vs upstream live SSE)', async () => {
    const { manager, pipelineId } = await createManager();
    const url = `${cfg.baseURL.replace(/\/$/,'')}/responses`;
    const snap = latestProviderRequest();
    const baseBody = (snap?.body && typeof snap.body === 'object') ? { ...snap.body } : {
      model: cfg.model,
      input: [ { role: 'user', content: [ { type: 'input_text', text: '你好 (pipeline-live)' } ] } ]
    };
    const body = dropMaxTokenVariants({ ...baseBody, stream: true });

    // Upstream live SSE (reference)
    const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'OpenAI-Beta': 'responses-2024-12-17', 'accept': 'text/event-stream' } as any;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) } as any);
    expect(res.ok).toBe(true);
    const upstreamText = await res.text();
    const upstreamJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(upstreamText));

    // Pipeline synthesized SSE
    const req: PipelineRequest = {
      data: body,
      route: { providerId: 'c4m', modelId: String(body.model || cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/responses', stream: true },
      debug: { enabled: false, stages: {} }
    } as any;
    const out = await manager.processRequest(req);
    const sse = (out?.data as any)?.__sse_responses as Readable;
    expect(typeof (sse as any)?.on).toBe('function');
    const synthesizedText = await new Promise<string>((resolve) => { const arr: string[] = []; (sse as any).on('data', (c: any) => arr.push(String(c))); (sse as any).on('end', () => resolve(arr.join(''))); });
    const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(synthesizedText));

    expect(canonText(synthJSON)).toBe(canonText(upstreamJSON));
    expect(JSON.stringify(canonFns(synthJSON))).toBe(JSON.stringify(canonFns(upstreamJSON)));
  });
});

