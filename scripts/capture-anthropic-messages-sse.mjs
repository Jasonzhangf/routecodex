#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

function parseArgs(argv){ const a={}; for(let i=2;i<argv.length;i++){const x=argv[i]; if(x.startsWith('--')){const[k,v]=x.split('='); a[k.slice(2)]=v===undefined?true:v;} } return a; }
const args = parseArgs(process.argv);
const out = args.out || 'anthropic_capture.sse';
const model = args.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const prompt = args.prompt || 'Hello from Anthropic';
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/,'');

if (!apiKey) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const url = `${baseURL}/messages`;
const body = { model, max_tokens: 256, messages: [{ role:'user', content: prompt }], stream: true };
const headers = { 'content-type':'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

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
console.log('[capture][anthropic] saved to', out);

