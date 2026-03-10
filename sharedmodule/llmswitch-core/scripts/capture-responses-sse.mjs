#!/usr/bin/env node

/**
 * Capture a "golden" OpenAI Responses streaming session directly from an LMStudio
 * compatible endpoint using the official Responses SDK. The script records:
 *   1. The request payload that was sent to LMStudio.
 *   2. Every SSE event emitted by LMStudio (as NDJSON for easy diffing).
 *   3. The final completed response after tool outputs are submitted.
 *
 * Usage:
 *   LMSTUDIO_BASEURL=http://127.0.0.1:1234/v1 \
 *   LMSTUDIO_API_KEY=lm-studio \
 *   node scripts/capture-responses-sse.mjs --file tools/responses-debug-client/payloads/lmstudio-tool.json
 *
 * The captures are stored under ~/.routecodex/codex-samples/openai-responses/lmstudio-golden
 * so we can diff them against our bridge output.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const args = { file: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === '--file' || token === '-f') && i + 1 < argv.length) {
      args.file = argv[i + 1];
      i += 1;
    } else if ((token === '--out' || token === '-o') && i + 1 < argv.length) {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function loadPayload(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const data = await fs.readFile(abs, 'utf-8');
  return JSON.parse(data);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function defaultPayloadPath() {
  const fallback = path.join('tools', 'responses-debug-client', 'payloads', 'lmstudio-tool.json');
  return path.join(repoRoot, fallback);
}

async function mockToolOutputs(toolCalls) {
  return toolCalls.map((call) => {
    const fn = call?.function || {};
    return {
      tool_call_id: call?.id || `tool_${Math.random().toString(36).slice(2, 10)}`,
      output: JSON.stringify({
        mocked: true,
        tool: fn?.name || 'tool',
        arguments_echo: fn?.arguments ?? null,
        note: 'replace with real tool result when running end-to-end'
      })
    };
  });
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const payloadPath = argv.file
    ? (path.isAbsolute(argv.file) ? argv.file : path.join(repoRoot, argv.file))
    : defaultPayloadPath();
  const payload = await loadPayload(payloadPath);
  payload.stream = true;

  const baseURL = process.env.LMSTUDIO_BASEURL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1234/v1';
  const apiKey = process.env.LMSTUDIO_API_KEY || process.env.OPENAI_API_KEY || 'lm-studio';

  const client = new OpenAI({ apiKey, baseURL });

  const captureDir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses', 'lmstudio-golden');
  await ensureDir(captureDir);
  const stamp = argv.out || `lmstudio-responses-${Date.now()}`;

  const requestFile = path.join(captureDir, `${stamp}.request.json`);
  const eventsFile = path.join(captureDir, `${stamp}.events.ndjson`);
  const finalFile = path.join(captureDir, `${stamp}.final.json`);

  await fs.writeFile(requestFile, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.writeFile(eventsFile, '', 'utf-8');

  console.log(`🌐 Connecting to LMStudio Responses endpoint: ${baseURL}`);
  console.log(`📄 Request payload saved to ${requestFile}`);

  const stream = await client.responses.stream(payload);
  const startTime = Date.now();
  let finalResponse = null;

  stream.on('event', async (event) => {
    const record = { timestamp: new Date().toISOString(), event };
    await fs.appendFile(eventsFile, `${JSON.stringify(record)}\n`, 'utf-8');
    if (event.type === 'response.required_action' &&
        event.required_action?.submit_tool_outputs?.tool_calls?.length) {
      const toolCalls = event.required_action.submit_tool_outputs.tool_calls;
      console.log(`🛠️  Received ${toolCalls.length} LMStudio tool call(s); mocking outputs...`);
      const outputs = await mockToolOutputs(toolCalls);
      await stream.submitToolOutputs(outputs);
    }
    if (event.type === 'response.completed') {
      finalResponse = event.response;
    }
  });

  await stream.done();
  const elapsed = Date.now() - startTime;
  if (!finalResponse) {
    finalResponse = await stream.getFinalResponse?.().catch(() => null);
  }
  if (finalResponse) {
    await fs.writeFile(finalFile, JSON.stringify(finalResponse, null, 2), 'utf-8');
  }

  console.log(`✅ Capture finished in ${elapsed}ms`);
  console.log(`   Events log : ${eventsFile}`);
  if (finalResponse) console.log(`   Final JSON : ${finalFile}`);
  else console.log('   Final JSON : (not available; check events log)');
}

main().catch((error) => {
  console.error('❌ capture-responses-sse failed:', error?.message || error);
  process.exit(1);
});
