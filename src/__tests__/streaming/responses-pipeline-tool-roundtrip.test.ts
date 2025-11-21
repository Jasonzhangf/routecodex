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

describe('Responses pipeline tool roundtrip (split required_action and pass tool outputs via standard follow-up)', () => {
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
            compatibility: { type: 'compatibility', config: { moduleType: 'responses-compatibility', providerType: 'responses' } },
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

  test('required_action -> submit_tool_outputs follow-up', async () => {
    const { manager, pipelineId } = await createManager();
    // 1) First round: run a standard Responses request to produce required_action
    const snap = latestProviderRequest();
    const baseBody = (snap?.body && typeof snap.body === 'object') ? { ...snap.body } : {
      model: cfg.model,
      input: [ { role: 'user', content: [ { type: 'input_text', text: '列出当前项目文件（Responses工具回合测试）' } ] } ]
    };
    const body = dropMaxTokenVariants({ ...baseBody, stream: true });

    const req1: PipelineRequest = {
      data: body,
      route: { providerId: 'c4m', modelId: String(body.model || cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/responses', stream: true },
      debug: { enabled: false, stages: {} }
    } as any;
    const out1 = await manager.processRequest(req1);
    const sse1 = (out1?.data as any)?.__sse_responses as Readable;
    expect(typeof (sse1 as any)?.on).toBe('function');
    const text1 = await new Promise<string>((resolve) => { const arr: string[] = []; (sse1 as any).on('data', (c: any) => arr.push(String(c))); (sse1 as any).on('end', () => resolve(arr.join(''))); });
    const json1 = await aggregateOpenAIResponsesSSEToJSON(toReadable(text1));

    // Expect required_action
    const ra = (json1 as any)?.required_action;
    expect(ra?.type).toBe('submit_tool_outputs');
    const toolCalls = Array.isArray(ra?.submit_tool_outputs?.tool_calls) ? ra.submit_tool_outputs.tool_calls : [];
    expect(toolCalls.length).toBeGreaterThan(0);
    const call = toolCalls[0];
    const callId = String(call?.id || call?.call_id || '');
    expect(callId.length).toBeGreaterThan(0);

    // 2) Split and pass tool outputs via standard follow-up payload (mapped form)
    // For test stability, we mock execution result text deterministically
    const outputText = '[MOCK_TOOL_OUTPUT]';
    const followup = {
      model: String(json1?.model || body.model || cfg.model),
      input: [ { type: 'tool_result', tool_call_id: callId, output: outputText } ],
      previous_response_id: String(json1?.id || ''),
      stream: true
    } as any;

    const req2: PipelineRequest = {
      data: followup,
      route: { providerId: 'c4m', modelId: String(followup.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/responses', stream: true },
      debug: { enabled: false, stages: {} }
    } as any;
    const out2 = await manager.processRequest(req2);
    const sse2 = (out2?.data as any)?.__sse_responses as Readable;
    expect(typeof (sse2 as any)?.on).toBe('function');
    const text2 = await new Promise<string>((resolve) => { const arr: string[] = []; (sse2 as any).on('data', (c: any) => arr.push(String(c))); (sse2 as any).on('end', () => resolve(arr.join(''))); });
    const json2 = await aggregateOpenAIResponsesSSEToJSON(toReadable(text2));

    // 3) Validate second round progressed (no further required_action or output text produced)
    const hasRA2 = !!(json2 as any)?.required_action;
    const outputText2 = (() => {
      try {
        const out = Array.isArray((json2 as any)?.output) ? (json2 as any).output : [];
        const msg = out.find((o: any) => o?.type === 'message');
        const parts = Array.isArray(msg?.content) ? msg.content : [];
        const ot = parts.find((p: any) => p?.type === 'output_text');
        return String(ot?.text || '');
      } catch { return ''; }
    })();
    // 至少满足“状态推进”：要么没有再次要求 required_action，要么产生了文本
    expect(hasRA2 === false || outputText2.length > 0).toBe(true);
  });
});

