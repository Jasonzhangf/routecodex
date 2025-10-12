#!/usr/bin/env node
// Diagnose where tool_use arguments are lost by correlating provider→llmswitch→HTTP response→next request
// Usage:
//   node scripts/diagnose-empty-tooluse.mjs [--rid anth_1760...] [--limit N]

import fs from 'fs/promises';
import path from 'path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const baseDir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

async function list(dir, prefix) {
  try {
    const names = await fs.readdir(dir);
    const items = await Promise.all(names
      .filter(n => !prefix || n.startsWith(prefix))
      .map(async n => {
        const full = path.join(dir, n);
        try { const st = await fs.stat(full); return { name: n, full, mtimeMs: st.mtimeMs }; } catch { return null; }
      }));
    return items.filter(Boolean).sort((a,b) => b.mtimeMs - a.mtimeMs);
  } catch { return []; }
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

function extractEmptyToolUsesFromAnthReq(j) {
  const out = [];
  try {
    const messages = Array.isArray(j?.data?.messages) ? j.data.messages : [];
    for (const m of messages) {
      if (m?.role !== 'assistant') continue;
      const content = Array.isArray(m?.content) ? m.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use') {
          const input = c.input;
          const empty = !input || (typeof input === 'object' && Object.keys(input).length === 0);
          if (empty) out.push({ id: c.id || null, name: c.name || null });
        }
      }
    }
  } catch {}
  return out;
}

function summarizeAnthResp(j) {
  const tu = [];
  try {
    const content = Array.isArray(j?.data?.content) ? j.data.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use') {
        tu.push({ id: c.id || null, name: c.name || null, input: c.input || null });
      }
    }
  } catch {}
  return tu;
}

function summarizeLlmswitch(j) {
  const tu = [];
  try {
    const out = j?.outputSummary?.anthropic_tool_use;
    if (Array.isArray(out)) {
      for (const b of out) { tu.push({ id: b?.id || null, name: b?.name || null, input: b?.input || null }); }
    }
  } catch {}
  return tu;
}

function summarizeProviderPair(j) {
  const calls = [];
  try {
    const toolCalls = j?.response?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const t of toolCalls) {
        calls.push({ id: t?.id || null, name: t?.function?.name || null, args: t?.function?.arguments ?? null });
      }
    }
  } catch {}
  return calls;
}

async function main() {
  const args = process.argv.slice(2);
  let rid = null; let limit = 1;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--rid') { rid = args[++i]; }
    else if (args[i] === '--limit') { limit = Number(args[++i]||'1')||1; }
  }
  const reqFiles = await list(baseDir, 'anthropic-request-');
  const targets = [];
  if (rid) {
    const f = reqFiles.find(x => x.name.includes(rid));
    if (f) targets.push(f); else { console.error(`No anthropic-request for ${rid}`); process.exit(2); }
  } else {
    // pick latest requests that contain empty tool_use
    for (const item of reqFiles) {
      const j = await readJson(item.full);
      const empties = extractEmptyToolUsesFromAnthReq(j);
      if (empties.length) { targets.push(item); if (targets.length >= limit) break; }
    }
  }
  if (!targets.length) { console.log('No requests with empty tool_use found.'); return; }

  for (const t of targets) {
    const req = await readJson(t.full);
    const requestId = req?.requestId || t.name.replace('anthropic-request-','').replace('.json','');
    const empties = extractEmptyToolUsesFromAnthReq(req);
    const diag = { requestId, file: t.name, empty_tool_uses: empties, stages: {} };

    // Find closest llmswitch response trace for same rid
    const traces = await list(baseDir, 'llmswitch-trace_openai-to-anth-response_');
    const trace = traces.find(x => x.name.includes(requestId)) || traces[0];
    const traceJson = trace ? await readJson(trace.full) : null;
    const llmTU = traceJson ? summarizeLlmswitch(traceJson) : [];
    diag.stages.llmswitch = { file: trace?.name || null, tool_use: llmTU };

    // Find closest anthropic-response for same rid
    const resps = await list(baseDir, 'anthropic-response-anth_');
    const resp = resps.find(x => x.name.includes(requestId));
    const respJson = resp ? await readJson(resp.full) : null;
    const respTU = respJson ? summarizeAnthResp(respJson) : [];
    diag.stages.http_response = { file: resp?.name || null, tool_use: respTU };

    // Provider pairs: scan latest few for ids
    const pairs = await list(baseDir, 'openai-provider-pair_');
    // Build quick index by id
    const pairHits = [];
    for (const p of pairs.slice(0,50)) {
      const pj = await readJson(p.full);
      const calls = summarizeProviderPair(pj);
      for (const e of empties) {
        const hit = calls.find(c => c.id === e.id);
        if (hit) { pairHits.push({ file: p.name, id: hit.id, name: hit.name, args: hit.args }); }
      }
    }
    diag.stages.provider = { hits: pairHits };

    // Decide drop points per id
    const results = [];
    for (const e of empties) {
      const pid = pairHits.find(h => h.id === e.id);
      const ltu = llmTU.find(u => u.id === e.id);
      const rtu = respTU.find(u => u.id === e.id);
      results.push({
        id: e.id, name: e.name,
        provider_args_present: !!(pid && typeof pid.args === 'string' && pid.args.trim()),
        llmswitch_input_present: !!(ltu && isObject(ltu.input) && Object.keys(ltu.input||{}).length>0),
        http_response_input_present: !!(rtu && isObject(rtu.input) && Object.keys(rtu.input||{}).length>0)
      });
    }
    diag.analysis = results;

    const outFile = path.join(baseDir, `drop-diagnosis-${requestId}.json`);
    await fs.writeFile(outFile, JSON.stringify(diag, null, 2), 'utf-8');
    console.log(`Diagnosis written: ${outFile}`);
  }
}

main().catch(err => { console.error('diagnose failed:', err); process.exit(1); });

