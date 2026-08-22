#!/usr/bin/env node
/**
 * Replay provider-error snapshots and evaluate 429 detection logic
 *
 * Usage: node scripts/replay-429-detect.mjs [limit]
 * Default limit: 10 latest provider-error snapshots in openai-chat folder.
 */
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '~';
const baseDir = path.join(home, '.routecodex', 'codex-samples', 'openai-chat');

const limit = Number(process.argv[2] || 10);

function getLatestProviderErrorFiles(dir, n) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('_provider-error.json'))
    .map(f => ({ f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);
  return files.map(x => x.full);
}

function parseSnapshot(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // There are two shapes depending on writer path (hooks vs fallback)
    // hooks path: { data: { body: { message: 'HTTP 429: {...}' } } }
    // fallback path: { body: { status, code, error } }
    let status;
    let code;
    let message;
    const body = (raw && raw.data && (raw.data.body ?? raw.data.bodyText ? raw.data : raw)) || raw;
    if (body && body.body && typeof body.body === 'object') {
      // fallback writer shape
      status = body.body.status;
      code = body.body.code;
      message = body.body.error || body.body.message || '';
    } else if (raw && raw.data && raw.data.body && raw.data.body.message) {
      message = String(raw.data.body.message || '');
    } else if (raw && raw.body && (raw.body.status || raw.body.code || raw.body.error)) {
      status = raw.body.status;
      code = raw.body.code;
      message = raw.body.error || '';
    }
    // If status not provided but message contains HTTP <code>, extract + synthesize code
    if (!status && typeof message === 'string') {
      const m = message.match(/HTTP\s+(\d{3})/i);
      if (m) {
        status = Number(m[1]);
        if (!code) code = `HTTP_${status}`;
      }
    }
    return { file, status, code, message };
  } catch (e) {
    return { file, error: String(e) };
  }
}

function looks429Like({ status, code }) {
  // Mirror PipelineManager detection (status or code fields; no message fallback)
  if (status === 429) return true;
  const cands = [code].filter(v => v !== undefined && v !== null);
  const known = new Set(['429', 'HTTP_429', 'TOO_MANY_REQUESTS', 'RATE_LIMITED', 'RATE_LIMIT', 'REQUEST_LIMIT_EXCEEDED', 'RATE_LIMIT_EXCEEDED']);
  for (const v of cands) {
    if (typeof v === 'number' && v === 429) return true;
    const s = String(v).trim();
    if (/^\d+$/.test(s) && Number(s) === 429) return true;
    if (known.has(s.toUpperCase())) return true;
  }
  for (const v of cands) {
    try { if (String(v).includes('429')) return true; } catch { /* ignore */ }
  }
  return false;
}

function main() {
  if (!fs.existsSync(baseDir)) {
    console.error(`[replay-429] snapshot dir missing: ${baseDir}`);
    process.exit(2);
  }
  const files = getLatestProviderErrorFiles(baseDir, limit);
  if (!files.length) {
    console.error('[replay-429] no provider-error snapshots found');
    process.exit(3);
  }
  const rows = files.map(f => parseSnapshot(f));
  for (const r of rows) {
    if (r.error) {
      console.log(JSON.stringify({ file: r.file, parseError: r.error }, null, 2));
      continue;
    }
    const hit = looks429Like(r);
    console.log(JSON.stringify({ file: path.basename(r.file), status: r.status ?? null, code: r.code ?? null, hit429: hit }, null, 2));
  }
}

main();

