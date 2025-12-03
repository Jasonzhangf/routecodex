#!/usr/bin/env node
// Capture upstream SSE from a Responses provider (e.g., fc), log raw events, and run llmswitch-core converter.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import OpenAI from 'openai';

const BASEDIR = process.cwd();
const CODEx_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
const RESP_SAMPLE_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'responses-sse');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function findProviderConfig(providerId='fc') {
  const dir = path.join(PROVIDER_DIR, providerId);
  const candidates = ['config.v1.json', 'config.json'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`no provider config for ${providerId}`);
}

function resolveSecret(value) {
  if (!value || typeof value !== 'string') return value;
  const match = value.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
  if (!match) return value;
  const envName = match[1];
  const fallback = match[2] ?? '';
  return process.env[envName] ?? fallback;
}

function extractResponsesProviderEntry(doc, providerId='fc') {
  const pipelines = doc?.pipeline_assembler?.config?.pipelines || [];
  for (const p of pipelines) {
    const prov = p?.modules?.provider;
    const t = String(prov?.config?.providerType || prov?.type || '').toLowerCase();
    if (t.includes('responses')) return prov;
  }
  // v1 fallback: treat as openai-standard pointing to responses upstream
  const providers = doc?.virtualrouter?.providers || {};
  const exact = providers?.[providerId];
  if (exact) {
    return {
      type: exact.type || 'responses-http-provider',
      config: {
        providerType: exact.type || 'responses',
        baseUrl: exact.baseURL || exact.baseUrl,
        auth: exact.auth,
        model: exact.model || exact.defaultModel
      }
    };
  }
  const first = Object.values(providers)[0];
  if (first) {
    return {
      type: first.type || 'responses-http-provider',
      config: {
        providerType: first.type || 'responses',
        baseUrl: first.baseURL || first.baseUrl,
        auth: first.auth,
        model: first.model || first.defaultModel
      }
    };
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

function loadResponsesSample() {
  const samplePath = process.env.RCC_RESP_SAMPLE_PATH;
  if (!samplePath) return null;
  const fullPath = samplePath.startsWith('/') ? samplePath : path.join(RESP_SAMPLE_DIR, samplePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Responses sample not found: ${fullPath}`);
  }
  const doc = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  const body = doc?.data?.body || doc?.body || doc;
  if (!body || typeof body !== 'object') {
    throw new Error(`Invalid responses sample body in ${fullPath}`);
  }
  return { payload: body, meta: { path: fullPath } };
}

async function main() {
  const providerId = process.env.RCC_RESP_PROV || 'fc';
  const cfgDoc = findProviderConfig(providerId);
  const provEntry = extractResponsesProviderEntry(cfgDoc, providerId);
  const cfg = { type: provEntry.type, config: provEntry.config };
  const httpPath = pathToFileURL(path.join(BASEDIR, 'dist/providers/core/utils/http-client.js')).href;
  const { HttpClient } = await import(httpPath);
  const bridgePath = pathToFileURL(path.join(BASEDIR, 'sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js')).href;
  const converterPath = pathToFileURL(path.join(BASEDIR, 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/index.js')).href;
  const { buildResponsesRequestFromChat, buildChatResponseFromResponses } = await import(bridgePath);
  const { ResponsesSseToJsonConverter } = await import(converterPath);

  // headers
  const headers = { 'Content-Type': 'application/json', 'OpenAI-Beta': 'responses-2024-12-17' };
  const auth = cfg.config?.auth;
  if (auth?.type === 'apikey' && auth.apiKey) headers['Authorization'] = `Bearer ${auth.apiKey}`;

  // payload: chat → responses
  const responsesSample = loadResponsesSample();
  const chatBody = responsesSample ? null : pickChatSample();
  const rawReq = responsesSample ? responsesSample.payload : (buildResponsesRequestFromChat(chatBody)?.request || {});
  let respReq = JSON.parse(JSON.stringify(rawReq));
  if (!responsesSample) {
    // override model with provider config's modelId/defaultModel
    try {
      const provModel = cfg.config?.model || cfg.config?.modelId || cfg.config?.defaultModel;
      if (provModel) respReq.model = provModel;
    } catch { /* ignore */ }
    // 强制工具触发：明确指令只执行函数调用
    respReq.tool_choice = 'auto';
    if (process.env.RCC_RESP_SIMPLE_INPUT === '1') {
      // 某些上游不接受 instructions；使用最简 input 路径，重建请求
      const model = respReq.model || chatBody.model || cfg.config?.model || cfg.config?.defaultModel;
      respReq = {
        model,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Using tools, call add with {"a":2,"b":3}. Return only a function call.' }] }
        ],
        tools: Array.isArray(chatBody.tools) ? chatBody.tools : [],
        stream: true,
        tool_choice: 'auto'
      };
    } else {
      respReq.instructions = 'Call add with {"a":2,"b":3}. Respond only with a function call.';
    }
    const overrideInstructions = process.env.RCC_RESP_INSTRUCTIONS;
    if (overrideInstructions) {
      if (overrideInstructions.toLowerCase() === 'none') {
        delete respReq.instructions;
      } else {
        respReq.instructions = overrideInstructions;
      }
    } else if (!respReq.instructions) {
      respReq.instructions = 'You are a helpful assistant.';
    }
    if (!Array.isArray(respReq.tools) || !respReq.tools.length) {
      // 从 chat 样本复制工具定义
      respReq.tools = (chatBody.tools || []).map(t => t);
    }
  }
  respReq.stream = true;

  const baseUrl = String(cfg.config?.baseUrl || '').replace(/\/$/, '');
  const endpoint = '/responses';
  const resolvedApiKey =
    resolveSecret(auth?.apiKey) ||
    resolveSecret(cfgDoc?.keyVault?.[providerId]?.key1?.value) ||
    process.env.RCC_RESP_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  // send SSE request
  ensureDir(OUT_DIR);
  const outBase = path.join(OUT_DIR, `${providerId}_${nowStamp()}`);
  const sseLog = `${outBase}.sse.log`;
  const jsonOut = `${outBase}.json`;
  const reqOut = `${outBase}.request.json`;

  const baseHeaders = { 'OpenAI-Beta': 'responses-2024-12-17' };
  const captureClient = (process.env.RCC_RESP_CAPTURE_CLIENT || 'sdk').toLowerCase();
  const useSdk = captureClient === 'sdk';
  let json;

  const logEvent = (evt) => {
    try {
      fs.appendFileSync(sseLog, `event: ${evt.type}\n`);
      fs.appendFileSync(sseLog, `data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };

  if (useSdk) {
    const client = new OpenAI({
      apiKey: resolvedApiKey || 'sk-placeholder',
      baseURL: baseUrl || undefined,
      defaultHeaders: baseHeaders
    });
    const stream = await client.responses.stream(respReq);
    for await (const event of stream) {
      if (event?.type) logEvent(event);
    }
    json = await stream.finalResponse();
    fs.writeFileSync(reqOut, JSON.stringify({ url: baseUrl ? baseUrl + endpoint : 'https://api.openai.com/v1/responses', headers: baseHeaders, body: respReq }, null, 2));
  } else {
    const headers = { 'Content-Type': 'application/json', ...baseHeaders };
    if (resolvedApiKey) headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    fs.writeFileSync(reqOut, JSON.stringify({ url: baseUrl+endpoint, headers, body: respReq }, null, 2));
    const client = new HttpClient({ baseUrl, timeout: 300000 });
    const stream = await client.postStream(endpoint, respReq, { ...headers, Accept: 'text/event-stream' });
    const converter = new ResponsesSseToJsonConverter();
    json = await converter.convertSseToJson(stream, {
      requestId: path.basename(outBase),
      model: String(respReq.model||'unknown'),
      onEvent: (evt) => logEvent({ type: evt.type, ...evt })
    });
  }

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
