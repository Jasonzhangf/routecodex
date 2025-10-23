#!/usr/bin/env node
// Scan anth-replay logs for jsonish tool content in canonical and pre-pipeline messages
// Reports totals and per-tool counts

import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
if (!fs.existsSync(dir)) {
  console.log(JSON.stringify({ ok: false, error: 'no_dir', dir }, null, 2));
  process.exit(0);
}

const list = (re) => fs.readdirSync(dir).filter(f => re.test(f)).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

const pairs = list(/^responses-final_req_.*\.json$/).slice(0, Number(process.env.LIMIT || 200)).map(({ f }) => f.replace(/^responses-final_req_/, '').replace(/\.json$/, ''));

const jsonish = (s) => /^\s*[\[{]/.test(String(s || ''));

const scanMsgs = (msgs) => {
  const toolNameById = new Map();
  let toolMsgs = 0, toolEmpty = 0, toolJsonish = 0;
  const perTool = new Map();
  const bump = (name, key) => {
    const k = name || 'unknown';
    const o = perTool.get(k) || { toolMsgs: 0, jsonish: 0, empty: 0 };
    o[key] += 1; perTool.set(k, o);
  };
  for (const m of (msgs || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = typeof tc?.id === 'string' ? tc.id : null;
        const name = typeof tc?.function?.name === 'string' ? tc.function.name : 'unknown';
        if (id) toolNameById.set(id, name);
      }
    }
    if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? m.content : '';
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
      const name = id ? toolNameById.get(id) : 'unknown';
      toolMsgs += 1; bump(name, 'toolMsgs');
      if (!c.trim()) { toolEmpty += 1; bump(name, 'empty'); }
      if (jsonish(c)) { toolJsonish += 1; const o = perTool.get(name) || { toolMsgs: 0, jsonish: 0, empty: 0 }; o.jsonish += 1; perTool.set(name, o); }
    }
  }
  const per = {}; for (const [k, v] of perTool.entries()) per[k] = v;
  return { toolMsgs, toolEmpty, toolJsonish, perTool: per };
};

const out = [];
let agg = { files: 0, canon: { toolMsgs: 0, toolEmpty: 0, toolJsonish: 0 }, pre: { toolMsgs: 0, toolEmpty: 0, toolJsonish: 0 } };
const perToolCanon = new Map();
const perToolPre = new Map();

for (const rid of pairs) {
  const files = {
    canon: path.join(dir, `llmswitch-trace_openai-canonical-request_req_${rid}.json`),
    pre: path.join(dir, `pre-pipeline_req_${rid}.json`),
  };
  const rec = { rid };
  try {
    const j = JSON.parse(fs.readFileSync(files.canon, 'utf8'));
    const msgs = (j.output && j.output.messages) || j.input?.messages || [];
    const r = scanMsgs(msgs);
    rec.canon = r;
    agg.canon.toolMsgs += r.toolMsgs; agg.canon.toolEmpty += r.toolEmpty; agg.canon.toolJsonish += r.toolJsonish;
    for (const [name, v] of Object.entries(r.perTool)) {
      const o = perToolCanon.get(name) || { toolMsgs: 0, jsonish: 0, empty: 0 };
      o.toolMsgs += v.toolMsgs; o.jsonish += v.jsonish; o.empty += v.empty; perToolCanon.set(name, o);
    }
  } catch { rec.canon = null; }
  try {
    const j = JSON.parse(fs.readFileSync(files.pre, 'utf8'));
    const msgs = j?.normalizedData?.messages || [];
    const r = scanMsgs(msgs);
    rec.pre = r;
    agg.pre.toolMsgs += r.toolMsgs; agg.pre.toolEmpty += r.toolEmpty; agg.pre.toolJsonish += r.toolJsonish;
    for (const [name, v] of Object.entries(r.perTool)) {
      const o = perToolPre.get(name) || { toolMsgs: 0, jsonish: 0, empty: 0 };
      o.toolMsgs += v.toolMsgs; o.jsonish += v.jsonish; o.empty += v.empty; perToolPre.set(name, o);
    }
  } catch { rec.pre = null; }
  agg.files += 1;
  out.push(rec);
}

const perCanon = {}; for (const [k, v] of perToolCanon.entries()) perCanon[k] = v;
const perPre = {}; for (const [k, v] of perToolPre.entries()) perPre[k] = v;

console.log(JSON.stringify({ summary: agg, perTool: { canonical: perCanon, pre: perPre }, samples: out.slice(0, 10) }, null, 2));
