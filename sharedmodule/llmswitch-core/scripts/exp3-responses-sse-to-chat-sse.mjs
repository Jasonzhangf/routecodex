#!/usr/bin/env node

/**
 * Experiment 3
 * Responses SSE (captured from LM Studio / C4M) → llmswitch-core → Chat JSON → Chat SSE
 * - Reads NDJSON event logs produced by scripts/capture-responses-sse.mjs
 * - Reconstructs the Responses JSON payload via the V3 SSE converter
 * - Converts to Chat JSON and synthesizes OpenAI Chat SSE for diffing
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildChatResponseFromResponses } from '../dist/conversion/responses/responses-openai-bridge.js';
import { createChatSSEStreamFromChatJson } from '../dist/conversion/streaming/json-to-chat-sse.js';
import {
  resolveEventsFilePath,
  loadResponsesEvents,
  deriveModelFromEvents,
  convertEventsToResponsesJson
} from './lib/responses-sse-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const args = {
    events: undefined,
    out: undefined,
    requestId: undefined,
    model: undefined
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === '--events' || token === '-e') && i + 1 < argv.length) {
      args.events = argv[i + 1];
      i += 1;
      continue;
    }
    if ((token === '--out' || token === '-o') && i + 1 < argv.length) {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if ((token === '--request' || token === '--request-id') && i + 1 < argv.length) {
      args.requestId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--model' && i + 1 < argv.length) {
      args.model = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function defaultOutputDir() {
  const override = process.env.LLMSWITCH_EXP3_OUTDIR;
  if (override && override.trim()) {
    return path.isAbsolute(override) ? override : path.join(projectRoot, override);
  }
  return path.join(os.homedir(), '.routecodex', 'codex-samples', 'exp3-responses-to-chat-sse');
}

async function captureChatSseStream(stream, ndjsonPath, rawPath) {
  const rawChunks = [];
  const ndjsonLines = [];
  let buffer = '';
  let frames = 0;

  const handleBlock = (block) => {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const lines = block.split('\n');
    const dataParts = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('data:')) {
        dataParts.push(line.slice('data:'.length).trim());
      }
    }
    if (!dataParts.length) return;
    const payload = dataParts.join('\n');
    const timestamp = new Date().toISOString();
    let chunk;
    if (payload === '[DONE]') {
      chunk = { done: true };
    } else {
      try {
        chunk = JSON.parse(payload);
      } catch {
        chunk = { raw: payload };
      }
    }
    ndjsonLines.push(`${JSON.stringify({ timestamp, chunk })}\n`);
    frames += 1;
  };

  const processBuffer = (flush = false) => {
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleBlock(block);
      idx = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim().length) {
      handleBlock(buffer);
      buffer = '';
    }
  };

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      rawChunks.push(text);
      buffer += text;
      processBuffer(false);
    });
    stream.on('end', () => {
      processBuffer(true);
      resolve();
    });
    stream.on('error', (err) => reject(err));
  });

  await fs.writeFile(rawPath, rawChunks.join(''), 'utf-8');
  await fs.writeFile(ndjsonPath, ndjsonLines.join(''), 'utf-8');

  return { frames };
}

function resolveLabel(eventsPath, overrideLabel) {
  if (overrideLabel) return overrideLabel;
  const base = path.basename(eventsPath);
  return base.replace('.events.ndjson', '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventsPath = await resolveEventsFilePath(args.events);
  const events = await loadResponsesEvents(eventsPath);
  const model = args.model || deriveModelFromEvents(events);
  const requestId = args.requestId || `exp3_${Date.now()}`;
  const label = resolveLabel(eventsPath, args.out);
  const outputDir = defaultOutputDir();
  await ensureDir(outputDir);

  const { response: responsesJson, meta } = await convertEventsToResponsesJson(events, {
    requestId,
    model
  });
  const chatResponse = buildChatResponseFromResponses(responsesJson);

  const responsesFile = path.join(outputDir, `${label}.responses.json`);
  const chatFile = path.join(outputDir, `${label}.chat.response.json`);
  const chatSseEventsFile = path.join(outputDir, `${label}.chat.sse.ndjson`);
  const chatSseRawFile = path.join(outputDir, `${label}.chat.sse.txt`);

  await fs.writeFile(responsesFile, JSON.stringify(responsesJson, null, 2), 'utf-8');
  await fs.writeFile(chatFile, JSON.stringify(chatResponse, null, 2), 'utf-8');

  const chatStream = createChatSSEStreamFromChatJson(chatResponse, { requestId });
  const capture = await captureChatSseStream(chatStream, chatSseEventsFile, chatSseRawFile);

  console.log('✅ Experiment 3 replay finished');
  console.log(`   Source events : ${eventsPath}`);
  console.log(`   Responses JSON: ${responsesFile}`);
  console.log(`   Chat JSON     : ${chatFile}`);
  console.log(`   Chat SSE NDJSON: ${chatSseEventsFile} (${capture.frames} frames)`);
  console.log(`   Chat SSE raw  : ${chatSseRawFile}`);
  console.log(`   Model/ReqID   : ${meta.model} / ${meta.requestId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('❌ Experiment 3 replay failed:', err?.message || err);
    process.exit(1);
  });
}
