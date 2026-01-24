#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import OpenAI from 'openai';

function parseArgs(argv){ const out={}; for(let i=2;i<argv.length;i++){ const a=argv[i]; if(!a) continue; if(a.startsWith('--')){ const [k,v]=a.split('='); const key=k.replace(/^--/,''); if(typeof v==='string'&&v.length) out[key]=v; else if(i+1<argv.length && !argv[i+1].startsWith('--')) out[key]=argv[++i]; else out[key]=true; } } return out; }
function short(s,n=60){ return s.length<=n?s:(s.slice(0,n)+'…'); }
function nowIso(){ return new Date().toISOString(); }
async function readJson(file){ const abs=path.isAbsolute(file)?file:path.resolve(process.cwd(),file); const raw=await fs.readFile(abs,'utf-8'); return JSON.parse(raw); }

async function main(){
  const args=parseArgs(process.argv);
  const file=String(args.file||args.f||'');
  if(!file){ console.error('Usage: node scripts/tools-dev/responses-debug-client/run.mjs --file <payload.json> [--baseURL URL] [--apiKey KEY] [--timeout 120] [--raw]'); process.exit(1); }
  const baseURL=String(args.baseURL||'http://127.0.0.1:5520/v1');
  const apiKey=String(args.apiKey||'dummy');
  const timeoutSec=Number(args.timeout||120);
  const raw=!!args.raw;

  const body=await readJson(file);
  if (body.stream == null) body.stream = true;
  // attach client_request_id and snapshot request body
  const clientRequestId = `cli_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try{
    const meta = (body && typeof body==='object' && body.metadata && typeof body.metadata==='object') ? body.metadata : {};
    body.metadata = { ...meta, client_request_id: clientRequestId };
  }catch{}
  try{
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    const dir = path.join(String(home), '.routecodex', 'codex-samples', 'responses-client');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `${clientRequestId}_client-request.json`);
    await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), baseURL, request: body }, null, 2), 'utf-8');
    if(!raw) console.log('saved client snapshot:', out);
  }catch{}

  const client=new OpenAI({ apiKey, baseURL });
  console.log(`[${nowIso()}] connect baseURL=${baseURL}`);
  const start=Date.now();
  const stream=await client.responses.stream(body);
  let responseId='';
  let model='';
  let text='';

  const timer=setTimeout(()=>{ try{ stream.controller?.abort?.(); }catch{}; console.error('timeout'); process.exitCode=3; }, timeoutSec*1000);

  for await (const ev of stream){
    const t=ev?.type||'event';
    const d=ev?.data ?? ev;
    if(raw){ console.log('evt', t, JSON.stringify(d)); }
    switch(t){
      case 'response.created': responseId=String(d?.response?.id||responseId); model=String(d?.response?.model||model); console.log('created', responseId, model); break;
      case 'response.output_text.delta': { const s=String(d?.delta||''); text+=s; console.log('textΔ', s.length, short(s)); break; }
      case 'response.output_text.done': console.log('text✓ total', text.length); break;
      case 'response.completed': console.log('completed', JSON.stringify(d?.response?.usage||{})); break;
      case 'response.required_action': console.log('required_action', JSON.stringify(d?.required_action||d)); break;
      case 'response.error': console.error('error', JSON.stringify(d?.error||d)); process.exitCode=2; break;
      case 'response.done': { const ms=Date.now()-start; console.log('done', ms,'ms'); clearTimeout(timer); return; }
      default: break;
    }
  }
}

main().catch(e=>{ console.error('fatal', e?.message||String(e)); process.exit(2); });
