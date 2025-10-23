#!/usr/bin/env node
// Verify shell tool_calls arguments splitting using ResponsesMapper mapping
// - Scans ~/.routecodex/codex-samples/anth-replay for latest 20 raw-request_req_*.json
// - For each, rebuild provider-bound Chat request via dist/server/conversion/responses-mapper.js
// - Count shell tool_calls with arguments.command split into array ["ls","-la"] vs bad cases

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function listLatestRawRequests(dir, limit = 20) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /^raw-request_req_.*\.json$/.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, Number(limit)));
  return files.map((x) => x.file);
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importDist(moduleRelPath) {
  const p = path.resolve(process.cwd(), moduleRelPath);
  if (!fs.existsSync(p)) {
    console.error(`[verify] Build missing: ${p}`);
    console.error('[verify] Run: npm run build');
    process.exit(2);
  }
  return await import(url.pathToFileURL(p).href);
}

function ensureResponsesShape(body) {
  // Minimal normalization: if Chat-shaped, derive a Responses-like shape so ResponsesMapper can work
  try {
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
  } catch { /* ignore */ }
  // Already Responses-like or unknown shape; pass through
  return body;
}

function extractShellCalls(openaiChatReq) {
  const calls = [];
  const msgs = Array.isArray(openaiChatReq?.messages) ? openaiChatReq.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'assistant') continue;
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of tcs) {
      const fn = tc?.function || {};
      const name = typeof fn?.name === 'string' ? fn.name : '';
      if (name !== 'shell') continue;
      calls.push(fn);
    }
  }
  return calls;
}

function isSplitOk(fn) {
  const raw = fn?.arguments;
  const parse2 = (v) => { let x = v; for (let i = 0; i < 2 && typeof x === 'string'; i++) { try { x = JSON.parse(x); } catch { break; } } return x; };
  const obj = parse2(raw);
  if (!obj || typeof obj !== 'object') return false;
  const cmd = obj.command;
  if (Array.isArray(cmd)) {
    // Good if array of strings and none contain spaces that indicate no split was done
    return cmd.length > 0 && cmd.every((s) => typeof s === 'string') && !(
      cmd.length === 1 && typeof cmd[0] === 'string' && /\s/.test(cmd[0])
    );
  }
  if (typeof cmd === 'string') return false;
  return false;
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
  const files = listLatestRawRequests(dir, Number(process.env.VERIFY_LIMIT || 20));
  if (files.length === 0) {
    console.log('[verify] No raw-request_req_*.json files found.');
    process.exit(0);
  }

  // Import mapping utilities from dist
  const { ResponsesMapper } = await importDist('dist/server/conversion/responses-mapper.js');

  let checked = 0, shellCalls = 0, splitOk = 0, splitBad = 0;

  for (const f of files) {
    const raw = readJSON(f);
    if (!raw) continue;
    const body = raw?.body || raw;
    const norm = ensureResponsesShape(body);
    try {
      const chatReq = await ResponsesMapper.toChatRequestFromMapping(norm);
      const calls = extractShellCalls(chatReq);
      for (const fn of calls) {
        shellCalls += 1;
        if (isSplitOk(fn)) splitOk += 1; else splitBad += 1;
      }
      checked += 1;
    } catch (e) {
      // count as checked but no calls extracted
      checked += 1;
    }
  }

  const summary = { checked, shellCalls, splitOk, splitBad };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('[verify] failed:', e?.message || String(e)); process.exit(2); });

