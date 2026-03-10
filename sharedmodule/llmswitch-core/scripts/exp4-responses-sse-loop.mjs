#!/usr/bin/env node

/**
 * Experiment 4
 * Responses SSE → llmswitch-core → Responses SSE
 * - Ensures our in/out bridge emits the same event ordering/shape as the captured golden samples
 * - Emits diff stats so we can validate the replay fidelity quickly
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createResponsesSSEStreamFromChatJson } from '../dist/conversion/streaming/json-to-responses-sse.js';
import {
  resolveEventsFilePath,
  loadResponsesEvents,
  deriveModelFromEvents,
  convertEventsToResponsesJson
} from './lib/responses-sse-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const args = { events: undefined, out: undefined, requestId: undefined, model: undefined };
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
  const override = process.env.LLMSWITCH_EXP4_OUTDIR;
  if (override && override.trim()) {
    return path.isAbsolute(override) ? override : path.join(projectRoot, override);
  }
  return path.join(os.homedir(), '.routecodex', 'codex-samples', 'exp4-responses-loop');
}

function resolveLabel(eventsPath, overrideLabel) {
  if (overrideLabel) return overrideLabel;
  const base = path.basename(eventsPath);
  return base.replace('.events.ndjson', '');
}

function summarizeCounts(events) {
  const counts = new Map();
  for (const ev of events) {
    const type = ev?.type || 'unknown';
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

function diffEventSequences(originalEvents, replayedEvents, limit = 10) {
  const mismatches = [];
  const max = Math.max(originalEvents.length, replayedEvents.length);
  for (let i = 0; i < max; i += 1) {
    const origType = originalEvents[i]?.type ?? '(missing)';
    const replayType = replayedEvents[i]?.type ?? '(missing)';
    if (origType !== replayType) {
      mismatches.push({ index: i, original: origType, replayed: replayType });
    }
    if (mismatches.length >= limit) break;
  }
  return mismatches;
}

async function captureResponsesSseStream(stream) {
  const rawChunks = [];
  const events = [];
  let buffer = '';

  const handleBlock = (block) => {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const lines = block.split('\n');
    let eventName = null;
    const dataParts = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataParts.push(line.slice('data:'.length).trim());
      }
    }
    if (!dataParts.length) return;
    const payloadRaw = dataParts.join('\n');
    let payload;
    if (payloadRaw === '[DONE]') {
      payload = { type: eventName || 'response.done', done: true };
    } else {
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        payload = { type: eventName || 'response.event', raw: payloadRaw };
      }
    }
    const type = eventName || payload?.type || 'response.event';
    events.push({ type, payload });
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

  return { rawText: rawChunks.join(''), events };
}

async function writeNdjsonEvents(events, targetPath) {
  const lines = events.map((ev) => JSON.stringify({ timestamp: new Date().toISOString(), event: ev }));
  await fs.writeFile(targetPath, `${lines.join('\n')}\n`, 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventsPath = await resolveEventsFilePath(args.events);
  const originalEvents = await loadResponsesEvents(eventsPath);
  const model = args.model || deriveModelFromEvents(originalEvents);
  const requestId = args.requestId || `exp4_${Date.now()}`;
  const label = resolveLabel(eventsPath, args.out);
  const outputDir = defaultOutputDir();
  await ensureDir(outputDir);

  const { response: responsesJson, meta } = await convertEventsToResponsesJson(originalEvents, {
    requestId,
    model
  });
  const responsesFile = path.join(outputDir, `${label}.responses.json`);
  const replayNdjson = path.join(outputDir, `${label}.replay.events.ndjson`);
  const replayRaw = path.join(outputDir, `${label}.replay.sse.txt`);

  await fs.writeFile(responsesFile, JSON.stringify(responsesJson, null, 2), 'utf-8');

  const replayStream = createResponsesSSEStreamFromChatJson(responsesJson, { requestId });
  const replayCapture = await captureResponsesSseStream(replayStream);
  await fs.writeFile(replayRaw, replayCapture.rawText, 'utf-8');
  await writeNdjsonEvents(replayCapture.events, replayNdjson);

  const diffs = diffEventSequences(originalEvents, replayCapture.events);
  const originalCount = originalEvents.length;
  const replayCount = replayCapture.events.length;
  const countsOriginal = summarizeCounts(originalEvents);
  const countsReplay = summarizeCounts(replayCapture.events);

  console.log('✅ Experiment 4 replay finished');
  console.log(`   Source events : ${eventsPath}`);
  console.log(`   Responses JSON: ${responsesFile}`);
  console.log(`   Replay SSE NDJSON: ${replayNdjson}`);
  console.log(`   Replay SSE raw : ${replayRaw}`);
  console.log(`   Event counts   : original=${originalCount} / replay=${replayCount}`);
  if (!diffs.length && originalCount === replayCount) {
    console.log('   Sequence diff  : ✅ matches');
  } else {
    console.log(`   Sequence diff  : ❌ ${diffs.length} mismatch(es) (showing up to 10)`);
    diffs.forEach((d) => console.log(`     idx ${d.index}: original=${d.original} | replay=${d.replayed}`));
  }
  console.log('   Original distribution:', Object.fromEntries(countsOriginal));
  console.log('   Replay distribution  :', Object.fromEntries(countsReplay));
  console.log(`   Model/ReqID          : ${meta.model} / ${meta.requestId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('❌ Experiment 4 replay failed:', err?.message || err);
    process.exit(1);
  });
}
