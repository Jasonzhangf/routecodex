#!/usr/bin/env node
// Replay a captured Anthropic Messages request (pipeline-in-anth_*.json)
// through the local RouteCodex server to verify end-to-end pipeline behavior.

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { file: '', port: process.env.PORT || '5520', stream: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') out.file = args[++i];
    else if (a === '--port') out.port = args[++i];
    else if (a === '--stream') out.stream = (args[++i] || '').toLowerCase() === 'true';
  }
  return out;
}

async function pickLatestSample() {
  const dir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'codex-samples');
  const files = await fs.readdir(dir).catch(() => []);
  const list = files.filter(f => f.startsWith('pipeline-in-anth_') && f.endsWith('.json'))
    .map(f => ({ f, ts: Number(f.match(/_(\d{10,})/)?.[1] || 0) }))
    .sort((a, b) => b.ts - a.ts);
  if (!list.length) throw new Error('No pipeline-in-anth_*.json samples found');
  return path.join(dir, list[0].f);
}

function parseSSE(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
  return text.split('\n\n').filter(Boolean).map(block => {
    const entry = { raw: block };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) entry.event = line.slice(6).trim();
      if (line.startsWith('data:')) entry.data = line.slice(5).trim();
    }
    return entry;
  });
}

async function main() {
  const { file, port, stream } = parseArgs();
  const samplePath = file || await pickLatestSample();
  const sample = JSON.parse(await fs.readFile(samplePath, 'utf8'));
  const body = sample?.data || sample;
  if (typeof stream === 'boolean') body.stream = stream;
  const url = `http://127.0.0.1:${port}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': (sample.headers && (sample.headers['anthropic-version'] || sample.headers['Anthropic-Version'])) || '2023-06-01',
  };
  console.log(`[replay] POST ${url} sample=${path.basename(samplePath)} stream=${body.stream===true}`);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error(`[replay] HTTP ${res.status}`);
    try { console.error(await res.text()); } catch {}
    process.exit(1);
  }
  if (body.stream === true) {
    const reader = res.body.getReader ? res.body.getReader() : null;
    let toolSeen = false; let stopReason = null;
    console.log('[replay] streaming...');
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const e of parseSSE(value)) {
          if (!e.data) continue;
          if (e.data === '[DONE]') { console.log('[replay] DONE'); break; }
          try {
            const data = JSON.parse(e.data);
            if (e.event === 'content_block_start' && data?.content_block?.type === 'tool_use') {
              toolSeen = true; console.log(`[tool_use] name=${data.content_block.name}`);
            }
            if (e.event === 'message_delta' && data?.delta?.stop_reason) {
              stopReason = data.delta.stop_reason; console.log(`[delta] stop_reason=${stopReason}`);
            }
          } catch {}
        }
      }
      console.log(`[replay] summary: toolSeen=${toolSeen} stopReason=${stopReason}`);
    } else {
      // Node <18 fallback
      for await (const chunk of res.body) {
        for (const e of parseSSE(chunk)) { console.log(e.raw); }
      }
    }
  } else {
    const json = await res.json().catch(async () => ({ text: await res.text() }));
    console.log('[replay] response:', JSON.stringify(json).slice(0, 2000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });

