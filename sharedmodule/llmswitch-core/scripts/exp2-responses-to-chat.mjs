#!/usr/bin/env node

/**
 * Experiment 2: Responses JSON -> llmswitch-core (V3 bridge) -> OpenAI Chat (/v1/chat/completions)
 * - No server. Unit-test style script, same pattern as capture-responses-sse.mjs
 * - Reads a Responses JSON payload, converts it to Chat JSON via llmswitch-core
 * - Streams from LMStudio (OpenAI-compatible) and records SSE chunks
 * - Stops on [DONE] or timeout
 *
 * Env:
 *   LMSTUDIO_BASEURL=http://127.0.0.1:1234/v1
 *   LMSTUDIO_API_KEY=lm-studio
 *   MODEL=gpt-oss-20b-mlx (overrides the model in converted Chat JSON)
 *   TIMEOUT_MS=60000
 *
 * Usage:
 *   node scripts/exp2-responses-to-chat.mjs \
 *     --file tools/responses-debug-client/payloads/lmstudio-tool.json \
 *     --out exp2-bridge
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

// Import the V3 bridge request adapter directly from dist (shape-only conversion)
import { buildChatRequestFromResponses } from '../dist/conversion/shared/responses-request-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const args = { file: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if ((t === '--file' || t === '-f') && i + 1 < argv.length) { args.file = argv[i + 1]; i += 1; continue; }
    if ((t === '--out' || t === '-o') && i + 1 < argv.length) { args.out = argv[i + 1]; i += 1; continue; }
  }
  return args;
}

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }

async function loadJson(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const text = await fs.readFile(abs, 'utf-8');
  return JSON.parse(text);
}

function defaultPayloadPath() {
  return path.join(repoRoot, 'tools', 'responses-debug-client', 'payloads', 'lmstudio-tool.json');
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const payloadPath = argv.file ? (path.isAbsolute(argv.file) ? argv.file : path.join(repoRoot, argv.file)) : defaultPayloadPath();
  const responsesReq = await loadJson(payloadPath);
  // Always request streaming from LMStudio
  responsesReq.stream = true;

  const modelEnv = process.env.MODEL || 'gpt-oss-20b-mlx';
  const baseURL = process.env.LMSTUDIO_BASEURL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1234/v1';
  const apiKey = process.env.LMSTUDIO_API_KEY || process.env.OPENAI_API_KEY || 'lm-studio';
  const timeoutMs = Number(process.env.TIMEOUT_MS || 60000);

  const outDir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'exp2-responses-to-chat');
  await ensureDir(outDir);
  const stamp = argv.out || `exp2-${Date.now()}`;
  const convertedFile = path.join(outDir, `${stamp}.converted.chat.request.json`);
  const eventsFile = path.join(outDir, `${stamp}.chat.events.ndjson`);
  const finalFile = path.join(outDir, `${stamp}.chat.final.json`);

  // 1) Convert Responses -> Chat (shape-only)
  const { request: chatReq, toolsNormalized } = buildChatRequestFromResponses(responsesReq, {
    instructions: responsesReq.instructions,
    input: responsesReq.input,
    metadata: responsesReq.metadata,
    toolsRaw: responsesReq.tools,
  });
  // enforce model + stream
  chatReq.model = modelEnv;
  chatReq.stream = true;

  await fs.writeFile(convertedFile, JSON.stringify({ chatReq, toolsNormalized }, null, 2), 'utf-8');

  // 2) Stream from LMStudio Chat
  const client = new OpenAI({ apiKey, baseURL });
  const controller = new AbortController();
  const onTimeout = setTimeout(() => controller.abort('TIMEOUT'), timeoutMs);
  await fs.writeFile(eventsFile, '', 'utf-8');

  const started = Date.now();
  let lastChunk = null;
  let aggregated = { id: null, model: chatReq.model, content: '', tool_calls: [] };

  try {
    const stream = await client.chat.completions.create({ ...chatReq, stream: true, signal: controller.signal });
    for await (const chunk of stream) {
      lastChunk = chunk;
      const ts = new Date().toISOString();
      await fs.appendFile(eventsFile, `${JSON.stringify({ timestamp: ts, chunk })}\n`, 'utf-8');
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta?.content === 'string') aggregated.content += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const c of delta.tool_calls) { aggregated.tool_calls.push(c); }
      }
    }
  } catch (e) {
    if (controller.signal.aborted) {
      await fs.appendFile(eventsFile, `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'aborted', reason: String(controller.signal.reason) })}\n`, 'utf-8');
    } else {
      throw e;
    }
  } finally {
    clearTimeout(onTimeout);
  }

  const elapsed = Date.now() - started;
  const finalOut = lastChunk || { choices: [{ message: { role: 'assistant', content: aggregated.content, tool_calls: aggregated.tool_calls } }] };
  await fs.writeFile(finalFile, JSON.stringify(finalOut, null, 2), 'utf-8');

  console.log(`✅ Experiment 2 finished in ${elapsed}ms`);
  console.log(`   Converted Chat : ${convertedFile}`);
  console.log(`   Events log     : ${eventsFile}`);
  console.log(`   Final JSON     : ${finalFile}`);
}

main().catch((err) => {
  console.error('❌ exp2-responses-to-chat failed:', err?.message || err);
  process.exit(1);
});
