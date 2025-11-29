#!/usr/bin/env node
// Regression: use one Codex openai-chat tool-calling sample, send to all OK providers (openai-compatible)
// 1) Outbound: build chat payload from Codex sample (messages/tools)
// 2) Inbound: normalize provider response to chat shape (verify tool_calls)

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { ProviderFactory } from '../dist/modules/pipeline/modules/provider/v2/core/provider-factory.js';

const CODEx_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
const RESPONSES_SAMPLE_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
const TARGET_TOOL_NAME = (process.env.RCC_REG_TOOL_NAME || 'add').toLowerCase();
const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const MAX_PER_PROVIDER_PER_MIN = parseInt(process.env.RCC_NET_RATE_MAX_PER_MINUTE || '3', 10);
const RATE_DISABLED = (process.env.RCC_NET_RATE_DISABLED || '0') === '1';
const TARGET_PROTOCOLS = new Set(
  (process.env.RCC_REG_PROTOCOLS || 'openai')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const baseDir = process.cwd();
const anthropicCodecPath = pathToFileURL(path.resolve(baseDir, 'sharedmodule/llmswitch-core/dist/v2/conversion/codecs/anthropic-openai-codec.js')).href;
const responsesBridgePath = pathToFileURL(path.resolve(baseDir, 'sharedmodule/llmswitch-core/dist/v2/conversion/responses/responses-openai-bridge.js')).href;

let conversionsLoaded = null;
let responsesInstructionsCache = null;
async function getConversions() {
  if (conversionsLoaded) return conversionsLoaded;
  const [anthModule, respModule] = await Promise.all([
    import(anthropicCodecPath).catch(() => null),
    import(responsesBridgePath).catch(() => null)
  ]);
  if (!anthModule || !respModule) {
    throw new Error('Conversion module missing. 请先构建 sharedmodule/llmswitch-core');
  }
  conversionsLoaded = {
    buildAnthropicRequestFromOpenAIChat: anthModule.buildAnthropicRequestFromOpenAIChat,
    buildOpenAIChatFromAnthropic: anthModule.buildOpenAIChatFromAnthropic,
    buildResponsesRequestFromChat: respModule.buildResponsesRequestFromChat,
    buildChatResponseFromResponses: respModule.buildChatResponseFromResponses
  };
  return conversionsLoaded;
}

function providerTypeOf(cfg) {
  const raw = String(cfg?.config?.providerType || cfg?.type || '').toLowerCase();
  if (!raw) return 'openai';
  if (raw.includes('anthropic')) return 'anthropic';
  if (raw.includes('responses')) return 'responses';
  if (raw.includes('openai')) return 'openai';
  return raw;
}

async function buildProviderPayload(providerType, chatPayload) {
  if (providerType === 'openai') return chatPayload;
  const conv = await getConversions();
  if (providerType === 'anthropic') {
    if (typeof conv.buildAnthropicRequestFromOpenAIChat !== 'function') throw new Error('Anthropic converter missing');
    return conv.buildAnthropicRequestFromOpenAIChat(chatPayload);
  }
  if (providerType === 'responses') {
    if (typeof conv.buildResponsesRequestFromChat !== 'function') throw new Error('Responses converter missing');
    const res = conv.buildResponsesRequestFromChat(chatPayload);
    const requestPayload = res?.request ?? chatPayload;
    const currentInstr = typeof requestPayload.instructions === 'string' ? requestPayload.instructions.trim() : '';
    if (!currentInstr) {
      const sys = collectSystemText(chatPayload?.messages);
      requestPayload.instructions = sys || loadDefaultResponsesInstructions();
    }
    return requestPayload;
  }
  return chatPayload;
}

async function normalizeProviderResponse(providerType, response) {
  if (providerType === 'openai') return response;
  const conv = await getConversions();
  const root = response && typeof response === 'object' && response.data ? response.data : response;
  if (providerType === 'anthropic') {
    if (typeof conv.buildOpenAIChatFromAnthropic !== 'function') return root;
    return conv.buildOpenAIChatFromAnthropic(root);
  }
  if (providerType === 'responses') {
    if (typeof conv.buildChatResponseFromResponses !== 'function') return root;
    return conv.buildChatResponseFromResponses(root);
  }
  return root;
}

function extractToolCalls(providerType, normalized) {
  if (!normalized) return null;
  if (providerType === 'anthropic') {
    const msgs = Array.isArray(normalized?.messages) ? normalized.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && typeof m === 'object' && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        return m.tool_calls;
      }
    }
    return null;
  }
  const choices = Array.isArray(normalized?.choices) ? normalized.choices : [];
  if (choices.length) {
    const tc = choices[0]?.message?.tool_calls;
    if (Array.isArray(tc)) return tc;
  }
  if (Array.isArray(normalized?.tool_calls)) return normalized.tool_calls;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const RATE_STATE = new Map();
async function rateGate(key) {
  if (RATE_DISABLED) return;
  const K = String(key || 'default').toLowerCase();
  while (true) {
    const now = Date.now();
    const st = RATE_STATE.get(K) || { windowStart: now, count: 0 };
    if ((now - st.windowStart) >= 60000) { st.windowStart = now; st.count = 0; }
    if (st.count < MAX_PER_PROVIDER_PER_MIN) { st.count++; RATE_STATE.set(K, st); return; }
    const wait = Math.max(10, 60000 - (now - st.windowStart));
    console.log(`[regress] rate-limit(${K}) sleep ${Math.ceil(wait/1000)}s`);
    await sleep(wait + 25);
  }
}

function toolMatches(payload) {
  if (!Array.isArray(payload?.tools)) return false;
  return payload.tools.some(t => String(t?.function?.name || '').toLowerCase() === TARGET_TOOL_NAME);
}

function extractPayloadCandidates(obj) {
  const candidates = [];
  if (!obj || typeof obj !== 'object') return candidates;
  if (Array.isArray(obj?.data?.events)) {
    for (const e of obj.data.events) {
      if (Array.isArray(e?.payload?.messages) && Array.isArray(e?.payload?.tools)) {
        candidates.push(e.payload);
      }
    }
  }
  // Some files are plain provider-request payloads
  const maybePayloads = [obj, obj?.data, obj?.data?.body];
  for (const m of maybePayloads) {
    if (m && Array.isArray(m.messages) && Array.isArray(m.tools)) {
      candidates.push(m);
    }
  }
  return candidates;
}

function findCodexSampleFile() {
  if (!fs.existsSync(CODEx_DIR)) throw new Error('codex-samples directory missing');
  const list = fs.readdirSync(CODEx_DIR);
  // prioritize aggregate files, fall back to provider-request
  const sorted = list.sort((a,b)=>a.localeCompare(b));
  for (const f of sorted) {
    if (!/_pipeline\.aggregate\.json$|_provider-request\.json$/i.test(f)) continue;
    try {
      const full = path.join(CODEx_DIR, f);
      const o = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const candidates = extractPayloadCandidates(o);
      const picked = candidates.find(toolMatches);
      if (picked) return { file: full, payload: picked };
    } catch {}
  }
  throw new Error('no suitable codex sample found (with messages+tools)');
}

function clonePayload(obj) {
  try { return structuredClone(obj); } catch {
    try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
  }
}

function collectSystemText(messages) {
  if (!Array.isArray(messages)) return '';
  const chunks = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if ((m.role || '').toLowerCase() !== 'system') continue;
    const c = m.content;
    if (typeof c === 'string') { chunks.push(c); continue; }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === 'string') chunks.push(part);
        else if (part && typeof part.text === 'string') chunks.push(part.text);
      }
      continue;
    }
    if (c && typeof c === 'object' && typeof c.text === 'string') chunks.push(c.text);
  }
  return chunks.join('\n').trim();
}

function loadDefaultResponsesInstructions() {
  if (responsesInstructionsCache !== null) return responsesInstructionsCache;
  try {
    if (fs.existsSync(RESPONSES_SAMPLE_DIR)) {
      const sample = fs.readdirSync(RESPONSES_SAMPLE_DIR).find(f => f.endsWith('_provider-request.json'));
      if (sample) {
        const obj = JSON.parse(fs.readFileSync(path.join(RESPONSES_SAMPLE_DIR, sample), 'utf-8'));
        const instr = obj?.data?.body?.instructions;
        if (typeof instr === 'string' && instr.trim()) {
          responsesInstructionsCache = instr.trim();
          return responsesInstructionsCache;
        }
      }
    }
  } catch { /* ignore */ }
  responsesInstructionsCache = 'You are a helpful assistant. Follow the user instructions exactly.';
  return responsesInstructionsCache;
}

function findProviderConfigs() {
  if (!fs.existsSync(PROVIDER_DIR)) return [];
  const dirs = fs.readdirSync(PROVIDER_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  const files = [];
  for (const d of dirs) {
    const dir = path.join(PROVIDER_DIR, d.name);
    const list = fs.readdirSync(dir).filter(f =>
      /config\.(?:json|v1\.json)$/.test(f) ||
      /^virtual-router-config\..*\.generated\.json$/.test(f)
    );
    for (const f of list) files.push(path.join(dir, f));
  }
  return files;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

function extractProviderEntries(file) {
  const raw = readJson(file); if (!raw) return [];
  const out = [];
  // pipeline artifacts
  try {
    const pipelines = raw?.pipeline_assembler?.config?.pipelines;
    if (Array.isArray(pipelines) && pipelines.length) {
      for (const p of pipelines) {
        const prov = p?.modules?.provider;
        if (!prov || !prov.type || !prov.config) continue;
        let cfg = { ...prov.config };
        if (!cfg.auth) {
          const kv = raw?.keyVault?.[cfg.providerId || ''] || {};
          const keyId = p?.authRef?.keyId;
          if (keyId && kv[keyId] && kv[keyId].type === 'apikey') {
            cfg.auth = { type: 'apikey', apiKey: kv[keyId].value };
          }
        }
        if (cfg.auth) out.push({ type: prov.type, config: cfg, __source: file });
      }
    }
  } catch {}
  // v1
  try {
    const providers = raw?.virtualrouter?.providers;
    if (providers && typeof providers === 'object') {
      for (const [pid, prov] of Object.entries(providers)) {
        const t = String(prov?.type || '').toLowerCase();
        if (t !== 'openai') continue;
        if (!prov?.auth || prov.auth.type !== 'apikey') continue;
        const baseUrl = prov.baseURL || prov.baseUrl;
        let model = undefined;
        try { const def = (raw?.virtualrouter?.routing?.default || [])[0]; const parts = String(def||'').split('.'); model = parts[1] || undefined; } catch {}
        const headers = (prov && typeof prov === 'object' && (prov.headers || prov.overrides?.headers)) ? (prov.headers || prov.overrides?.headers) : undefined;
        const overrides = headers ? { headers } : undefined;
        out.push({ type: 'openai-standard', config: { providerType: 'openai', baseUrl, model, overrides, headers, auth: prov.auth, providerId: pid }, __source: file });
      }
    }
  } catch {}
  // already provider
  try { if (raw?.type && raw?.config?.auth) out.push(raw); } catch {}
  return out;
}

function normalizeModel(cfg) {
  return (
    cfg?.config?.model || cfg?.config?.modelId || cfg?.config?.defaultModel ||
    (Array.isArray(cfg?.config?.models) ? cfg.config.models[0] : undefined) || 'gpt-4o-mini'
  );
}

function buildChatFromSample(samplePayload, model, opts={}) {
  const forceFn = opts.forceFunctionName;
  const base = {
    model,
    messages: samplePayload.messages,
    tools: samplePayload.tools,
    tool_choice: 'auto'
  };
  if (forceFn) base.tool_choice = { type: 'function', function: { name: String(forceFn) } };
  return { data: base };
}

function toChatShape(res) {
  const root = (res && typeof res === 'object' && res.data) ? res.data : res;
  if (root && root.choices && Array.isArray(root.choices)) return root;
  // minimal normalization fallback
  return root;
}

async function run() {
  const sample = findCodexSampleFile();
  const files = findProviderConfigs();
  const entries = files.flatMap(extractProviderEntries);
  // Keep one per providerId for providers we know OK
  const allow = new Set((process.env.RCC_REG_PROVIDERS || 'glm,kimi,lmstudio,modelscope').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
  const picked = new Map();
  for (const e of entries) {
    const pid = (e.config?.providerId || e.config?.id || path.basename(path.dirname(e.__source))).toLowerCase();
    const ptype = providerTypeOf(e);
    if (TARGET_PROTOCOLS.size && !TARGET_PROTOCOLS.has(ptype)) continue;
    if (!allow.has(pid)) continue;
    if (!picked.has(pid)) picked.set(pid, e);
  }

  const report = [];
  for (const [pid, cfg] of picked) {
    const providerId = pid;
    const providerType = providerTypeOf(cfg);
    const model = normalizeModel(cfg);
    const forceFn = (providerId === 'kimi') ? 'add' : undefined;
    const req = buildChatFromSample(sample.payload, model, { forceFunctionName: forceFn });
    const auth = cfg.config?.auth;
    if (!auth || auth.type !== 'apikey' || !auth.apiKey) {
      report.push({ providerId, status: 'skipped', reason: 'no apikey' });
      continue;
    }
    try {
      await rateGate(providerId);
      const provider = ProviderFactory.createProvider(cfg, { logger: { logModule: ()=>{}, logProviderRequest: ()=>{} }, errorHandlingCenter: { handleError: async ()=>{} } });
      await provider.initialize();
      const chatPayload = clonePayload(req.data);
      const providerPayload = await buildProviderPayload(providerType, chatPayload);
      const finalReq = { data: providerPayload };
      const res = await provider.sendRequest(finalReq);
      const normalized = await normalizeProviderResponse(providerType, res && typeof res === 'object' && res.data ? res.data : res);
      const toolCalls = extractToolCalls(providerType, normalized);
      const ok = Array.isArray(toolCalls) && toolCalls.length > 0;
      report.push({ providerId, status: ok ? 'ok' : 'no_toolcall', toolCalls: ok ? toolCalls.length : 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.push({ providerId, status: 'error', error: msg.slice(0, 300) });
    }
  }

  const summary = report.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});
  console.log('[regress] sample:', sample.file);
  console.log('[regress] summary:', summary);
  console.log(JSON.stringify(report, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
