#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function pickLatestFinalizePre() {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  try {
    const entries = await fs.readdir(dir);
    const files = entries
      .filter(n => n.endsWith('_finalize-pre.json'))
      .map(n => path.join(dir, n));
    const stats = await Promise.all(files.map(async f => ({ f, t: (await fs.stat(f)).mtimeMs })));
    stats.sort((a,b)=>a.t - b.t);
    return stats.length ? stats[stats.length-1].f : null;
  } catch {
    return null;
  }
}

async function main() {
  // Input: OpenAI-shaped provider response, or a snapshot wrapper containing inputData
  const respFile = process.argv[2] || await pickLatestFinalizePre();
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results', 'anthropic-replay');
  if (!respFile) { console.error('No anthropic finalize-pre or response file found'); process.exit(1); }

  await fs.mkdir(outDir, { recursive: true });
  if (!process.env.RCC_SNAPSHOT_DIR) process.env.RCC_SNAPSHOT_DIR = path.join(outDir, 'snapshots');
  if (!process.env.RCC_FILTER_SNAPSHOT) process.env.RCC_FILTER_SNAPSHOT = '1';

  const txt = await fs.readFile(respFile, 'utf-8');
  const wrap = JSON.parse(txt);
  const src = wrap?.inputData || wrap?.data || wrap; // accept multiple wrappers
  const requestId = (wrap?.context?.requestId) || wrap?.requestId || `anthres_${Date.now()}`;

  const codecUrl = pathToFileURL(path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist', 'v2', 'conversion', 'codecs', 'anthropic-openai-codec.js')).href;
  const { AnthropicOpenAIConversionCodec } = await import(codecUrl);
  const codec = new AnthropicOpenAIConversionCodec({});

  const profile = { outgoingProtocol: 'anthropic-messages' };
  const context = { requestId, endpoint: '/v1/messages', entryEndpoint: '/v1/messages', metadata: {} };

  const normalized = await codec.convertResponse(src, profile, context);
  const outPath = path.join(outDir, `replay_${requestId}_convertResponse.json`);
  await fs.writeFile(outPath, JSON.stringify(normalized, null, 2), 'utf-8');
  console.log('Anthropic convertResponse done; output written to', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });

