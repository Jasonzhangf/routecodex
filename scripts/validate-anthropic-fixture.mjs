#!/usr/bin/env node
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { aggregateAnthropicSSEToJSON } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-messages-sse-to-json.js';
import { createAnthropicSSEStreamFromAnthropicJson } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/anthropic-json-to-sse.js';

function toReadable(text){ const r=new Readable({read(){}}); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }
function canonContent(j){ const c=Array.isArray(j?.content)?j.content:[]; const pick=c.map(x=>x?.type==='text'?{type:'text',text:String(x?.text||'')}:x?.type==='tool_use'?{type:'tool_use',name:x?.name,input:JSON.stringify(x?.input??{})}:null).filter(Boolean); return JSON.stringify(pick); }

async function main(){
  const file = process.argv[2]; if(!file){ console.error('Usage: node scripts/validate-anthropic-fixture.mjs <file.sse>'); process.exit(1); }
  const text = fs.readFileSync(file,'utf-8');
  const originJSON = await aggregateAnthropicSSEToJSON(toReadable(text));
  const sse = createAnthropicSSEStreamFromAnthropicJson(originJSON, { requestId:'validate_anth' });
  const text2 = await new Promise((resolve)=>{ const arr=[]; sse.on('data',c=>arr.push(String(c))); sse.on('end',()=>resolve(arr.join(''))); });
  const synthJSON = await aggregateAnthropicSSEToJSON(toReadable(text2));
  const ok = canonContent(originJSON)===canonContent(synthJSON);
  console.log(ok?'OK':'DIFF');
  process.exitCode = ok?0:2;
}

main().catch(e=>{console.error(e); process.exit(1);});

