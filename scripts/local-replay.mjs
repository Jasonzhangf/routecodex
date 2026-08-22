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

function runOpenAIRequestCodec(payload, options) {
  const binding = loadNativeBinding();
  const fn = binding.runOpenaiOpenaiRequestCodecJson;
  if (typeof fn !== 'function') {
    throw new Error('runOpenaiOpenaiRequestCodecJson native export is required');
  }
  const raw = fn(JSON.stringify(payload ?? {}), JSON.stringify(options ?? {}));
  if (typeof raw !== 'string' || !raw) {
    throw new Error('runOpenaiOpenaiRequestCodecJson returned invalid payload');
  }
  return JSON.parse(raw);
}

async function main() {
  const reqFile = process.argv[2] || path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat', 'req_1762264740299_ifnozpv3l_raw-request.json');
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results');
  await fs.mkdir(outDir, { recursive: true });
  // Enable filter snapshots to local folder if not set
  if (!process.env.RCC_SNAPSHOT_DIR) process.env.RCC_SNAPSHOT_DIR = path.join(outDir, 'snapshots');
  if (!process.env.RCC_FILTER_SNAPSHOT) process.env.RCC_FILTER_SNAPSHOT = '1';
  const rawTxt = await fs.readFile(reqFile, 'utf-8');
  const raw = JSON.parse(rawTxt);
  const payload = raw?.body || raw;
  const requestId = (raw?.requestId) || `replay_${Date.now()}`;

  const normalized = runOpenAIRequestCodec(payload, {
    requestId,
    endpoint: '/v1/chat/completions',
    entryEndpoint: '/v1/chat/completions',
    metadata: {},
    preserveStreamField: true,
  });
  await fs.writeFile(path.join(outDir, `replay_${requestId}_convertRequest.json`), JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('convertRequest done; output written to', path.join(outDir, `replay_${requestId}_convertRequest.json`));
}

main().catch(err => { console.error(err); process.exit(1); });
