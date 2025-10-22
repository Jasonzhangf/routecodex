#!/usr/bin/env node
// Regress all captured raw-request_req_*.json samples offline
// - Build Chat via ResponsesMapper mapping
// - Check: assistant with tool_calls must have empty content; tool messages must have NON-empty content
// - Validate pairing and basic schema correctness

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function listAll(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^raw-request_req_.*\.json$/.test(f))
    .map((f) => path.join(dir, f));
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importDist(rel) {
  const p = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(p)) { console.error(`[regress] Missing build: ${p}`); process.exit(2); }
  return await import(url.pathToFileURL(p).href);
}

function ensureResponses(body) {
  if (Array.isArray(body?.messages)) {
    const sys = []; const user = [];
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

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
  const files = listAll(dir);
  if (files.length === 0) { console.log('[regress] no files'); process.exit(0); }
  const { ResponsesMapper } = await importDist('dist/server/conversion/responses-mapper.js');

  let checked = 0, toolMsgs = 0, toolEmpty = 0, assistantTools = 0, assistantNonEmpty = 0, calls = 0, matched = 0, unmatched = 0;
  for (const f of files) {
    const raw = readJSON(f); if (!raw) continue;
    const body = raw?.body || raw || {};
    const norm = ensureResponses(body);
    try {
      const chat = await ResponsesMapper.toChatRequestFromMapping(norm);
      const msgs = Array.isArray(chat?.messages) ? chat.messages : [];
      const openIds = new Set();
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'assistant') {
          const tcs = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
          if (tcs.length) { assistantTools++; calls += tcs.length; if (typeof m.content === 'string' && m.content.trim()) assistantNonEmpty++; for (const tc of tcs) { const id = typeof tc?.id === 'string' ? tc.id : undefined; if (id) openIds.add(id); } }
        } else if (m.role === 'tool') {
          toolMsgs++;
          const s = typeof m?.content === 'string' ? m.content.trim() : '';
          if (!s) toolEmpty++;
          const id = typeof m?.tool_call_id === 'string' ? m.tool_call_id : undefined;
          if (id && openIds.has(id)) matched++; else unmatched++;
        }
      }
      checked++;
    } catch {}
  }
  console.log(JSON.stringify({ checked, files: files.length, assistantWithTools: assistantTools, assistantContentNonEmpty: assistantNonEmpty, toolMsgs, toolContentEmpty: toolEmpty, calls, matched, unmatched }, null, 2));
}

main().catch((e) => { console.error('[regress] failed:', e?.message || String(e)); process.exit(2); });

