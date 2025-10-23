#!/usr/bin/env node
// Regress all raw-request_req_*.json by rebuilding Chat via LLMSwitch (ResponsesToChatLLMSwitch)
// and checking tool message content formatting (no jsonish), pairing, and assistant content rules.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
if (!fs.existsSync(dir)) { console.log(JSON.stringify({ ok: false, error: 'no_dir', dir }, null, 2)); process.exit(0); }

function listAll() {
  return fs.readdirSync(dir).filter(f => /^raw-request_req_.*\.json$/.test(f)).map(f => path.join(dir, f));
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

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

async function importSwitch() {
  const p = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-response-chat.js');
  if (!fs.existsSync(p)) { console.error('Missing build. Run: npm run build'); process.exit(2); }
  // Provide a require scoped to the LLMSwitch module directory so its relative requires resolve correctly
  // eslint-disable-next-line no-undef
  globalThis.require = createRequire(p);
  return await import(url.pathToFileURL(p).href);
}

function analyzeChat(chat) {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : [];
  let assistantWithTools = 0, assistantContentNonEmpty = 0;
  let toolMsgs = 0, toolEmpty = 0, toolJsonish = 0;
  const jsonish = (s) => /^\s*[\[{]/.test(String(s || ''));
  const openIds = new Set();
  let matched = 0, unmatched = 0;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (tcs.length) {
        assistantWithTools += 1;
        if (typeof m.content === 'string' && m.content.trim()) assistantContentNonEmpty += 1;
        for (const tc of tcs) { const id = typeof tc?.id === 'string' ? tc.id : undefined; if (id) openIds.add(id); }
      }
    } else if (m.role === 'tool') {
      toolMsgs += 1;
      const s = typeof m.content === 'string' ? m.content : '';
      if (!s.trim()) toolEmpty += 1;
      if (jsonish(s)) toolJsonish += 1;
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
      if (id && openIds.has(id)) matched += 1; else unmatched += 1;
    }
  }
  return { assistantWithTools, assistantContentNonEmpty, toolMsgs, toolEmpty, toolJsonish, matched, unmatched };
}

async function main() {
  const files = listAll();
  const { ResponsesToChatLLMSwitch } = await importSwitch();
  const deps = { logger: { logTransformation() {}, logModule() {} } };
  let checked = 0;
  const agg = { assistantWithTools: 0, assistantContentNonEmpty: 0, toolMsgs: 0, toolEmpty: 0, toolJsonish: 0, matched: 0, unmatched: 0 };
  for (const f of files) {
    const raw = readJSON(f); if (!raw) continue;
    const body = raw?.body || raw || {};
    const norm = ensureResponses(body);
    try {
      const sw = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
      await sw.initialize();
      const dto = await sw.processIncoming({ data: norm, route: { providerId: 'unknown', modelId: String(norm?.model||'unknown'), requestId: 'regress', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } });
      const chat = dto?.data;
      const r = analyzeChat(chat);
      agg.assistantWithTools += r.assistantWithTools;
      agg.assistantContentNonEmpty += r.assistantContentNonEmpty;
      agg.toolMsgs += r.toolMsgs; agg.toolEmpty += r.toolEmpty; agg.toolJsonish += r.toolJsonish;
      agg.matched += r.matched; agg.unmatched += r.unmatched;
      checked += 1;
    } catch (e) {
      console.error('[regress-llmswitch] failed for', f, e?.message || String(e));
    }
  }
  console.log(JSON.stringify({ files: files.length, checked, ...agg }, null, 2));
}

main().catch(e => { console.error('[regress-llmswitch] error', e?.message || String(e)); process.exit(2); });
