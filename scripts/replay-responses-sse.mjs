#!/usr/bin/env node
// Offline replay for Responses SSE: take a snapshot JSON (finalize-pre/post or raw Chat JSON),
// run through core finalize → bridge → SSE synth, and print a concise summary.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function pickChatPayload(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  // Hooks snapshots shape: { context, inputData: { data: <chatLike> } }
  if ('inputData' in obj && obj.inputData && typeof obj.inputData === 'object') {
    const id = obj.inputData;
    if ('data' in id && id.data && typeof id.data === 'object') return id.data;
  }
  // Fallback: snapshots or pipeline dtos that use { data: <chatLike> }
  if ('data' in obj && obj.data && typeof obj.data === 'object') {
    const d = obj.data;
    if (d && typeof d === 'object' && 'data' in d) return d.data;
    return d;
  }
  return obj;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/replay-responses-sse.mjs <snapshot.json>');
    process.exit(1);
  }
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  let raw;
  try {
    const text = await fs.readFile(abs, 'utf-8');
    raw = JSON.parse(text);
  } catch (e) {
    console.error('Failed to read/parse JSON:', e?.message || String(e));
    process.exit(2);
  }

  // Prefer vendor dist build of llmswitch-core
  const coreBase = path.resolve(__dirname, '../vendor/rcc-llmswitch-core/dist/v2/conversion');
  const finalizeMod = await import(path.join(coreBase, 'shared/openai-finalizer.js'));
  const bridgeMod = await import(path.join(coreBase, 'responses/responses-openai-bridge.js'));
  const sseMod = await import(path.join(coreBase, 'streaming/json-to-responses-sse.js'));

  const requestId = (() => {
    const bn = path.basename(abs).replace(/\.json$/i, '');
    const m = /req[_-]/i.test(bn) ? bn : `req_${Date.now()}`;
    return m;
  })();

  // Unwrap snapshot → Chat JSON
  const chatLike = pickChatPayload(raw);
  // Finalize Chat JSON (idempotent)
  const finalized = await finalizeMod.finalizeOpenAIChatResponse(chatLike, { requestId, endpoint: '/v1/responses' });
  // Map to Responses JSON (non-stream)
  const mapped = bridgeMod.buildResponsesPayloadFromChat(finalized, undefined);

  // Summarize mapping
  const outputText = (mapped && typeof mapped === 'object') ? (mapped.output_text || '') : '';
  const ra = (mapped && typeof mapped === 'object' && mapped.required_action && mapped.required_action.type === 'submit_tool_outputs')
    ? (Array.isArray(mapped.required_action.submit_tool_outputs?.tool_calls) ? mapped.required_action.submit_tool_outputs.tool_calls.length : 0)
    : 0;

  // Generate synthetic Responses SSE from Chat JSON
  const readable = sseMod.createResponsesSSEStreamFromChatJson(finalized, { requestId });
  const stats = { textDelta: 0, ra: 0, completed: 0, done: 0, doneToken: 0 };
  let chunks = 0;
  await new Promise((resolve) => {
    readable.on('data', (buf) => {
      try {
        const s = buf.toString();
        chunks++;
        if (s.includes('event: response.output_text.delta')) stats.textDelta++;
        if (s.includes('event: response.required_action')) stats.ra++;
        if (s.includes('event: response.completed')) stats.completed++;
        if (s.includes('event: response.done')) stats.done++;
        if (s.includes('data: [DONE]')) stats.doneToken++;
      } catch { /* ignore */ }
    });
    readable.on('end', resolve);
    readable.on('error', resolve);
  });

  // Print concise summary
  console.log('— Replay Summary —');
  console.log('file:', abs);
  console.log('requestId:', requestId);
  console.log('mapped.output_text.length:', typeof outputText === 'string' ? outputText.length : 0);
  console.log('mapped.required_action.tool_calls:', ra);
  console.log('sse: chunks=%d textDelta=%d required_action=%d completed=%d done=%d doneToken=%d',
    chunks, stats.textDelta, stats.ra, stats.completed, stats.done, stats.doneToken);
}

main().catch((e) => {
  console.error('replay failed:', e?.message || String(e));
  process.exit(3);
});
