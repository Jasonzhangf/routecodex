#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

function loadNativeBinding() {
  return nodeRequire(
    path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
  );
}

function runOpenAIResponseCodec(payload, options) {
  const binding = loadNativeBinding();
  const fn = binding.runOpenaiOpenaiResponseCodecJson;
  if (typeof fn !== 'function') {
    throw new Error('runOpenaiOpenaiResponseCodecJson native export is required');
  }
  const raw = fn(JSON.stringify(payload ?? {}), JSON.stringify(options ?? {}));
  if (typeof raw !== 'string' || !raw) {
    throw new Error('runOpenaiOpenaiResponseCodecJson returned invalid payload');
  }
  return JSON.parse(raw);
}

async function pickLatestProviderResponse() {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  const entries = await fs.readdir(dir).catch(()=>[]);
  const files = entries.filter(n => n.endsWith('_provider-response.json')).map(n => path.join(dir, n));
  files.sort((a,b)=>fs.stat(a).mtimeMs - fs.stat(b).mtimeMs);
  return files.length ? files[files.length-1] : null;
}

async function main() {
  const respFile = process.argv[2] || await pickLatestProviderResponse();
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results');
  if (!respFile) { console.error('No provider-response file found'); process.exit(1); }
  await fs.mkdir(outDir, { recursive: true });
  if (!process.env.RCC_SNAPSHOT_DIR) process.env.RCC_SNAPSHOT_DIR = path.join(outDir, 'snapshots');
  if (!process.env.RCC_FILTER_SNAPSHOT) process.env.RCC_FILTER_SNAPSHOT = '1';

  const txt = await fs.readFile(respFile, 'utf-8');
  const obj = JSON.parse(txt);
  const payload = obj?.data || obj; // accept wrapped
  const requestId = (obj?.requestId) || `replay_${Date.now()}`;

  const normalized = runOpenAIResponseCodec(payload, {
    requestId,
    endpoint: '/v1/chat/completions',
    entryEndpoint: '/v1/chat/completions',
    metadata: {},
  });
  const outPath = path.join(outDir, `replay_${requestId}_convertResponse.json`);
  await fs.writeFile(outPath, JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('convertResponse done; output written to', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });
