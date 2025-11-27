#!/usr/bin/env node
// One-click outbound network toolcall tests against openai-compatible providers.
// Reads provider configs under ~/.routecodex/provider/*/config*.json or merged-config.*.json
// Sends a function-calling prompt and reports whether a functionCall/tool_calls is returned.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProviderFactory } from '../dist/modules/pipeline/modules/provider/v2/core/provider-factory.js';

const root = path.join(os.homedir(), '.routecodex', 'provider');
const MAX_PROVIDERS = parseInt(process.env.RCC_NET_MAX_PROVIDERS || '5', 10);
// Per-provider rate limit: default 3 req/min (can override by RCC_NET_RATE_MAX_PER_MINUTE)
const RATE_MAX_PER_MIN = parseInt(process.env.RCC_NET_RATE_MAX_PER_MINUTE || '3', 10);
const RATE_DISABLED = (process.env.RCC_NET_RATE_DISABLED || '0') === '1';
const RATE_STATE = new Map(); // key -> { windowStart:number, count:number }
const INCLUDE = (process.env.RCC_NET_INCLUDE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enforceRateLimit(key) {
  if (RATE_DISABLED) return;
  const rateKey = String(key || 'default').toLowerCase();
  while (true) {
    const now = Date.now();
    const st = RATE_STATE.get(rateKey) || { windowStart: now, count: 0 };
    if ((now - st.windowStart) >= 60000) {
      st.windowStart = now;
      st.count = 0;
    }
    if (st.count < RATE_MAX_PER_MIN) {
      st.count++;
      RATE_STATE.set(rateKey, st);
      return;
    }
    const waitMs = Math.max(10, 60000 - (now - st.windowStart));
    console.log(`[net-toolcall] rate-limit(${rateKey}) sleeping ${Math.ceil(waitMs/1000)}s`);
    await sleep(waitMs + 25);
  }
}

function findProviderConfigs() {
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  const files = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    const list = fs.readdirSync(dir).filter(f => /config\.(?:json|v1\.json)$/.test(f) || /^merged-config\..*\.json$/.test(f));
    for (const f of list) files.push(path.join(dir, f));
  }
  let filtered = files;
  if (INCLUDE.length) {
    filtered = files.filter(p => {
      const lower = p.toLowerCase();
      return INCLUDE.some(name => lower.includes(`/provider/${name}/`));
    });
  }
  return filtered.slice(0, MAX_PROVIDERS);
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

function extractProviderConfigs(raw, filename) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  // Case A: merged-config.*.json (pipeline_assembler)
  try {
    const pipelines = raw?.pipeline_assembler?.config?.pipelines;
    if (Array.isArray(pipelines) && pipelines.length) {
      for (const p of pipelines) {
        const prov = p?.modules?.provider;
        if (!prov || !prov.type || !prov.config) continue;
        let cfg = { ...prov.config };
        // Resolve auth from authRef + keyVault if not embedded
        if (!cfg.auth) {
          const aref = p?.authRef;
          const providerId = aref?.providerId || cfg.providerId || (p?.id?.split('_')[0]) || undefined;
          const keyId = aref?.keyId || undefined;
          const kv = raw?.keyVault?.[providerId || ''] || undefined;
          if (providerId && keyId && kv && kv[keyId] && kv[keyId].type === 'apikey' && kv[keyId].value) {
            cfg = { ...cfg, auth: { type: 'apikey', apiKey: kv[keyId].value } };
          }
        }
        if (cfg.auth) {
          out.push({ type: prov.type, config: cfg, __source: filename });
        }
      }
    }
  } catch {}
  // Case B: v1 config (virtualrouter.providers)
  try {
    const providers = raw?.virtualrouter?.providers;
    if (providers && typeof providers === 'object') {
      for (const [pid, prov] of Object.entries(providers)) {
        const t = String(prov?.type || '').toLowerCase();
        if (!prov?.auth || prov.auth.type !== 'apikey') continue;
        if (t === 'openai') {
          const baseUrl = prov.baseURL || prov.baseUrl;
          // pick model from routing default
          let model = undefined;
          try {
            const def = (raw?.virtualrouter?.routing?.default || [])[0];
            const parts = String(def||'').split('.');
            model = parts[1] || undefined;
          } catch {}
          const headers = (prov && typeof prov === 'object' && (prov.headers || prov.overrides?.headers)) ? (prov.headers || prov.overrides?.headers) : undefined;
          const overrides = headers ? { headers } : undefined;
          out.push({ type: 'openai-standard', config: { providerType: 'openai', baseUrl, model, overrides, headers, auth: prov.auth }, __source: filename });
        }
      }
    }
  } catch {}
  // Case C: already provider config
  try {
    if (raw?.type && raw?.config && raw?.config?.auth) {
      out.push(raw);
    }
  } catch {}
  return out;
}

function buildToolRequest(model, opts={}) {
  const forceFn = opts.forceFunctionName;
  const base = {
    model,
    messages: [{ role: 'user', content: 'Given the tools, call add with a=2 and b=3. Only function call.' }],
    tools: [{ type: 'function', function: { name: 'add', description: 'add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] } } }],
    tool_choice: 'auto'
  };
  if (forceFn) {
    base.tool_choice = { type: 'function', function: { name: String(forceFn) } };
  }
  return { data: base };
}

async function run() {
  const files = findProviderConfigs();
  if (!files.length) {
    console.error('[net-toolcall] no provider configs under', root);
    process.exit(1);
  }

  const report = [];
  for (const file of files) {
    const raw = readJson(file); if (!raw) continue;
    const cfgs = extractProviderConfigs(raw, file);
    for (const cfg of cfgs) {
      let ptypeRaw = String(cfg.config?.providerType || cfg.type || '').toLowerCase();
      const ptype = ptypeRaw.includes('openai') ? 'openai' : ptypeRaw;
      if (ptype !== 'openai' && ptype !== 'iflow') continue; // limit to OpenAI-chat family + iFlow
      // Prefer explicit model identifiers from provider config
      const model = (
        cfg.config?.model ||
        cfg.config?.modelId ||
        cfg.config?.defaultModel ||
        (Array.isArray(cfg.config?.models) ? cfg.config.models[0] : undefined) ||
        'gpt-4o-mini'
      );
      const providerId = cfg.config?.providerId || cfg.config?.id || path.basename(path.dirname(file));
      if (INCLUDE.length && !INCLUDE.includes(String(providerId || '').toLowerCase())) continue;
      const auth = cfg.config?.auth;
      if (!auth || typeof auth !== 'object') {
        report.push({ providerId, file, status: 'skipped', reason: 'missing auth config' });
        continue;
      }
      const authType = String(auth.type || '').toLowerCase();
      if (authType === 'apikey') {
        if (!auth.apiKey) {
          report.push({ providerId, file, status: 'skipped', reason: 'no apikey' });
          continue;
        }
      } else if (authType === 'oauth') {
        const ext = { ...(cfg.config?.extensions || {}) };
        if (!ext.oauthProviderId && providerId) ext.oauthProviderId = providerId;
        cfg.config.extensions = ext;
        if (!auth.tokenFile) {
          const fam = String(ext.oauthProviderId || '').toLowerCase();
          if (fam === 'iflow') auth.tokenFile = path.join(os.homedir(), '.routecodex', 'auth', 'iflow-oauth.json');
          else if (fam === 'qwen') auth.tokenFile = path.join(os.homedir(), '.routecodex', 'auth', 'qwen-oauth.json');
        }
        if (auth.tokenFile) {
          const expanded = auth.tokenFile.replace(/^~\//, `${os.homedir()}/`);
          if (!fs.existsSync(expanded)) {
            report.push({ providerId, file, status: 'skipped', reason: `tokenFile missing: ${expanded}` });
            continue;
          }
        }
      } else {
        report.push({ providerId, file, status: 'skipped', reason: `unsupported auth type: ${authType}` });
        continue;
      }
      try {
        // Rate limit per provider (<=3 req/min by default)
        await enforceRateLimit(providerId);
        const provider = ProviderFactory.createProvider(cfg, { logger: { logModule: ()=>{}, logProviderRequest: ()=>{} }, errorHandlingCenter: { handleError: async ()=>{} } });
        await provider.initialize();
        const forceFn = (providerId && providerId.toLowerCase() === 'kimi') ? 'add' : undefined;
        const req = buildToolRequest(model, { forceFunctionName: forceFn });
        const res = await provider.sendRequest(req);
        const data = (res && typeof res === 'object' && res.data) ? res.data : res;
        const toolCalls = data?.choices?.[0]?.message?.tool_calls;
        const ok = Array.isArray(toolCalls) && toolCalls.length > 0;
        report.push({
          providerId,
          file,
          status: ok ? 'ok' : 'no_toolcall',
          toolCalls: ok ? toolCalls.length : 0,
          model
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const details = e && typeof e === 'object' && 'details' in e
          ? (e.details)
          : undefined;
        report.push({ providerId, file, status: 'error', error: msg.slice(0, 300), details, model });
      }
    }
  }

  const summary = report.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});
  console.log('[net-toolcall] summary:', summary);
  console.log(JSON.stringify(report, null, 2));
}

run().catch((e)=>{ console.error(e); process.exit(1); });
