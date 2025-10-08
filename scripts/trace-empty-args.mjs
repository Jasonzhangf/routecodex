#!/usr/bin/env node
// Correlate empty tool_use inputs in pipeline-in-anth_* with nearest provider-out responses
// Goal: show whether provider's original tool_calls had non-empty arguments that should map
// to non-empty Anthropic inputs, and pinpoint that empties were introduced during conversion.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples');

function list(prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function tsFrom(p) {
  const m = path.basename(p).match(/_(\d{10,})/);
  return m ? Number(m[1]) : 0;
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importSwitch() {
  const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  if (!fs.existsSync(distPath)) {
    console.error('Build missing. Run: npm run build');
    process.exit(1);
  }
  return await import(url.pathToFileURL(distPath).href);
}

function getEmptyToolUses(anth) {
  const out = [];
  const payload = anth?.data ?? anth;
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of msgs) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const b of content) {
      if (b && b.type === 'tool_use') {
        const inp = b.input;
        const empty = !inp || typeof inp !== 'object' || Object.keys(inp).length === 0;
        if (empty) out.push({ name: String(b.name || 'tool'), input: b.input });
      }
    }
  }
  return out;
}

function nearestProvider(ts, candidates, windowMs=180000) {
  let best = null, bestd = Infinity;
  for (const p of candidates) {
    const d = Math.abs(tsFrom(p) - ts);
    if (d < bestd) { best = p; bestd = d; }
  }
  return (best && bestd <= windowMs) ? best : null;
}

function analyzeProvider(p) {
  const j = readJSON(p);
  const resp = j?.data ?? j;
  const ch = Array.isArray(resp?.choices) ? resp.choices[0] : null;
  const msg = ch?.message || {};
  const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const out = [];
  for (const tc of tcs) {
    const name = tc?.function?.name || 'tool';
    const raw = tc?.function?.arguments;
    let parsed = undefined;
    if (typeof raw === 'string') {
      try { const obj = JSON.parse(raw); if (obj && typeof obj === 'object') parsed = obj; } catch { /* ignore */ }
    }
    out.push({ name: String(name), argumentsRaw: raw, argumentsParsed: parsed });
  }
  return out;
}

async function main() {
  const anthFiles = list('pipeline-in-anth_');
  const provRespFiles = list('pipeline-out-req_');
  const provReqFiles = list('provider-out-openai_');
  if (anthFiles.length === 0 || (provRespFiles.length === 0 && provReqFiles.length === 0)) {
    console.log('No sufficient samples to trace.');
    process.exit(0);
  }
  const recentAnth = anthFiles.sort((a,b)=>tsFrom(b)-tsFrom(a)).slice(0, 30);
  const rows = [['anth_file','empty_tool','provider_file','provider_has_same_tool','provider_args_nonempty']];
  let cases = 0, mapped = 0, provHasSameTool = 0, provArgsNonEmpty = 0;

  for (const af of recentAnth) {
    const empties = getEmptyToolUses(readJSON(af));
    if (empties.length === 0) continue;
    cases += empties.length;
    const ts = tsFrom(af);
    // prefer provider response; else provider request
    let nearest = nearestProvider(ts, provRespFiles);
    let provType = 'provider-response';
    if (!nearest) { nearest = nearestProvider(ts, provReqFiles); provType = 'provider-request'; }
    if (nearest) mapped++;
    let prov = [];
    if (nearest) {
      if (provType === 'provider-response') {
        prov = analyzeProvider(nearest);
      } else {
        // provider request: messages may contain assistant.tool_calls
        const j = readJSON(nearest);
        const req = j;
        const msgs = Array.isArray(req?.messages) ? req.messages : [];
        const last = msgs.find(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls));
        const tcs = last?.tool_calls || [];
        prov = tcs.map(tc => ({ name: String(tc?.function?.name||'tool'), argumentsRaw: tc?.function?.arguments, argumentsParsed: (()=>{ try { return JSON.parse(tc?.function?.arguments||''); } catch { return null; } })() }));
      }
    }
    for (const em of empties) {
      const same = prov.find(x => x.name.toLowerCase() === em.name.toLowerCase());
      const nonEmpty = !!(same && same.argumentsParsed && Object.keys(same.argumentsParsed).length > 0);
      if (same) provHasSameTool++;
      if (nonEmpty) provArgsNonEmpty++;
      rows.push([path.basename(af), em.name, nearest ? path.basename(nearest) : '', same ? 'yes':'no', nonEmpty ? 'yes':'no'].join(','));
    }
  }

  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/trace-empty-args.csv', rows.join('\n'));
  console.log('Trace summary (last 30 Anthropic requests with empty tool inputs):');
  console.log(` empty_cases=${cases}, mapped_to_provider=${mapped}, provider_same_tool=${provHasSameTool}, provider_nonempty_args=${provArgsNonEmpty}`);
  console.log('CSV written: tmp/trace-empty-args.csv');
}

main().catch(e => { console.error('trace-empty-args failed:', e); process.exit(1); });
