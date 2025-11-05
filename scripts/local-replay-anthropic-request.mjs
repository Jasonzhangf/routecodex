#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  // Input: an Anthropics-style Messages request JSON
  // If omitted, try a default path under ~/.routecodex/codex-samples/anthropic-messages/
  const reqFile = process.argv[2] || path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages', 'sample_request.json');
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results', 'anthropic-replay');

  await fs.mkdir(outDir, { recursive: true });
  if (!process.env.RCC_SNAPSHOT_DIR) process.env.RCC_SNAPSHOT_DIR = path.join(outDir, 'snapshots');
  if (!process.env.RCC_FILTER_SNAPSHOT) process.env.RCC_FILTER_SNAPSHOT = '1';

  const txt = await fs.readFile(reqFile, 'utf-8');
  const raw = JSON.parse(txt);
  const requestId = raw?.requestId || `anthreq_${Date.now()}`;

  const codecUrl = pathToFileURL(path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist', 'v2', 'conversion', 'codecs', 'anthropic-openai-codec.js')).href;
  const { AnthropicOpenAIConversionCodec } = await import(codecUrl);
  const codec = new AnthropicOpenAIConversionCodec({});

  const profile = { outgoingProtocol: 'openai-chat' };
  const context = { requestId, endpoint: '/v1/messages', entryEndpoint: '/v1/messages', metadata: {} };

  const normalized = await codec.convertRequest(raw, profile, context);
  const outPath = path.join(outDir, `replay_${requestId}_convertRequest.json`);
  await fs.writeFile(outPath, JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('Anthropic convertRequest done; output written to', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });

