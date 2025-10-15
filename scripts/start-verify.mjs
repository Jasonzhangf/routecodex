#!/usr/bin/env node
/**
 * Start RouteCodex via rcc with timeout and verify readiness.
 * - Uses background (&) by default via scripts/run-bg.sh
 * - Foreground option uses gtimeout via scripts/run-fg-gtimeout.sh
 * - Polls /ready and /health, parses logs for failure reasons
 *
 * Usage:
 *   node scripts/start-verify.mjs [--config <path>] [--timeout <sec>] [--mode bg|fg]
 * Examples:
 *   node scripts/start-verify.mjs --config ~/.routecodex/config.json --timeout 180 --mode bg
 *   node scripts/start-verify.mjs --config ~/.routecodex/config.json --timeout 60 --mode fg
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { config: `${process.env.HOME || ''}/.routecodex/config.json`, timeout: 180, mode: 'bg' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--config' || a === '-c') && args[i+1]) { out.config = args[++i]; continue; }
    if ((a === '--timeout' || a === '-t') && args[i+1]) { out.timeout = Number(args[++i]) || 180; continue; }
    if (a === '--mode' && args[i+1]) { out.mode = String(args[++i]); continue; }
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return p.replace('~', process.env.HOME || '');
  return p;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function pickPortHost(cfg) {
  const port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port);
  const host = (cfg?.httpserver?.host || cfg?.server?.host || cfg?.host || '127.0.0.1');
  const norm = (h) => {
    const v = String(h || '').toLowerCase();
    if (v === '0.0.0.0' || v === 'localhost' || v === '::' || v === '::1') return '127.0.0.1';
    return h;
  };
  return { port: Number(port) || 0, host: norm(host) };
}

function pickApiKey(cfg) {
  const vr = cfg?.virtualrouter?.providers || {};
  for (const pid of Object.keys(vr)) {
    const p = vr[pid] || {};
    if (p?.auth?.apiKey && String(p.auth.apiKey).trim()) return String(p.auth.apiKey).trim();
    if (Array.isArray(p.apiKey) && p.apiKey[0]) return String(p.apiKey[0]).trim();
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) return String(p.apiKey).trim();
  }
  const top = cfg?.providers || {};
  for (const pid of Object.keys(top)) {
    const p = top[pid] || {};
    if (p?.auth?.apiKey && String(p.auth.apiKey).trim()) return String(p.auth.apiKey).trim();
    if (Array.isArray(p.apiKey) && p.apiKey[0]) return String(p.apiKey[0]).trim();
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) return String(p.apiKey).trim();
  }
  return null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function probeReady(host, port, deadlineMs) {
  const url = `http://${host}:${port}/ready`;
  while (Date.now() < deadlineMs) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => { try { c.abort(); } catch {} }, 1200);
      const res = await fetch(url, { signal: c.signal });
      clearTimeout(t);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j?.status === 'ready') return { ok: true, data: j };
      }
    } catch {}
    await sleep(1000);
  }
  return { ok: false };
}

function analyzeLog(logPath) {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const tail = text.split(/\r?\n/).slice(-400).join('\n');
    const m = (re) => re.test(tail);
    if (m(/No pipelines assembled|pipeline.*createdPipelines: 0/i)) return { reason: 'no_pipelines', hint: 'Check pipeline_assembler.config or provider mapping' };
    if (m(/Missing credentials|OPENAI_API_KEY/i)) return { reason: 'missing_api_key', hint: 'Inject OPENAI_API_KEY or configure auth.apiKey' };
    if (m(/address already in use|EADDRINUSE/i)) return { reason: 'port_in_use', hint: 'Free the port or use another one' };
    if (m(/listen EPERM|operation not permitted/i)) return { reason: 'permission_denied', hint: 'Insufficient permission to bind host/port' };
    if (m(/Compatibility processing failed|ZOD_VALIDATION_ERROR/i)) return { reason: 'config_validation', hint: 'User config invalid for schema' };
    if (m(/Failed to start RouteCodex server/i)) return { reason: 'server_start_failed', hint: 'See log tail' };
    return { reason: 'unknown', hint: 'See log tail' };
  } catch {
    return { reason: 'no_log', hint: 'Log file missing' };
  }
}

async function main() {
  const args = parseArgs();
  const cfgPath = expandHome(args.config);
  if (!fs.existsSync(cfgPath)) {
    console.error(JSON.stringify({ ok: false, error: 'config_not_found', config: cfgPath }));
    process.exit(2);
  }
  const cfg = readJsonSafe(cfgPath) || {};
  const { port, host } = pickPortHost(cfg);
  if (!port) {
    console.error(JSON.stringify({ ok: false, error: 'port_missing', config: cfgPath }));
    process.exit(2);
  }

  const timestamp = Date.now();
  const verifyLog = path.resolve(process.cwd(), 'debug-logs', `rcc-verify-${timestamp}.log`);
  try { fs.mkdirSync(path.dirname(verifyLog), { recursive: true }); } catch {}
  const env = { ...process.env };
  if (!env.OPENAI_API_KEY) {
    const key = pickApiKey(cfg);
    if (key) env.OPENAI_API_KEY = key;
  }

  const bin = (cmd) => {
    try { return fs.existsSync(path.resolve(process.cwd(), cmd)) ? path.resolve(process.cwd(), cmd) : cmd; } catch { return cmd; }
  };

  const timeoutSec = Math.max(1, Number(args.timeout) || 180);
  let child; let bgLogPath = null; let bgPid = null;
  // Prefer local CLI if present
  const rccBin = fs.existsSync(path.resolve(process.cwd(), 'rcc')) ? path.resolve(process.cwd(), 'rcc') : 'rcc';

  if (args.mode === 'fg') {
    // Foreground via gtimeout; still capture a log via tee for analysis
    const wrapped = `${rccBin} start --config "${cfgPath}" 2>&1 | tee -a "${verifyLog}"`;
    child = spawn('bash', ['scripts/run-fg-gtimeout.sh', String(timeoutSec), '--', wrapped], { env, stdio: 'inherit' });
  } else {
    // Background via run-bg.sh; parse stdout to get pid/log
    const cmdStr = `${rccBin} start --config ${JSON.stringify(cfgPath)}`;
    const argsBg = ['scripts/run-bg.sh', '--', cmdStr, String(timeoutSec)];
    child = spawn('bash', argsBg, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => {
      const s = String(d);
      const m1 = s.match(/pid=(\d+)/);
      const m2 = s.match(/log=(\S+)/);
      if (m1) bgPid = Number(m1[1]);
      if (m2) bgLogPath = m2[1];
      // Mirror to verify log
      try { fs.appendFileSync(verifyLog, s); } catch {}
    });
  }

  // Poll readiness until timeout
  const deadline = Date.now() + timeoutSec * 1000;
  const ready = await probeReady(host, port, deadline);

  // If bg, prefer bg log for analysis; else verifyLog
  const logPath = args.mode === 'bg' ? (bgLogPath || verifyLog) : verifyLog;

  if (ready.ok) {
    const summary = { ok: true, mode: args.mode, host, port, pid: bgPid, log: logPath, status: 'ready' };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // Not ready: analyze logs
  const reason = analyzeLog(logPath);
  const summary = { ok: false, mode: args.mode, host, port, pid: bgPid, log: logPath, status: 'not_ready', ...reason };
  console.error(JSON.stringify(summary, null, 2));
  process.exit(3);
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e?.message || e) })); process.exit(2); });
