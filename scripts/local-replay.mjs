#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

  // Import codec from local compiled dist
  const codecUrl = pathToFileURL(path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist', 'v2', 'conversion', 'codecs', 'openai-openai-codec.js')).href;
  const { OpenAIOpenAIConversionCodec } = await import(codecUrl);
  const codec = new OpenAIOpenAIConversionCodec({});

  const profile = { outgoingProtocol: 'openai-chat' };
  const context = { requestId, endpoint: '/v1/chat/completions', entryEndpoint: '/v1/chat/completions', metadata: {} };

  const normalized = await codec.convertRequest(payload, profile, context);
  await fs.writeFile(path.join(outDir, `replay_${requestId}_convertRequest.json`), JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('convertRequest done; output written to', path.join(outDir, `replay_${requestId}_convertRequest.json`));
}

main().catch(err => { console.error(err); process.exit(1); });
