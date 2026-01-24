#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

function parseArgs(argv) {
  const out = { url: null, timeout: null, maxBytes: null, follow: true, headers: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--url' || a === '-u') && i + 1 < argv.length) { out.url = argv[++i]; continue; }
    if ((a === '--timeout' || a === '-t') && i + 1 < argv.length) { out.timeout = Number(argv[++i]); continue; }
    if (a === '--no-follow') { out.follow = false; continue; }
    if ((a === '--max-bytes' || a === '-m') && i + 1 < argv.length) { out.maxBytes = Number(argv[++i]); continue; }
    if ((a === '--header' || a === '-H') && i + 1 < argv.length) {
      const kv = String(argv[++i]);
      const idx = kv.indexOf(':');
      if (idx > 0) { const k = kv.slice(0, idx).trim(); const v = kv.slice(idx + 1).trim(); if (k) out.headers[k] = v; }
      continue;
    }
    if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/tools-dev/server-tools-dev/run-web-fetch.mjs --url <URL> [--timeout 12000] [--max-bytes 524288] [--no-follow] [--header "Key: Value"]');
}

async function importCoreFetcher() {
  // Prefer local sharedmodule path if exists; fallback to installed package
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '../..');
  const local = path.resolve(repoRoot, 'sharedmodule/llmswitch-core/dist/tools/web-fetch-html.js');
  try {
    const mod = await import(pathToFileURL(local).href);
    if (typeof mod?.fetchRawHtml === 'function') return mod.fetchRawHtml;
  } catch {}
  throw new Error('Cannot locate fetchRawHtml in sharedmodule/llmswitch-core/dist。请先构建 sharedmodule/llmswitch-core。');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.url) { usage(); process.exit(args.help ? 0 : 1); }
  const fetchRawHtml = await importCoreFetcher();
  const res = await fetchRawHtml(args.url, {
    timeoutMs: args.timeout || undefined,
    followRedirects: args.follow,
    maxBytes: args.maxBytes || undefined,
    headers: Object.keys(args.headers).length ? args.headers : undefined,
  });
  if (res.ok) {
    console.log('OK');
    console.log(`status: ${res.status}`);
    console.log(`content-type: ${res.contentType}`);
    const preview = res.html ?? '';
    console.log('--- html (first 2048 chars) ---');
    console.log(preview.slice(0, 2048));
  } else {
    console.log('FAIL');
    console.log(`error: ${res.error}`);
    if (res.status) console.log(`status: ${res.status}`);
    if (res.contentType) console.log(`content-type: ${res.contentType}`);
  }
}

main().catch((e) => { console.error(e); process.exit(99); });
