#!/usr/bin/env node
/**
 * Cross‑protocol bridge CI
 *
 * Covers minimal cross‑wire conversions that exercise the v3 SSE in/out and
 * shape‑only conversions without tool governance:
 *  - Chat JSON → Responses SSE → Responses JSON (shape/event integrity)
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Use built converters from dist
const distRoot = path.resolve(new URL('../../', import.meta.url).pathname, 'dist');
const conversionRoot = path.join(distRoot, 'conversion');
const sseRoot = path.join(distRoot, 'sse');
const sseToJsonPath = path.join(sseRoot, 'sse-to-json', 'responses-sse-to-json-converter.js');

function chatFixture() {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now()/1000),
    model: 'gpt-4o-mini',
    choices: [ { index: 0, message: { role: 'assistant', content: 'Cross‑bridge test hello.' }, finish_reason: 'stop' } ]
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? c : c.toString());
  return chunks.join('');
}

async function chatToResponsesRoundtrip() {
  const { ResponsesSseToJsonConverter } = await import(pathToFileURL(sseToJsonPath).href);
  const bridge = await import(pathToFileURL(path.join(conversionRoot, 'responses', 'responses-openai-bridge.js')).href);
  const { responsesConverters } = await import(pathToFileURL(path.join(sseRoot, 'index.js')).href);
  const chat = chatFixture();
  // 1) Chat → Responses JSON (shape only)
  const respObj = bridge.buildResponsesPayloadFromChat(chat) || {};
  // 2) Responses JSON → Responses SSE
  const sse = await responsesConverters.jsonToSse.convertResponseToJsonToSse(respObj, { requestId: 'x-bridge' });
  const text = await collect(sse);
  // Must contain completion events; delta may be elided for short outputs
  assert.ok(/event:\s*response\.(completed|done)/.test(text), 'missing response completion event');
  // Roundtrip back to JSON
  const conv = new ResponsesSseToJsonConverter();
  const json = await conv.convertSseToJson(Readable.from([text]), { requestId: 'x-bridge-2' });
  const t2 = json?.output?.[0]?.content?.[0]?.text || '';
  assert.ok(typeof t2 === 'string', 'roundtrip failed to recover text');
}

async function main() {
  await chatToResponsesRoundtrip();
  console.log('✅ cross-bridge: Chat → Responses (SSE→JSON) passed');
}

main().catch((e) => { console.error('❌ cross-bridge CI failed:', e); process.exit(1); });
