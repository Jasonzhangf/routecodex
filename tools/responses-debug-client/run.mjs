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
  if(!file){ console.error('Usage: node tools/responses-debug-client/run.mjs --file <payload.json> [--baseURL URL] [--apiKey KEY] [--timeout 120] [--raw]'); process.exit(1); }
  const baseURL=String(args.baseURL||'http://127.0.0.1:5520/v1');
  const apiKey=String(args.apiKey||'dummy');
  const timeoutSec=Number(args.timeout||120);
  const raw=!!args.raw;

  const body=await readJson(file);
  if (body.stream == null) body.stream = true;

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

