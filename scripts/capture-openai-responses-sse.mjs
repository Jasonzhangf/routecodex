#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

function parseArgs(argv){ const a={}; for(let i=2;i<argv.length;i++){const x=argv[i]; if(x.startsWith('--')){const[k,v]=x.split('='); a[k.slice(2)]=v===undefined?true:v;} } return a; }
const args = parseArgs(process.argv);
const out = args.out || 'responses_capture.sse';
const model = args.model || process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
const input = args.input || 'Hello from Responses API';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');

if (!apiKey) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }

const url = `${baseURL}/responses`;
const body = { model, input, stream: true };
const headers = { 'content-type':'application/json', 'authorization': `Bearer ${apiKey}` };

const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
if (!res.ok) {
  const text = await res.text();
  console.error('Upstream error', res.status, text); process.exit(2);
}

const ws = fs.createWriteStream(out, 'utf-8');
const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  ws.write(decoder.decode(value));
}
ws.end();
console.log('[capture][responses] saved to', out);

