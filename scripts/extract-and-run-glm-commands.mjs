#!/usr/bin/env node
/**
 * Scan chat replay captures, extract assistant.tool_calls, reconstruct shell commands,
 * and (optionally) execute a safe subset via bash -lc.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CAPTURE_DIR = process.env.RCX_CAPTURE_DIR || path.join(os.homedir(), '.routecodex/codex-samples/chat-replay');
const MAX_FILES = Number(process.env.MAX_FILES || 30);
const RUN = process.env.RUN !== '0'; // default run
const MAX_RUN = Number(process.env.MAX_RUN || 10);

const CONNECTORS = new Set(['|','||','&&',';','>','>>','<','<<','2>','2>&1','&']);

function safeQuote(tok) {
  if (!tok) return "''";
  if (CONNECTORS.has(tok)) return tok; // do not quote connectors
  // simple single-quote escaping: ' -> '\''
  return `'${tok.replaceAll("'", "'\\''")}'`;
}

function reconstructCommand(args) {
  // args: {command: string | string[], workdir?: string}
  const { command } = args || {};
  if (!command) return null;
  if (Array.isArray(command)) {
    const joined = command.map(t => safeQuote(String(t))).join(' ');
    return joined;
  }
  if (typeof command === 'string') return command;
  return null;
}

function isSafeToRun(cmd) {
  // allow read-only/safe commands for proof: pwd, ls, echo, cat, find, wc, head, grep (no -R writes)
  // very conservative: disallow npm, git, rm, mv, chmod, chown, curl, wget, node scripts, make, yarn, pnpm
  const deny = /\b(npm|yarn|pnpm|git|rm|mv|chmod|chown|curl|wget|scp|ssh|node\s+[^-]|make|docker|kubectl)\b/i;
  if (deny.test(cmd)) return false;
  // also deny redirections that write
  if (/>\s*[^|]/.test(cmd) || />>\s*[^|]/.test(cmd)) return false;
  // allow everything else
  return true;
}

function runBash(cmd, cwd) {
  return new Promise((resolve) => {
    const cp = spawn('bash', ['-lc', cmd], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', d => (stdout += d.toString()));
    cp.stderr.on('data', d => (stderr += d.toString()));
    cp.on('error', (err) => resolve({ ok: false, code: -1, err: String(err) }));
    cp.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function listFiles() {
  const names = await fsp.readdir(CAPTURE_DIR).catch(() => []);
  const wanted = names.filter(n => /^(final-out|compat-out|provider-in)_req_.+\.json$/.test(n));
  const withStats = await Promise.all(wanted.map(async n => {
    const p = path.join(CAPTURE_DIR, n);
    const st = await fsp.stat(p).catch(() => null);
    return st ? { name: n, mtime: st.mtimeMs } : null;
  }));
  return withStats.filter(Boolean).sort((a,b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function extractToolCalls(obj) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.tool_calls && Array.isArray(node.tool_calls)) {
      for (const tc of node.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function || {};
        let args = fn.arguments;
        let parsed = null;
        if (typeof args === 'string') {
          try { parsed = JSON.parse(args); } catch { parsed = null; }
        } else if (args && typeof args === 'object') {
          parsed = args;
        }
        out.push({
          tool_call_id: tc.id || null,
          function_name: fn.name || null,
          raw_arguments_type: typeof args,
          arguments_obj: parsed,
        });
      }
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(obj);
  return out;
}

async function main() {
  const files = await listFiles();
  if (!files.length) {
    console.error('No capture files found in', CAPTURE_DIR);
    process.exit(1);
  }
  const results = [];
  for (const f of files) {
    const full = path.join(CAPTURE_DIR, f.name);
    let obj;
    try { obj = JSON.parse(await fsp.readFile(full, 'utf8')); } catch { continue; }
    const tcs = extractToolCalls(obj);
    for (const tc of tcs) {
      const args = tc.arguments_obj || {};
      const workdir = args.workdir || args.cwd || null;
      const cmdStr = reconstructCommand(args);
      const record = {
        source: f.name,
        tool_call_id: tc.tool_call_id,
        function_name: tc.function_name,
        workdir,
        cmd: cmdStr,
      };
      if (!cmdStr) { results.push({ ...record, status: 'no-command' }); continue; }
      const runnable = isSafeToRun(cmdStr);
      if (RUN && runnable && results.filter(r => r.status === 'ran').length < MAX_RUN) {
        const r = await runBash(cmdStr, workdir || undefined);
        results.push({ ...record, status: 'ran', ok: r.ok, code: r.code, stdout: r.stdout?.slice(0, 500), stderr: r.stderr?.slice(0, 500) });
      } else {
        results.push({ ...record, status: runnable ? 'skipped-safe-limit' : 'skipped-unsafe' });
      }
    }
  }
  // Print a concise report
  const summary = {
    scanned_files: files.length,
    attempted: results.filter(r => r.status === 'ran').length,
    skipped_unsafe: results.filter(r => r.status === 'skipped-unsafe').length,
    no_command: results.filter(r => r.status === 'no-command').length,
  };
  console.log(JSON.stringify({ summary, samples: results.slice(0, 20) }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

