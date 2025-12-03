#!/usr/bin/env node
/**
 * Update provider models from /v1/models endpoint and write into the user's
 * RouteCodex config (defaults to ~/.routecodex/config.json).
 *
 * Usage:
 *   node scripts/update-models.mjs --provider qwen-provider [--write] [--config path]
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv){
  const out={ provider:null, write:false, config:null };
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if((a==='--provider'||a==='-p') && i+1<argv.length){ out.provider=argv[++i]; continue; }
    if(a==='--write'){ out.write=true; continue; }
    if((a==='--config'||a==='-c') && i+1<argv.length){ out.config=argv[++i]; continue; }
    if(a==='--help'||a==='-h'){ out.help=true; }
  }
  return out;
}

function readJson(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }
function writeJson(p,obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2)); }
function expandHome(p){ return p && p.startsWith('~/')? p.replace(/^~\//, `${process.env.HOME||''}/`): p; }

function resolveConfigPath(explicit){
  const envPath = process.env.ROUTECODEX_CONFIG_PATH || process.env.ROUTECODEX_CONFIG;
  const fallback = path.join(process.env.HOME || '', '.routecodex', 'config.json');
  const candidate = expandHome(explicit || envPath || fallback);
  if (!candidate) {
    throw new Error('Unable to resolve configuration path');
  }
  return path.resolve(candidate);
}

function findQwenToken(){
  const home=process.env.HOME||'';
  const rc=path.join(home,'.routecodex','tokens','qwen-default.json');
  try{ if(fs.existsSync(rc)) { const t=readJson(rc); if(t && (t.access_token||t.AccessToken)) return t; } }catch{}
  const dir=path.join(home,'.cli-proxy-api');
  try{
    const list=fs.readdirSync(dir).filter(n=>/^qwen-.*\.json$/i.test(n)).sort();
    for(const f of list){ const t=readJson(path.join(dir,f)); if(t && (t.access_token||t.AccessToken)) return t; }
  }catch{}
  return null;
}

async function fetchModels(baseURL, auth){
  const headers = { 'Accept':'application/json' };
  if (auth?.bearer){ headers['Authorization'] = `Bearer ${auth.bearer}`; }
  const candidates = [];
  const b=baseURL.replace(/\/?$/,'');
  candidates.push(`${b}/models`);
  // DashScope compatible mode fallback
  if (/\/v1$/.test(b)) candidates.push(b.replace(/\/v1$/, '/compatible-mode/v1') + '/models');
  candidates.push('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
  let lastErr=null;
  for(const url of candidates){
    try{
      const res = await fetch(url, { headers });
      if (!res.ok){ lastErr = new Error(`GET ${url} -> ${res.status}`); continue; }
      const body = await res.json();
      const arr = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models)? body.models: []);
      const ids = arr.map(it => (typeof it==='string'? it: it?.id)).filter(Boolean);
      if (ids.length) return [...new Set(ids)].sort();
    }catch(e){ lastErr = e; }
  }
  if (lastErr) throw lastErr; else throw new Error('No models endpoint succeeded');
}

async function main(){
  const args=parseArgs(process.argv);
  if(args.help || !args.provider){
    console.log('Usage: node scripts/update-models.mjs --provider <provider-id> [--write] [--config <path>]');
    process.exit(args.help?0:1);
  }

  const cfgPath = resolveConfigPath(args.config);
  const cfg = readJson(cfgPath);
  if(!cfg){ throw new Error(`Cannot read ${cfgPath}`); }
  const vr = cfg.virtualrouter || {};
  const providers = vr.providers || {};
  const p = providers[args.provider];
  if(!p){ throw new Error(`Provider not found in config: ${args.provider}`); }
  const baseURL = p.baseURL || p.baseUrl || 'https://api.qwen.ai/v1';

  let bearer = null;
  // Only for qwen: try token files
  if (/qwen/i.test(args.provider) || /qwen/i.test(baseURL)){
    const tok = findQwenToken();
    if(tok) bearer = tok.access_token || tok.AccessToken;
  }
  // Otherwise, try apikey in config
  if(!bearer && Array.isArray(p.apiKey) && p.apiKey[0]){
    bearer = p.apiKey[0];
  }

  const models = await fetchModels(baseURL, bearer? { bearer } : null);
  if(models.length===0){ throw new Error('No models returned by /models'); }
  console.log(`Fetched ${models.length} models from ${baseURL}/models`);
  if(!p.models) p.models = {};
  // reset models to fetched list
  p.models = Object.fromEntries(models.map(id => [id, {}]));
  providers[args.provider] = p;
  cfg.virtualrouter.providers = providers;
  if(args.write){ writeJson(cfgPath, cfg); console.log(`Updated ${cfgPath}`); }
}

main().catch(e=>{ console.error(e?.message||String(e)); process.exit(1); });
