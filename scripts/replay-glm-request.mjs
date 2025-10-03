#!/usr/bin/env node
// Replay a captured chat-req_* against GLM with optional sanitization.
// - Reads ~/.routecodex/codex-samples/chat-req_<id>.json (or a provided --file path)
// - Produces two files under experiments/: original and sanitized payloads
// - Optionally sends both to GLM endpoint if GLM_API_KEY is provided and --send is set

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function importPreferDist(relJs) {
  // Prefer built JS in dist to avoid TS transpile
  const distPath = path.join(repoRoot, 'dist', relJs);
  return await import(url.pathToFileURL(distPath).href);
}

function usage() {
  console.log(
    [
      'Usage: node scripts/replay-glm-request.mjs [--id <chat-req-id>] [--file <path>] [--base <url>] [--send] [--tools on|off] [--key <API_KEY>] [--strip-strict-only] [--convert-only]',
      '  --id     ID part of ~/.routecodex/codex-samples/chat-req_<id>.json',
      '  --file   Absolute path to a chat-req_*.json (overrides --id)',
      '  --base   GLM base URL (default: https://open.bigmodel.cn/api/coding/paas/v4)',
      '  --send   Actually POST to GLM chat/completions (requires GLM_API_KEY env or --key)',
      '  --key    API key (Bearer token); overrides env if provided',
      '  --strip-strict-only  Send a third payload: original with only tools.function.strict removed (everything else unchanged)',
      '  --convert-only       Build a converted payload that preserves content/messages and only converts schema to GLM-compatible (no trimming)',
      '  --tools  Keep tools: on|off (default: on; off strips tools to minimize 1210)',
    ].join('\n')
  );
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function coerceRequestBody(sample) {
  const body = JSON.parse(JSON.stringify(sample?.body || {}));
  // Keep original as-is to truly reproduce
  // If stream is missing, leave undefined; GLM defaults to non-stream
  return body;
}

async function sanitizeForGLM(body, { enableTools = true } = {}) {
  const { sanitizeAndValidateOpenAIChat } = await importPreferDist('modules/pipeline/utils/preflight-validator.js');
  const result = sanitizeAndValidateOpenAIChat(body, { target: 'glm', enableTools });
  // Force non-stream in payload
  const payload = { ...result.payload, stream: false };
  return { payload, issues: result.issues };
}

function toStringContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((p) => {
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  if (value == null) return '';
  return String(value);
}

function convertToolsForGLM(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const typ = t.type || (t.function ? 'function' : undefined);
    if (typ !== 'function') continue; // unsupported tool types are skipped
    const fn = t.function || {};
    const name = typeof fn?.name === 'string' ? fn.name : undefined;
    const desc = typeof fn?.description === 'string' ? fn.description : undefined;
    let params = fn?.parameters;
    if (typeof params === 'string') {
      try { params = JSON.parse(params); } catch { /* keep stringified */ }
    }
    if (params && typeof params !== 'object') {
      params = undefined;
    }
    const tool = { type: 'function', function: {} };
    if (name) tool.function.name = name;
    if (desc) tool.function.description = desc;
    if (params) tool.function.parameters = params;
    // drop non-standard fields like strict silently (conversion, not trimming tool itself)
    out.push(tool);
  }
  return out.length ? out : undefined;
}

function convertOnlyTransform(originalBody, { keepTools = true } = {}) {
  const src = JSON.parse(JSON.stringify(originalBody || {}));
  const out = {};
  if (typeof src.model === 'string') out.model = src.model;
  const rawMsgs = Array.isArray(src.messages) ? src.messages : [];
  out.messages = rawMsgs.map((m) => {
    const role0 = typeof m?.role === 'string' ? m.role : 'user';
    const allowed = new Set(['system', 'user', 'assistant', 'tool']);
    const role = allowed.has(role0) ? role0 : 'user';
    const msg = { role };
    msg.content = toStringContent(m?.content);
    if (role === 'tool' && typeof m?.name === 'string') msg.name = m.name;
    if (role === 'tool' && typeof m?.tool_call_id === 'string') msg.tool_call_id = m.tool_call_id;
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      msg.tool_calls = m.tool_calls.map((tc) => {
        const fn = tc?.function || {};
        const name = typeof fn?.name === 'string' ? fn.name : undefined;
        const args = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments == null ? '{}' : JSON.stringify(fn.arguments));
        return { id: tc?.id, type: 'function', function: { ...(name?{name}:{ }), arguments: args } };
      });
    }
    return msg;
  });
  // keep sampling settings
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
  // thinking passthrough
  if (src.thinking && typeof src.thinking === 'object') out.thinking = src.thinking;
  // tools conversion
  if (keepTools) {
    const mapped = convertToolsForGLM(src.tools);
    if (mapped) {
      out.tools = mapped;
      out.tool_choice = 'auto';
    }
  }
  // preserve stream as-is (no forced change)
  if (typeof src.stream === 'boolean') out.stream = src.stream;
  return out;
}
async function sendToGLM(baseUrl, apiKey, payload) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': 'RouteCodex/replay-glm-request'
  };
  if (payload?.stream === true) {
    headers['Accept'] = 'text/event-stream';
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  return { ok: res.ok, status: res.status, statusText: res.statusText, body: data ?? { text } };
}

async function main() {
  const args = process.argv.slice(2);
  let id = '';
  let file = '';
  let baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
  let doSend = false;
  let keepTools = true;
  let keyArg = '';
  let stripStrictOnly = false;
  let convertOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id') id = args[++i];
    else if (a === '--file') file = args[++i];
    else if (a === '--base') baseUrl = args[++i];
    else if (a === '--send') doSend = true;
    else if (a === '--tools') { const v = (args[++i] || '').toLowerCase(); keepTools = v !== 'off'; }
    else if (a === '--key') { keyArg = args[++i] || ''; }
    else if (a === '--strip-strict-only') { stripStrictOnly = true; }
    else if (a === '--convert-only') { convertOnly = true; }
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  }

  if (!file && !id) {
    usage();
    process.exit(1);
  }

  const samplePath = file || path.join(os.homedir(), '.routecodex', 'codex-samples', `chat-req_${id}.json`);
  if (!fs.existsSync(samplePath)) {
    console.error(`Sample not found: ${samplePath}`);
    process.exit(2);
  }

  const sample = readJSON(samplePath);
  const originalBody = coerceRequestBody(sample);

  const outDir = path.join(repoRoot, 'experiments');
  ensureDir(outDir);

  const stem = sample.requestId || id || path.basename(samplePath).replace(/\.json$/, '');
  const originalOut = path.join(outDir, `glm_original_${stem}.json`);
  fs.writeFileSync(originalOut, JSON.stringify(originalBody, null, 2));

  const { payload: sanitized, issues } = await sanitizeForGLM(originalBody, { enableTools: keepTools });
  const sanitizedOut = path.join(outDir, `glm_sanitized_${stem}.json`);
  fs.writeFileSync(sanitizedOut, JSON.stringify(sanitized, null, 2));

  const issuesOut = path.join(outDir, `glm_sanitized_${stem}.issues.json`);
  fs.writeFileSync(issuesOut, JSON.stringify(issues, null, 2));

  let convertedOut = '';
  let converted = null;
  if (convertOnly) {
    converted = convertOnlyTransform(originalBody, { keepTools });
    convertedOut = path.join(outDir, `glm_converted_${stem}.json`);
    fs.writeFileSync(convertedOut, JSON.stringify(converted, null, 2));
  }

  console.log('Saved payloads:');
  console.log(' - original :', originalOut);
  console.log(' - sanitized:', sanitizedOut);
  console.log(' - issues   :', issuesOut);

  if (!doSend) {
    console.log('\nDry-run complete. Use --send with GLM_API_KEY to replay.');
    return;
  }

  const apiKey = keyArg || process.env.GLM_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('Missing GLM_API_KEY (or ZHIPUAI_API_KEY/ZHIPU_API_KEY). Aborting send.');
    process.exit(3);
  }

  console.log('\nSending ORIGINAL payload to GLM ...');
  const r1 = await sendToGLM(baseUrl, apiKey, originalBody);
  fs.writeFileSync(path.join(outDir, `glm_resp_original_${stem}.json`), JSON.stringify(r1, null, 2));
  console.log(' - status:', r1.status, r1.statusText);

  console.log('Sending SANITIZED payload to GLM ...');
  const r2 = await sendToGLM(baseUrl, apiKey, sanitized);
  fs.writeFileSync(path.join(outDir, `glm_resp_sanitized_${stem}.json`), JSON.stringify(r2, null, 2));
  console.log(' - status:', r2.status, r2.statusText);

  let rConv = null;
  if (convertOnly) {
    console.log('Sending CONVERTED payload (no trimming) to GLM ...');
    rConv = await sendToGLM(baseUrl, apiKey, converted);
    fs.writeFileSync(path.join(outDir, `glm_resp_converted_${stem}.json`), JSON.stringify(rConv, null, 2));
    console.log(' - status:', rConv.status, rConv.statusText);
  }

  let r3 = null;
  if (stripStrictOnly) {
    const strictPatched = JSON.parse(JSON.stringify(originalBody));
    try {
      if (Array.isArray(strictPatched.tools)) {
        for (const t of strictPatched.tools) {
          if (t && t.type === 'function' && t.function && typeof t.function === 'object') {
            delete t.function.strict;
          }
        }
      }
    } catch {}
    fs.writeFileSync(path.join(outDir, `glm_original_strict_removed_${stem}.json`), JSON.stringify(strictPatched, null, 2));
    console.log('Sending ORIGINAL-without-strict payload to GLM ...');
    r3 = await sendToGLM(baseUrl, apiKey, strictPatched);
    fs.writeFileSync(path.join(outDir, `glm_resp_original_strict_removed_${stem}.json`), JSON.stringify(r3, null, 2));
    console.log(' - status:', r3.status, r3.statusText);
  }

  // Simple summary
  const summarize = (r) => ({ ok: r.ok, status: r.status, error: r.body?.error || r.body?.message || r.body?.text || null });
  console.log('\nSummary:', { original: summarize(r1), sanitized: summarize(r2), ...(r3?{strict_removed: summarize(r3)}:{}), ...(rConv?{converted: summarize(rConv)}:{}) });
}

main().catch((e) => { console.error('replay-glm-request failed:', e); process.exit(1); });
