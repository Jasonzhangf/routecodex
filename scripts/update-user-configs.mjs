#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const RC_DIR = path.join(HOME, '.routecodex');
const USER_CONFIG = path.join(RC_DIR, 'config.json');
const USER_CONFIG_DIR = path.join(RC_DIR, 'config');

function backupFile(p) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = p + `.bak.${ts}`;
  fs.copyFileSync(p, bak);
  return bak;
}

function readJson(p) {
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function familyFromTypeOrId(key, type) {
  const k = String(key || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  if (t.includes('qwen') || k.includes('qwen')) return 'qwen';
  if (t.includes('openai') || k.includes('openai') || k.includes('modelscope')) return 'openai';
  if (t.includes('glm') || k === 'glm') return 'glm';
  if (t.includes('lmstudio') || k.includes('lmstudio')) return 'lmstudio';
  if (t.includes('iflow') || k.includes('iflow')) return 'iflow';
  return t || 'custom';
}

function normalizeUserConfig(obj) {
  const out = { ...obj };
  out.version = out.version || '1.0.0';
  out.schemaVersion = out.schemaVersion || '1.0.0';
  out.stableSorting = out.stableSorting !== false;
  // unify httpserver
  out.httpserver = out.httpserver || {};
  if (typeof out.port === 'number' && out.port > 0 && !out.httpserver.port) out.httpserver.port = out.port;
  if (typeof out.host === 'string' && out.host && !out.httpserver.host) out.httpserver.host = out.host;
  // virtualrouter
  const vr = out.virtualrouter = out.virtualrouter || {};
  vr.inputProtocol = vr.inputProtocol || 'openai';
  vr.outputProtocol = vr.outputProtocol || 'openai';
  const providers = vr.providers = vr.providers || {};
  // Migrate legacy top-level providers into virtualrouter.providers
  if (out.providers && typeof out.providers === 'object') {
    for (const [pid, legacy] of Object.entries(out.providers)) {
      if (!providers[pid]) {
        const src = legacy || {};
        const family = familyFromTypeOrId(pid, (src).type);
        const baseURL = (src).baseURL || (src).baseUrl || undefined;
        const migrated = {
          id: pid,
          enabled: true,
          type: family,
          baseURL,
          apiKey: Array.isArray((src).apiKey) ? (src).apiKey : ((src).apiKey ? [(src).apiKey] : []),
          oauth: (src).oauth || (src?.auth?.oauth) || undefined,
          models: (src).models || {}
        };
        providers[pid] = migrated;
      }
    }
  }
  for (const [pid, pc] of Object.entries(providers)) {
    const p = pc && typeof pc === 'object' ? pc : {};
    p.id = p.id || pid;
    p.enabled = typeof p.enabled === 'boolean' ? p.enabled : true;
    p.type = familyFromTypeOrId(pid, p.type);
    // normalize baseURL casing
    if (p.baseUrl && !p.baseURL) { p.baseURL = p.baseUrl; delete p.baseUrl; }
    // keys → apiKey
    if (!p.apiKey && p.keys) {
      if (Array.isArray(p.keys)) p.apiKey = p.keys;
      else if (typeof p.keys === 'object') p.apiKey = Object.values(p.keys);
      delete p.keys;
    }
    // ensure apiKey exists (even empty) to satisfy schema where needed
    if (!p.apiKey && p.type !== 'iflow') {
      p.apiKey = [];
    }
    // models structure
    p.models = p.models || {};
    providers[pid] = p;
  }
  // routing categories
  vr.routing = vr.routing || {};
  const cats = ['default','coding','longcontext','thinking','tools','vision','websearch','background'];
  for (const c of cats) {
    if (!Array.isArray(vr.routing[c])) vr.routing[c] = vr.routing[c] ? [].concat(vr.routing[c]) : [];
    // upgrade provider names: if route uses short family name equal to a provider key variant
    vr.routing[c] = vr.routing[c].map((rt) => {
      try {
        const s = String(rt);
        // if target like 'qwen.model', and providers has 'qwen-provider', rewrite
        const [prov] = s.split('.');
        if (providers[prov]) return s; // exact match
        if (prov === 'qwen' && providers['qwen-provider']) return s.replace(/^qwen\./, 'qwen-provider.');
        if (prov === 'openai' && providers['openai']) return s; // ok
        if (prov === 'modelscope' && providers['modelscope']) return s;
        if (prov === 'glm' && providers['glm']) return s;
        if (prov === 'lmstudio' && providers['lmstudio']) return s;
      } catch {}
      return rt;
    });
  }
  // Migrate legacy top-level routing
  if (out.routing && typeof out.routing === 'object') {
    const legacy = out.routing;
    // default: string providerId or array
    if (vr.routing.default.length === 0) {
      const def = legacy.default;
      const provIds = Array.isArray(def) ? def : (typeof def === 'string' && def ? [def] : []);
      for (const pid of provIds) {
        if (providers[pid]) {
          const models = Object.keys(providers[pid].models || {});
          const modelId = models.includes('qwen3-coder-plus') ? 'qwen3-coder-plus' : (models[0] || '');
          if (modelId) vr.routing.default.push(`${pid}.${modelId}`);
        }
      }
    }
    // dynamicRouting: turn targets into strings
    if (legacy.dynamicRouting && typeof legacy.dynamicRouting === 'object') {
      for (const [cat, cfg] of Object.entries(legacy.dynamicRouting)) {
        const list = (cfg && typeof cfg === 'object' && Array.isArray(cfg.targets)) ? cfg.targets : [];
        if (cats.includes(cat)) {
          for (const t of list) {
            const pid = t?.providerId; const mid = t?.modelId;
            if (providers[pid] && mid) vr.routing[cat].push(`${pid}.${mid}`);
          }
        }
      }
    }
  }

  // Append key1 alias selectively: only for providers that use apiKey
  for (const c of cats) {
    vr.routing[c] = vr.routing[c].map((s) => {
      const str = String(s);
      const prov = str.split('.')[0];
      const p = providers[prov];
      const hasApiKeys = p && Array.isArray(p.apiKey) && p.apiKey.length > 0;
      const hasOAuth = !!(p?.oauth);
      // If oauth-only, strip any existing .key suffix
      if (!hasApiKeys && hasOAuth) {
        return str.replace(/\.key\d+$/, '');
      }
      // If apiKey-based and no key suffix, append key1
      if (hasApiKeys && !/\.key\d+$/.test(str)) return `${str}.key1`;
      return str;
    });
  }
  return out;
}

function processFile(p) {
  try {
    const j = readJson(p);
    const bak = backupFile(p);
    const norm = normalizeUserConfig(j);
    writeJson(p, norm);
    return { file: p, backup: bak, ok: true };
  } catch (e) {
    return { file: p, ok: false, error: e?.message || String(e) };
  }
}

function main() {
  const results = [];
  if (fs.existsSync(USER_CONFIG)) {
    results.push(processFile(USER_CONFIG));
  }
  if (fs.existsSync(USER_CONFIG_DIR)) {
    const files = fs.readdirSync(USER_CONFIG_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const p = path.join(USER_CONFIG_DIR, f);
      results.push(processFile(p));
    }
  }
  console.log(JSON.stringify({ updated: results.filter(r => r.ok).length, results }, null, 2));
}

main();
