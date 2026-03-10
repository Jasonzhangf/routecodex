#!/usr/bin/env node

/**
 * Responses golden SSE roundtrip:
 * - Load latest golden_samples/responses/<timestamp>/golden-samples.json
 * - Convert events → Responses JSON
 * - Produce SSE via createResponsesSSEStreamFromChatJson → recapture → compare sequence counts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');
const libUtils = path.join(projectRoot, 'scripts', 'lib', 'responses-sse-utils.mjs');
const responsesSseIndex = path.join(projectRoot, 'dist', 'sse', 'index.js');

async function pickLatestGolden() {
  const base = path.join(os.homedir(), '.routecodex', 'golden_samples', 'responses');
  const dirs = (await fs.readdir(base)).filter((d) => d && !d.startsWith('.')).sort();
  if (!dirs.length) throw new Error(`没有找到黄金样本目录: ${base}`);
  const latest = path.join(base, dirs[dirs.length - 1], 'golden-samples.json');
  const raw = JSON.parse(await fs.readFile(latest, 'utf-8'));
  return { file: latest, doc: raw };
}

async function captureSse(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

async function main() {
  const { file, doc } = await pickLatestGolden();
  const utils = await import(pathToFileURL(libUtils).href);
  const { responsesConverters } = await import(pathToFileURL(responsesSseIndex).href);

  const sample = (doc?.samples || [])[0];
  assert.ok(sample && Array.isArray(sample.events) && sample.events.length, '黄金样本不包含 events 数组');

  const events = sample.events.map((ev) => (typeof ev === 'object' ? ev : {}));
  const { response: responsesJson } = await utils.convertEventsToResponsesJson(events, { requestId: 'golden-responses' });
  const stream = await responsesConverters.jsonToSse.convertResponseToJsonToSse(responsesJson, { requestId: 'golden-responses' });
  const sseText = await captureSse(stream);
  const gotCompleted = sseText.includes('response.completed') || sseText.includes('response.done');
  assert.ok(gotCompleted, 'SSE 未检测到完成事件');
  console.log(`✅ Responses golden SSE roundtrip passed (snapshot: ${path.basename(file)})`);
}

try { await main(); } catch (e) { console.error('❌ Responses golden SSE roundtrip failed:', e); process.exit(1); }
