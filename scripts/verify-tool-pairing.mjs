#!/usr/bin/env node
// Verify that tool_result/tool_message items pair to preceding assistant tool_calls by ID
// - Rebuild Chat request via ResponsesMapper and scan messages for assistant tool_calls → tool messages pairing

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function listLatest(dir, limit = 20) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^raw-request_req_.*\.json$/.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, Number(limit)))
    .map((x) => x.file);
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importMapper() {
  const p = path.resolve(process.cwd(), 'dist/server/conversion/responses-mapper.js');
  if (!fs.existsSync(p)) { console.error('Missing build. Run: npm run build'); process.exit(2); }
  return await import(url.pathToFileURL(p).href);
}

function ensureResponses(body) {
  if (Array.isArray(body?.messages)) {
    const sys = [];
    const user = [];
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'system' && typeof m.content === 'string' && m.content.trim()) sys.push(m.content.trim());
      if (m.role === 'user') {
        if (typeof m.content === 'string' && m.content.trim()) user.push(m.content.trim());
        else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) user.push(part.text.trim());
            else if (typeof part === 'string' && part.trim()) user.push(part.trim());
          }
        }
      }
    }
    const out = { model: String(body?.model || 'unknown'), stream: false };
    if (sys.length) out.instructions = sys.join('\n\n');
    if (user.length) out.input = user.join('\n');
    if (typeof body?.tools !== 'undefined') out.tools = body.tools;
    if (typeof body?.tool_choice !== 'undefined') out.tool_choice = body.tool_choice;
    if (typeof body?.parallel_tool_calls !== 'undefined') out.parallel_tool_calls = body.parallel_tool_calls;
    return out;
  }
  return body;
}

function analyzePairing(chatReq) {
  const msgs = Array.isArray(chatReq?.messages) ? chatReq.messages : [];
  const openIds = new Set();
  const toolMsgs = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = typeof tc?.id === 'string' ? tc.id : undefined;
        if (id) openIds.add(id);
      }
    }
    if (m.role === 'tool') {
      toolMsgs.push(m);
    }
  }
  let matched = 0; let unmatched = 0;
  for (const tm of toolMsgs) {
    const id = typeof tm?.tool_call_id === 'string' ? tm.tool_call_id : undefined;
    if (id && openIds.has(id)) matched++; else unmatched++;
  }
  return { calls: openIds.size, toolMsgs: toolMsgs.length, matched, unmatched };
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
  const files = listLatest(dir, Number(process.env.VERIFY_LIMIT || 20));
  if (files.length === 0) { console.log('[pair] no files'); process.exit(0); }
  const { ResponsesMapper } = await importMapper();
  let checked = 0, calls = 0, toolMsgs = 0, matched = 0, unmatched = 0;
  for (const f of files) {
    const raw = readJSON(f);
    const body = raw?.body || raw || {};
    const norm = ensureResponses(body);
    try {
      const chatReq = await ResponsesMapper.toChatRequestFromMapping(norm);
      const r = analyzePairing(chatReq);
      checked++; calls += r.calls; toolMsgs += r.toolMsgs; matched += r.matched; unmatched += r.unmatched;
    } catch {}
  }
  console.log(JSON.stringify({ checked, calls, toolMsgs, matched, unmatched }, null, 2));
}

main().catch((e) => { console.error('[pair] failed:', e?.message || String(e)); process.exit(2); });

