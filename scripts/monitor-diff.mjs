#!/usr/bin/env node
// Monitor diff tool
// Runs the same request against (A) upstream (transparent) and (B) local chat/responses path,
// captures responses (SSE or JSON), and writes a simple diff summary.

import fs from 'node:fs/promises';
import path from 'node:path';

function nowId() { return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }

async function readJsonMaybe(p) {
  try { const t = await fs.readFile(p, 'utf8'); return JSON.parse(t); } catch { return null; }
}

function pick(obj, k, d) { try { const v = obj?.[k]; return (typeof v !== 'undefined') ? v : d; } catch { return d; } }

function parseArgs(argv) {
  const out = { request: null, protocol: 'responses', upstream: null, stream: true, host: '127.0.0.1', port: 5520, auth: null, fromCapture: null };
  for (let i=2;i<argv.length;i++) {
    const a = argv[i]; const n = argv[i+1];
    if (a === '--request' && n) { out.request = n; i++; }
    else if (a === '--from-capture' && n) { out.fromCapture = n; i++; }
    else if (a === '--protocol' && n) { out.protocol = n; i++; }
    else if (a === '--upstream' && n) { out.upstream = n; i++; }
    else if (a === '--host' && n) { out.host = n; i++; }
    else if (a === '--port' && n) { out.port = Number(n); i++; }
    else if (a === '--stream' && n) { out.stream = n === '1' || n === 'true'; i++; }
    else if (a === '--auth' && n) { out.auth = n; i++; }
  }
  return out;
}

function resolveEnvFromString(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const m = spec.match(/^env:(.+)$/i);
  if (!m) return null;
  const varName = m[1].trim();
  const val = process.env[varName];
  return val || null;
}

async function readZshEnv(varName) {
  try {
    const zshrc = await fs.readFile(path.join(process.env.HOME || process.env.USERPROFILE || '', '.zshrc'), 'utf-8');
    const lines = zshrc.split(/\r?\n/);
    for (const ln of lines) {
      const m = ln.match(new RegExp(`^(?:export\s+)?${varName}=(?:"([^"]*)"|'([^']*)'|([^#\n]+))`));
      if (m) {
        return (m[1] || m[2] || m[3] || '').trim();
      }
    }
  } catch {}
  return null;
}

async function loadMonitorUpstream() {
  const monPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'monitor.json');
  const j = await readJsonMaybe(monPath);
  const t = j?.transparent || {};
  const base = t?.endpoints?.openai || t?.endpoints?.responses || t?.endpoints?.chat || null;
  let hdr = t?.authorization || null;
  if (!hdr && t?.auth && typeof t.auth === 'object') {
    let spec = t.auth.openai;
    if (typeof spec === 'string') {
      if (/^env:/i.test(spec)) {
        const varName = spec.slice(4);
        hdr = process.env[varName] || await readZshEnv(varName);
        if (hdr && !/^Bearer\s+/i.test(hdr)) hdr = `Bearer ${hdr}`;
      } else {
        hdr = spec;
      }
    }
  }
  const wireApi = t?.wireApi || 'responses';
  const modelMapping = t?.modelMapping || {};
  const headerAllowlist = Array.isArray(t?.headerAllowlist) ? t.headerAllowlist : [];
  const extraHeaders = (t?.extraHeaders && typeof t.extraHeaders === 'object') ? t.extraHeaders : {};
  return { base, auth: hdr, wireApi, modelMapping, headerAllowlist, extraHeaders };
}

async function ensureDir(dir) { try { await fs.mkdir(dir, { recursive: true }); } catch { /* ignore */ } }

async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers||{}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text };
}

async function postSSE(url, body, headers, captureFile) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(headers||{}) }, body: JSON.stringify(body) });
  const ok = res.ok; const status = res.status; const hdrs = Object.fromEntries(res.headers.entries());
  const w = await fs.open(captureFile, 'w');
  try {
    if (!res.body) {
      await w.write(`(no body) status=${status}\n`);
      return { ok, status, headers: hdrs };
    }
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        await w.write(new TextDecoder().decode(value));
      }
    }
    return { ok, status, headers: hdrs };
  } finally { await w.close(); }
}

function summarizeSSEText(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events = {};
  for (const ln of lines) {
    if (ln.startsWith('event:')) {
      const ev = ln.slice(6).trim();
      events[ev] = (events[ev] || 0) + 1;
    }
  }
  return events;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.request && !args.fromCapture) {
    console.error('Usage: node scripts/monitor-diff.mjs --request req.json | --from-capture openai-provider-pair.json [--protocol responses|chat] [--stream 1|0] [--upstream URL] [--auth "Bearer ..."]');
    process.exit(2);
  }
  let reqBody = null;
  if (args.fromCapture) {
    const cap = await readJsonMaybe(args.fromCapture);
    if (!cap || typeof cap !== 'object') { console.error('Invalid capture file:', args.fromCapture); process.exit(2); }
    // Expect capture from openai-provider-pair: { request, response, meta }
    const req = cap?.request || cap?.data?.request;
    if (!req || typeof req !== 'object') { console.error('Capture missing request field'); process.exit(2); }
    reqBody = req;
    // Force protocol=chat for upstream when using Chat capture
    args.protocol = 'chat';
  } else {
    reqBody = await readJsonMaybe(args.request);
    if (!reqBody) { console.error('Failed to read request file:', args.request); process.exit(2); }
  }

  // Resolve upstream
  let upstreamBase = args.upstream;
  let upstreamAuth = args.auth;
  let wireApi = args.protocol;
  let modelMapping = {};
  let headerAllowlist = [];
  let extraHeaders = {};
  if (!upstreamBase) {
    const mon = await loadMonitorUpstream();
    upstreamBase = mon.base || '';
    upstreamAuth = upstreamAuth || mon.auth || null;
    wireApi = wireApi || mon.wireApi || 'responses';
    modelMapping = mon.modelMapping || {};
    headerAllowlist = mon.headerAllowlist || [];
    extraHeaders = mon.extraHeaders || {};
  }
  if (!upstreamBase) {
    console.error('No upstream base resolved. Provide --upstream or set ~/.routecodex/monitor.json transparent.endpoints.openai');
    process.exit(2);
  }

  const id = `mon_${nowId()}`;
  const baseDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'codex-samples', 'monitor-diff', id);
  await ensureDir(baseDir);

  const localBase = `http://${args.host}:${args.port}/v1`;
  const ep = (wireApi || args.protocol) === 'chat' ? '/chat/completions' : '/responses';
  const upstreamUrl = `${upstreamBase.replace(/\/?$/, '')}${ep}`;
  const localUrl = `${localBase}${ep}`;

  let hdrUp = upstreamAuth ? { Authorization: upstreamAuth, ...extraHeaders } : { ...extraHeaders };
  if (ep === '/responses') {
    // Ensure OpenAI Responses beta header for upstream
    const lower = Object.fromEntries(Object.entries(hdrUp).map(([k,v]) => [String(k).toLowerCase(), v]));
    if (!('openai-beta' in lower)) { hdrUp = { ...hdrUp, 'OpenAI-Beta': 'responses-2024-12-17' }; }
  }

  console.log('[monitor-diff] upstream =', upstreamUrl);
  console.log('[monitor-diff] local    =', localUrl);
  console.log('[monitor-diff] capture  =', baseDir);

  // A) upstream transparent capture
  const upCap = path.join(baseDir, 'upstream.' + (args.stream ? 'sse' : 'json'));
  let upRes;
  // Apply model mapping for upstream
  const upstreamBody = JSON.parse(JSON.stringify(reqBody));
  try {
    const m = upstreamBody?.model;
    if (typeof m === 'string' && modelMapping && modelMapping[m]) { upstreamBody.model = modelMapping[m]; }
  } catch {}
  if (args.stream) { upRes = await postSSE(upstreamUrl, upstreamBody, hdrUp, upCap); }
  else {
    upRes = await postJson(upstreamUrl, upstreamBody, hdrUp);
    await fs.writeFile(upCap, upRes.text, 'utf-8');
  }

  // B) local normal capture
  const lcCap = path.join(baseDir, 'local.' + (args.stream ? 'sse' : 'json'));
  let lcRes;
  if (args.stream) { lcRes = await postSSE(localUrl, reqBody, {}, lcCap); }
  else {
    lcRes = await postJson(localUrl, reqBody, {});
    await fs.writeFile(lcCap, lcRes.text, 'utf-8');
  }

  // Diff summary
  const summary = {
    id,
    protocol: args.protocol,
    stream: args.stream,
    upstream: { status: upRes.status, ok: upRes.ok },
    local: { status: lcRes.status, ok: lcRes.ok }
  };
  if (args.stream) {
    const upText = await fs.readFile(upCap, 'utf-8').catch(() => '');
    const lcText = await fs.readFile(lcCap, 'utf-8').catch(() => '');
    summary.upstream.events = summarizeSSEText(upText);
    summary.local.events = summarizeSSEText(lcText);
  } else {
    summary.upstream.size = (await fs.stat(upCap)).size;
    summary.local.size = (await fs.stat(lcCap)).size;
  }
  const sumFile = path.join(baseDir, 'summary.json');
  await fs.writeFile(sumFile, JSON.stringify(summary, null, 2), 'utf-8');

  console.log('[monitor-diff] summary:', sumFile);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('[monitor-diff] fatal', e?.message || String(e)); process.exit(1); });
