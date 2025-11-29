#!/usr/bin/env node
// Provider v2 smoke test: read user config, pick GLM coding endpoint and key, send minimal request.
import fs from 'fs';
import os from 'os';
import path from 'path';

function readJson(p){ try { return JSON.parse(fs.readFileSync(p,'utf-8')); } catch { return null; } }
function loadUserConfig(){
  const explicit = process.env.ROUTECODEX_CONFIG_PATH;
  const candidate = explicit && explicit.trim()
    ? path.resolve(explicit.trim())
    : path.join(os.homedir(), '.routecodex', 'config.json');
  return readJson(candidate);
}

const cfg = loadUserConfig();
const providers = cfg?.virtualrouter?.providers || {};
const entries = Object.entries(providers);
const glmEntry = entries.find(([id]) => id.includes('glm')) || entries[0];
if (!glmEntry) {
  console.error('no provider definition found in ~/.routecodex/config.json');
  process.exit(2);
}
const [providerId, providerConfig] = glmEntry;
const baseUrl = String(providerConfig.baseURL || providerConfig.baseUrl || '').trim();
const apiKey =
  (Array.isArray(providerConfig.apiKey) ? providerConfig.apiKey.find(Boolean) : null) ||
  String(providerConfig.auth?.apiKey || '').trim();
const routing = cfg?.virtualrouter?.routing || {};
const firstRoute = Object.values(routing).flat().find(k => typeof k === 'string' && k.startsWith(providerId)) || '';
let model = firstRoute.split('.').slice(1).join('.') || Object.keys(providerConfig.models || {})[0] || 'glm-4.6';
if (!baseUrl || !apiKey) {
  console.error('missing baseUrl/apiKey in user config for provider', providerId);
  process.exit(3);
}
const url = `${baseUrl.replace(/\/$/,'')}/chat/completions`;

const payload = { model, messages: [{ role:'user', content:'ping' }], stream: false };

const { execFileSync } = await import('node:child_process');
const cfg = path.join(os.tmpdir(),'prov_v2_curl.cfg');
fs.writeFileSync(cfg, `url = "${url}"
header = "Authorization: Bearer ${apiKey}"
header = "Content-Type: application/json"
`);

let httpCode='000';
try{
  const out = execFileSync('curl',['-sS','-X','POST','-K',cfg,'--data',JSON.stringify(payload),'-w','\nHTTP_STATUS:%{http_code}\n'],{encoding:'utf-8'});
  const lines = out.trim().split(/\n/);
  httpCode = (lines[lines.length-1].match(/HTTP_STATUS:(\d+)/)||[])[1]||'000';
  console.log(JSON.stringify({ ok: httpCode==='200', httpCode, snippet: lines[0]?.slice(0,160) || '' }, null, 2));
}catch(e){
  console.log(JSON.stringify({ ok:false, error:String(e) }, null, 2));
  process.exit(4);
}
