#!/usr/bin/env node
// Capture upstream SSE from a Responses provider (e.g., fc), log raw events, and run llmswitch-core converter.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const BASEDIR = process.cwd();
const CODEx_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'responses-sse');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function findProviderConfig(providerId='fc') {
  const dir = path.join(PROVIDER_DIR, providerId);
  const merged = path.join(dir, 'merged-config.5555.json');
  const v1 = path.join(dir, 'config.v1.json');
  let chosen = null;
  if (fs.existsSync(merged)) chosen = merged; else if (fs.existsSync(v1)) chosen = v1;
  if (!chosen) throw new Error(`no provider config for ${providerId}`);
  return JSON.parse(fs.readFileSync(chosen, 'utf-8'));
}

function extractResponsesProviderEntry(doc) {
  const pipelines = doc?.pipeline_assembler?.config?.pipelines || [];
  for (const p of pipelines) {
    const prov = p?.modules?.provider;
    const t = String(prov?.config?.providerType || prov?.type || '').toLowerCase();
    if (t.includes('responses')) return prov;
  }
  // v1 fallback: treat as openai-standard pointing to responses upstream
  const providers = doc?.virtualrouter?.providers || {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (String(pid).toLowerCase() === 'fc') {
      return { type: 'responses-http-provider', config: { providerType: 'responses', baseUrl: prov.baseURL||prov.baseUrl, auth: prov.auth } };
    }
  }
  throw new Error('no responses provider entry');
}

function pickChatSample() {
  const list = fs.readdirSync(CODEx_DIR).filter(f => /(_pipeline\.aggregate\.json|_provider-request\.json)$/.test(f)).sort();
  for (const f of list) {
    const obj = JSON.parse(fs.readFileSync(path.join(CODEx_DIR, f), 'utf-8'));
    const body = obj?.data?.body || obj?.data || obj;
    if (Array.isArray(body?.messages) && Array.isArray(body?.tools)) return body;
  }
  throw new Error('no suitable chat sample');
}

async function main() {
  const providerId = process.env.RCC_RESP_PROV || 'fc';
  const cfgDoc = findProviderConfig(providerId);
  const provEntry = extractResponsesProviderEntry(cfgDoc);
  const cfg = { type: provEntry.type, config: provEntry.config };
  const httpPath = pathToFileURL(path.join(BASEDIR, 'dist/modules/pipeline/modules/provider/v2/utils/http-client.js')).href;
  const { HttpClient } = await import(httpPath);
  const bridgePath = pathToFileURL(path.join(BASEDIR, 'sharedmodule/llmswitch-core/dist/v2/conversion/responses/responses-openai-bridge.js')).href;
  const converterPath = pathToFileURL(path.join(BASEDIR, 'sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/sse/sse-to-json/index.js')).href;
  const { buildResponsesRequestFromChat, buildChatResponseFromResponses } = await import(bridgePath);
  const { ResponsesSseToJsonConverter } = await import(converterPath);

  // headers
  const headers = { 'Content-Type': 'application/json', 'OpenAI-Beta': 'responses-2024-12-17' };
  const auth = cfg.config?.auth;
  if (auth?.type === 'apikey' && auth.apiKey) headers['Authorization'] = `Bearer ${auth.apiKey}`;

  // payload: chat → responses
  const chatBody = pickChatSample();
  const respReq = buildResponsesRequestFromChat(chatBody)?.request || {};
  // override model with provider config's modelId/defaultModel
  try {
    const provModel = cfg.config?.model || cfg.config?.modelId || cfg.config?.defaultModel;
    if (provModel) respReq.model = provModel;
  } catch { /* ignore */ }
  // 强制工具触发：明确指令只执行函数调用
  respReq.tool_choice = 'auto';
  if (process.env.RCC_RESP_SIMPLE_INPUT === '1') {
    // 某些上游不接受 instructions；使用最简 input 路径
    respReq.instructions = 'You are a helpful assistant.';
    respReq.input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Using tools, call add with {"a":2,"b":3}. Return only a function call.' }] }
    ];
  } else {
    respReq.instructions = 'Call add with {"a":2,"b":3}. Respond only with a function call.';
  }
  if (!Array.isArray(respReq.tools) || !respReq.tools.length) {
    // 从 chat 样本复制工具定义（简化：chatBody.tools 已是 OpenAI 形状，responses builder会在有 tools 时映射）
    respReq.tools = (chatBody.tools || []).map(t => t);
  }
  respReq.stream = true;

  const baseUrl = String(cfg.config?.baseUrl || '').replace(/\/$/, '');
  const endpoint = '/responses';
  const client = new HttpClient({ baseUrl, timeout: 300000 });

  // send SSE request
  ensureDir(OUT_DIR);
  const outBase = path.join(OUT_DIR, `${providerId}_${nowStamp()}`);
  const sseLog = `${outBase}.sse.log`;
  const jsonOut = `${outBase}.json`;
  const reqOut = `${outBase}.request.json`;
  fs.writeFileSync(reqOut, JSON.stringify({ url: baseUrl+endpoint, headers, body: respReq }, null, 2));

  const stream = await client.postStream(endpoint, respReq, { ...headers, Accept: 'text/event-stream' });
  const converter = new ResponsesSseToJsonConverter();
  const json = await converter.convertSseToJson(stream, {
    requestId: path.basename(outBase),
    model: String(respReq.model||'unknown'),
    onEvent: (evt) => {
      try {
        fs.appendFileSync(sseLog, `event: ${evt.type}\n`);
        fs.appendFileSync(sseLog, `data: ${JSON.stringify(evt.data)}\n\n`);
      } catch {}
    }
  });
  fs.writeFileSync(jsonOut, JSON.stringify(json, null, 2));
  // Build Chat response shape via llmswitch-core and snapshot next to JSON
  try {
    const chat = buildChatResponseFromResponses(json);
    const chatOut = `${outBase}.chat.json`;
    fs.writeFileSync(chatOut, JSON.stringify(chat, null, 2));
    console.log('[responses-sse-capture] saved', sseLog, jsonOut, chatOut);
  } catch (e) {
    console.warn('[responses-sse-capture] chat-convert failed:', e?.message || String(e));
    console.log('[responses-sse-capture] saved', sseLog, jsonOut);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
