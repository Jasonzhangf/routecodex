#!/usr/bin/env node
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { aggregateOpenAIResponsesSSEToJSON } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.js';
import { createResponsesSSEStreamFromResponsesJson } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/responses-json-to-sse.js';

function toReadable(text){ const r=new Readable({read(){}}); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }

function canonFns(j){ const out=Array.isArray(j?.output)?j.output:[]; const fns=out.filter(o=>o?.type==='function_call').map(o=>({name:o?.name,args:o?.arguments})); const seen=new Set(); const uniq=[]; for(const f of fns){ const k=`${f.name}|${f.args}`; if(!seen.has(k)){ seen.add(k); uniq.push(f);} } return uniq.sort((a,b)=>(a.name+a.args).localeCompare(b.name+b.args)); }
function canonText(j){ try{ const out=Array.isArray(j?.output)?j.output:[]; const msg=out.find(o=>o?.type==='message'); const parts=Array.isArray(msg?.content)?msg.content:[]; const txt=parts.find(p=>p?.type==='output_text'); return String(txt?.text||''); }catch{return '';} }

async function main(){
  const file = process.argv[2]; if(!file){ console.error('Usage: node scripts/validate-responses-fixture.mjs <file.sse>'); process.exit(1); }
  const text = fs.readFileSync(file,'utf-8');
  const originJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text));
  const sse = createResponsesSSEStreamFromResponsesJson(originJSON, { requestId:'validate_responses' });
  const text2 = await new Promise((resolve)=>{ const arr=[]; sse.on('data',c=>arr.push(String(c))); sse.on('end',()=>resolve(arr.join(''))); });
  const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text2));
  const ok = canonText(originJSON)===canonText(synthJSON) && JSON.stringify(canonFns(originJSON))===JSON.stringify(canonFns(synthJSON));
  console.log(ok?'OK':'DIFF');
  process.exitCode = ok?0:2;
}

main().catch(e=>{console.error(e); process.exit(1);});

