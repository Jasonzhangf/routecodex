#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');

// CI rule: goldens must be available in-repo (or via a CI fetch step).
// Prefer repo fixtures; allow local override via CODEX_SAMPLES_DIR.
const samplesRoot = String(process.env.CODEX_SAMPLES_DIR || '').trim()
  ? path.resolve(String(process.env.CODEX_SAMPLES_DIR).trim())
  : path.join(projectRoot, 'tests', 'fixtures', 'codex-samples');
const anthropicDir = path.join(samplesRoot, 'anthropic-messages');

async function pickLatestGolden() {
  const entries = await fs.readdir(anthropicDir);
  const targets = entries.filter((f) => f.endsWith('_provider-response.json')).sort();
  if (!targets.length) {
    throw new Error(`No provider-response snapshots found in ${anthropicDir}.`);
  }
  const latest = targets[targets.length - 1];
  const full = path.join(anthropicDir, latest);
  const raw = JSON.parse(await fs.readFile(full, 'utf-8'));
  const body = raw?.data?.body?.data || raw?.data?.body || raw?.data;
  if (!body || typeof body !== 'object') {
    throw new Error(`Invalid provider-response snapshot shape: ${full}`);
  }
  return { file: full, msg: body };
}

async function main() {
  const { anthropicConverters } = await import('../../dist/sse/index.js');
  const { file, msg } = await pickLatestGolden();
  const model = msg?.model || 'unknown';
  const rt = await anthropicConverters.roundTrip(msg, { requestId: `golden_rt_${Date.now()}`, model });
  // compare text content
  const origText = (msg?.content || []).find(b => b?.type === 'text')?.text || '';
  const rtText = (rt?.content || []).find(b => b?.type === 'text')?.text || '';
  assert.strictEqual(rtText, origText, 'Roundtrip text mismatch');
  console.log(`✅ Anthropic golden roundtrip passed (snapshot: ${path.basename(file)})`);
}

main().catch((e) => { console.error('❌ Anthropic golden roundtrip failed:', e); process.exit(1); });
