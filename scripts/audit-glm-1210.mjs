#!/usr/bin/env node
// Audit captured GLM outbound payloads for 1210 risk patterns.
// Checks:
//  - Historical assistant.tool_calls present (tool_calls before the last assistant message)
//  - stream flag set to true (GLM coding endpoint expects non-streaming)

import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples');

function list(prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f))
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

function auditPayload(j) {
  const payload = j && typeof j === 'object' && (j.data || j) || {};
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  let lastAssistant = -1;
  for (let i=0;i<msgs.length;i++) {
    const m = msgs[i];
    if (m && m.role === 'assistant') lastAssistant = i;
  }
  let historicalToolCalls = 0;
  for (let i=0;i<msgs.length;i++) {
    if (i === lastAssistant) continue;
    const m = msgs[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      historicalToolCalls++;
    }
  }
  const streamTrue = payload.stream === true;
  return { historicalToolCalls, streamTrue };
}

function main() {
  const files = list('provider-out-glm_');
  if (files.length === 0) {
    console.log('No provider-out-glm_* samples found.');
    process.exit(0);
  }
  let checked = 0, hist = 0, stream = 0;
  const offenders = [];
  for (const f of files.slice(0, 200)) {
    const j = readJSON(f); if (!j) continue; checked++;
    const r = auditPayload(j);
    hist += r.historicalToolCalls;
    if (r.historicalToolCalls > 0) offenders.push({ file: path.basename(f), type: 'historical_tool_calls', count: r.historicalToolCalls });
    if (r.streamTrue) { stream++; offenders.push({ file: path.basename(f), type: 'stream_true' }); }
  }
  console.log('GLM 1210 audit summary:');
  console.log(` files_checked=${checked}`);
  console.log(` historical_tool_calls_total=${hist}`);
  console.log(` stream_true_total=${stream}`);
  if (offenders.length) {
    console.log(' offenders (up to 10):');
    for (const o of offenders.slice(0,10)) {
      console.log(`  - ${o.file} :: ${o.type}${o.count?('('+o.count+')'):''}`);
    }
  }
}

main();

