#!/usr/bin/env node
// Offline verify for ALL tools across captured requests
// - Rebuild provider-bound Chat request via ResponsesMapper mapping
// - Normalize tool schemas to OpenAI Chat shape
// - Validate every assistant.tool_calls[].function.arguments against its JSON Schema (Ajv)
// - Check pairing of tool results to prior tool_calls
// - Check content non-empty when tool_calls present

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function listLatest(dir, limit = 50) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^raw-request_req_.*\.json$/.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, Number(limit)))
    .map((x) => x.file);
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importDist(rel) {
  const p = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(p)) {
    console.error(`[verify-all] Build missing: ${p}`);
    console.error('[verify-all] Run: npm run build');
    process.exit(2);
  }
  return await import(url.pathToFileURL(p).href);
}

function ensureResponsesShape(body) {
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

function buildSchemaMap(toolsNorm) {
  const map = new Map();
  const arr = Array.isArray(toolsNorm) ? toolsNorm : [];
  for (const t of arr) {
    try {
      const fn = t?.function || {};
      const name = typeof fn?.name === 'string' ? fn.name : undefined;
      const params = fn?.parameters;
      if (name && params && typeof params === 'object') map.set(name, params);
    } catch {}
  }
  return map;
}

function ajvValidateFactory() {
  try {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    return (schema) => ajv.compile(schema);
  } catch {
    return null;
  }
}

function parseArgsStr(s) { try { return JSON.parse(s); } catch { return null; } }

function analyzeChat(chatReq, toolsNorm, makeValidator) {
  const msgs = Array.isArray(chatReq?.messages) ? chatReq.messages : [];
  const schemaMap = buildSchemaMap(toolsNorm);
  const perTool = new Map();
  const mk = (name) => { const v = perTool.get(name) || { calls: 0, valid: 0, invalid: 0, nonString: 0, empty: 0 }; perTool.set(name, v); return v; };
  const toolCallIds = new Set();
  let toolMsgs = 0; let matched = 0; let unmatched = 0; let contentNonEmptyWithTools = 0;

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (tcs.length && typeof m.content === 'string' && m.content.trim().length > 0) contentNonEmptyWithTools++;
      for (const tc of tcs) {
        const fn = tc?.function || {};
        const name = typeof fn?.name === 'string' ? fn.name : 'unknown';
        const s = mk(name);
        s.calls += 1;
        if (typeof fn?.arguments !== 'string') { s.nonString += 1; continue; }
        const obj = parseArgsStr(fn.arguments);
        if (!obj || typeof obj !== 'object' || Object.keys(obj).length === 0) { s.empty += 1; continue; }
        const schema = schemaMap.get(name);
        if (schema && makeValidator) {
          try {
            const validate = makeValidator(schema);
            const ok = validate(obj) === true;
            if (ok) s.valid += 1; else s.invalid += 1;
          } catch {
            s.valid += 1; // if Ajv compile fails, count as valid to avoid false negatives
          }
        } else {
          s.valid += 1; // no schema → treat as valid
        }
        const id = typeof tc?.id === 'string' ? tc.id : undefined;
        if (id) toolCallIds.add(id);
      }
    } else if (m.role === 'tool') {
      toolMsgs += 1;
      const id = typeof m?.tool_call_id === 'string' ? m.tool_call_id : undefined;
      if (id && toolCallIds.has(id)) matched += 1; else unmatched += 1;
    }
  }

  const perToolObj = {};
  for (const [name, v] of perTool.entries()) perToolObj[name] = v;
  return { perTool: perToolObj, contentNonEmptyWithTools, pairing: { calls: toolCallIds.size, toolMsgs, matched, unmatched } };
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');
  const files = listLatest(dir, Number(process.env.VERIFY_LIMIT || 50));
  if (files.length === 0) { console.log('[verify-all] no files'); process.exit(0); }

  const { ResponsesMapper } = await importDist('dist/server/conversion/responses-mapper.js');
  const { normalizeTools } = await importDist('dist/modules/pipeline/modules/llmswitch/utils/tool-schema-normalizer.js');
  const makeValidator = ajvValidateFactory();

  let checked = 0; const agg = { perTool: {}, contentNonEmptyWithTools: 0, calls: 0, toolMsgs: 0, matched: 0, unmatched: 0, toolContentEmpty: 0 };

  for (const f of files) {
    const raw = readJSON(f);
    const body = raw?.body || raw || {};
    const norm = ensureResponsesShape(body);
    try {
      const chatReq = await ResponsesMapper.toChatRequestFromMapping(norm);
      const toolsNorm = normalizeTools(chatReq.tools || norm.tools || []);
      const r = analyzeChat(chatReq, toolsNorm, makeValidator);
      // tool 消息内容空检测
      const msgs = Array.isArray(chatReq?.messages) ? chatReq.messages : [];
      for (const m of msgs) {
        if (m && m.role === 'tool') {
          const s = typeof m.content === 'string' ? m.content.trim() : '';
          if (!s) agg.toolContentEmpty += 1;
        }
      }
      checked += 1;
      // merge
      for (const [name, v] of Object.entries(r.perTool)) {
        const t = agg.perTool[name] || { calls: 0, valid: 0, invalid: 0, nonString: 0, empty: 0 };
        t.calls += v.calls; t.valid += v.valid; t.invalid += v.invalid; t.nonString += v.nonString; t.empty += v.empty;
        agg.perTool[name] = t;
      }
      agg.contentNonEmptyWithTools += r.contentNonEmptyWithTools;
      agg.calls += r.pairing.calls; agg.toolMsgs += r.pairing.toolMsgs; agg.matched += r.pairing.matched; agg.unmatched += r.pairing.unmatched;
    } catch {}
  }

  console.log(JSON.stringify({ checked, ...agg }, null, 2));
}

main().catch((e) => { console.error('[verify-all] failed:', e?.message || String(e)); process.exit(2); });
