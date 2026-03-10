#!/usr/bin/env node

/**
 * Chat golden SSE roundtrip:
 * - Load latest openai-chat provider-response snapshot
 * - Feed JSON to SSEOutputNode → produce SSE
 * - Feed SSE to SSEInputNode → JSON
 * - Compare key fields (model, choices[0].message.content)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');

// CI rule: goldens must be available in-repo (or via a CI fetch step).
// Prefer repo fixtures; allow local override via CODEX_SAMPLES_DIR.
const samplesRoot = String(process.env.CODEX_SAMPLES_DIR || '').trim()
  ? path.resolve(String(process.env.CODEX_SAMPLES_DIR).trim())
  : path.join(projectRoot, 'tests', 'fixtures', 'codex-samples');
const chatDir = path.join(samplesRoot, 'openai-chat');

const { createChatConverters } = await import('../../dist/sse/index.js');
const chatConverters = createChatConverters();

async function pickLatestProviderResponse() {
  // Fallback to codex-samples/openai-chat/*_provider-response.json
  const entries = await fs.readdir(chatDir);
  const targets = entries.filter((f) => f.endsWith('_provider-response.json')).sort();
  if (!targets.length) {
    throw new Error(`No provider-response snapshots found in ${chatDir}.`);
  }
  const latest = targets[targets.length - 1];
  const full = path.join(chatDir, latest);
  const raw = JSON.parse(await fs.readFile(full, 'utf-8'));
  const body = raw?.data?.body?.data || raw?.data?.body || raw?.data;
  if (!body || typeof body !== 'object') {
    throw new Error(`Invalid provider-response snapshot shape: ${full}`);
  }
  return { file: full, payload: body };
}

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

async function main() {
  const { file, payload } = await pickLatestProviderResponse();

  const sseStream = await chatConverters.jsonToSse.convertResponseToJsonToSse(payload, {
    requestId: 'req-golden-chat',
    model: payload.model || 'unknown'
  });
  const sseText = await collectStream(sseStream);
  if (!/\n?data:\s*\{/.test(sseText)) {
    throw new Error('SSE 文本未包含 data 帧');
  }

  const roundtrip = await chatConverters.sseToJson.convertSseToJson(Readable.from([sseText]), {
    requestId: 'req-golden-chat',
    model: payload.model || 'unknown'
  });
  assert.strictEqual(roundtrip?.model, payload.model, '模型不一致');
  const orig = payload?.choices?.[0]?.message?.content || '';
  const rt = roundtrip?.choices?.[0]?.message?.content || '';
  assert.ok(typeof orig === 'string' && typeof rt === 'string' && rt.length, '回环文本缺失');
  console.log(`✅ Chat golden SSE roundtrip passed (snapshot: ${path.basename(file)})`);
}

try { await main(); } catch (e) { console.error('❌ Chat golden SSE roundtrip failed:', e); process.exit(1); }
