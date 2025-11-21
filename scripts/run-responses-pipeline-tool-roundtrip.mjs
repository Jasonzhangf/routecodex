#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PipelineManager } from '../dist/modules/pipeline/index.js';
import { aggregateOpenAIResponsesSSEToJSON } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.ts';

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

function dropMaxTokenVariants(body) {
  const keys = Object.keys(body || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'maxtoken' || kl === 'maxtokens') delete body[k];
    if (k === 'maxToken' || k === 'maxTokens' || k === 'max_tokens') delete body[k];
  }
  return body;
}

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(() => { r.push(text); r.push(null); }); return r; }

async function main() {
  const cfg = readC4MConfig();
  if (!cfg) { console.error('missing c4m config'); process.exit(1); }

  const pipelineId = 'c4m.responses';
  const managerConfig = {
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
  const dummyErrorCenter = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const dummyDebugCenter = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
  const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
  await manager.initialize();

  // first round
  const snap = latestProviderRequest();
  const baseBody = (snap?.body && typeof snap.body === 'object') ? { ...snap.body } : {
    model: cfg.model,
    input: [ { role: 'user', content: [ { type: 'input_text', text: '列出当前项目文件（Responses工具回合测试）' } ] } ]
  };
  const body = dropMaxTokenVariants({ ...baseBody, stream: true });
  const req1 = { data: { ...body, metadata: { entryEndpoint: '/v1/responses', stream: true } }, route: { providerId: 'c4m', modelId: String(body.model||cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId }, metadata: { entryEndpoint: '/v1/responses', stream: true }, debug: { enabled: false, stages: {} } };
  const out1 = await manager.processRequest(req1);
  const sse1 = out1?.data?.__sse_responses;
  if (!sse1) { console.error('no sse1'); process.exit(2); }
  const text1 = await new Promise((resolve) => { const arr=[]; sse1.on('data', c=>arr.push(String(c))); sse1.on('end', ()=> resolve(arr.join(''))); });
  const json1 = await aggregateOpenAIResponsesSSEToJSON(toReadable(String(text1)));
  const ra = json1?.required_action;
  if (!ra || ra?.type !== 'submit_tool_outputs') { console.error('no required_action'); process.exit(3); }
  const tc = Array.isArray(ra?.submit_tool_outputs?.tool_calls) ? ra.submit_tool_outputs.tool_calls[0] : null;
  if (!tc) { console.error('no tool_call'); process.exit(4); }
  const callId = String(tc?.id || tc?.call_id || '');

  // follow-up with tool_result
  const toolOutput = '[MOCK_TOOL_OUTPUT]';
  const follow = { model: String(json1?.model || body.model || cfg.model), input: [ { type: 'tool_result', tool_call_id: callId, output: toolOutput } ], previous_response_id: String(json1?.id || ''), stream: true };
  const req2 = { data: { ...follow, metadata: { entryEndpoint: '/v1/responses', stream: true } }, route: { providerId: 'c4m', modelId: String(follow.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId }, metadata: { entryEndpoint: '/v1/responses', stream: true }, debug: { enabled: false, stages: {} } };
  const out2 = await manager.processRequest(req2);
  const sse2 = out2?.data?.__sse_responses;
  if (!sse2) { console.error('no sse2'); process.exit(5); }
  const text2 = await new Promise((resolve) => { const arr=[]; sse2.on('data', c=>arr.push(String(c))); sse2.on('end', ()=> resolve(arr.join(''))); });
  const json2 = await aggregateOpenAIResponsesSSEToJSON(toReadable(String(text2)));
  const hasRA2 = !!json2?.required_action;
  const outText2 = (() => { try { const out = Array.isArray(json2?.output) ? json2.output : []; const msg = out.find(o=>o?.type==='message'); const parts = Array.isArray(msg?.content) ? msg.content : []; const ot = parts.find(p=>p?.type==='output_text'); return String(ot?.text || ''); } catch { return ''; }})();
  console.log('[responses-tool-rt] required_action_2:', hasRA2);
  console.log('[responses-tool-rt] output_text_2.length:', outText2.length);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
