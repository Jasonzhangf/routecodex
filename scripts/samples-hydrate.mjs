#!/usr/bin/env node
// Hydrate missing/failed samples by replaying chat-req_* against live server
// Then run samples-dry-run to validate tool_calls reconstruction.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function findSampleDir(dirArg) {
  if (dirArg) return path.resolve(dirArg);
  return path.join(os.homedir(), '.routecodex', 'codex-samples');
}

function listFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f))
    .sort();
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function hydrateOne(sampleDir, chatReqFile, endpoint, force) {
  try {
    const req = readJSON(chatReqFile);
    const rid = req.requestId || path.basename(chatReqFile).replace(/^chat-req_|\.json$/g, '');
    const outFile = path.join(sampleDir, `pipeline-out-${rid}.json`);
    if (fs.existsSync(outFile) && !force) {
      return { file: chatReqFile, skipped: true };
    }

    const body = JSON.parse(JSON.stringify(req.body || {}));
    // Force non-stream for deterministic hydration
    body.stream = false;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      return { file: chatReqFile, ok: false, status: res.status, error: text.slice(0, 200) };
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    fs.writeFileSync(outFile, JSON.stringify(json, null, 2));
    return { file: chatReqFile, ok: true, outFile };
  } catch (e) {
    return { file: chatReqFile, ok: false, error: String(e?.message || e) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let dir = null; let force = false; let max = 0; let endpoint = 'http://127.0.0.1:5520/v1/openai/chat/completions';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { dir = argv[++i]; }
    else if (a === '--force') { force = true; }
    else if (a === '--max') { max = parseInt(argv[++i] || '0', 10) || 0; }
    else if (a === '--endpoint') { endpoint = argv[++i] || endpoint; }
  }
  const sampleDir = findSampleDir(dir);
  if (!fs.existsSync(sampleDir)) {
    console.error(`Sample directory not found: ${sampleDir}`);
    process.exit(2);
  }
  const chatFiles = listFiles(sampleDir, 'chat-req_');
  if (chatFiles.length === 0) {
    console.log(`No chat-req_* samples found in ${sampleDir}`);
    process.exit(0);
  }

  let hydrated = 0; let skipped = 0; let failed = 0;
  const toRun = max > 0 ? chatFiles.slice(-max) : chatFiles;
  for (const f of toRun) {
    const r = await hydrateOne(sampleDir, f, endpoint, force);
    if (r.skipped) { skipped++; }
    else if (r.ok) { hydrated++; }
    else { failed++; }
    const rid = path.basename(f).slice('chat-req_'.length).replace(/\.json$/, '');
    console.log(`${r.ok ? '✓' : (r.skipped ? '•' : '✗')} ${path.basename(f)} -> pipeline-out-${rid}.json ${r.ok ? '' : (r.skipped ? '(skipped)' : `(${r.status || ''} ${r.error || ''})`)}`);
    // small pacing to avoid hammering provider
    await sleep(50);
  }
  console.log(`\nHydration summary: hydrated=${hydrated}, skipped=${skipped}, failed=${failed}, total=${toRun.length}`);

  // Optionally trigger dry-run afterwards when installed locally
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('npm', ['run', '-s', 'dry-run:samples'], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  } catch {
    // no-op
  }
}

main().catch(err => {
  console.error('samples-hydrate failed:', err);
  process.exit(1);
});

