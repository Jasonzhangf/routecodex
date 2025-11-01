#!/usr/bin/env node
// Provider v2 smoke test: read merged config, pick GLM coding endpoint and key, send minimal request.
import fs from 'fs';
import os from 'os';
import path from 'path';

function readJson(p){ try { return JSON.parse(fs.readFileSync(p,'utf-8')); } catch { return null; } }
function latestMerged(){
  const dir = path.join(os.homedir(),'config');
  const files = fs.readdirSync(dir).filter(n=>/^merged-config\..*\.json$/.test(n)).map(n=>({n,m:fs.statSync(path.join(dir,n)).mtimeMs}));
  files.sort((a,b)=>b.m-a.m); return files.length?path.join(dir,files[0].n):null;
}

const merged = latestMerged();
if (!merged) { console.error('no merged config found under ~/config'); process.exit(2); }
const j = readJson(merged);
let baseUrl=null, apiKey=null, model='glm-4.6';
const walk=(o)=>{ if(!o||typeof o!=='object')return; if(o.config && o.config.auth && o.config.auth.apiKey && o.config.baseUrl){ baseUrl=o.config.baseUrl; apiKey=o.config.auth.apiKey; model=o.config.model || model; }
  if(o.provider && o.provider.config && o.provider.config.auth){ baseUrl=o.provider.config.baseUrl; apiKey=o.provider.config.auth.apiKey; model=o.provider.config.model || model; }
  for(const k of Object.keys(o)) walk(o[k]); };
walk(j);
if(!baseUrl||!apiKey){ console.error('missing GLM baseUrl/apiKey in merged config'); process.exit(3); }
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

