#!/usr/bin/env node
import { Readable } from 'node:stream';

// Import from compiled dist of llmswitch-core for runtime
const { createChatSSEStreamFromChatJson } = await import('../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/json-to-chat-sse.js');
const { OpenAISSEParser } = await import('../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-sse-parser.js');

process.env.ROUTECODEX_SNAPSHOT_ENABLE = process.env.ROUTECODEX_SNAPSHOT_ENABLE ?? '0';

function makeLongText(n) {
  const unit = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  let s = '';
  while (s.length < n) s += unit;
  return s.slice(0, n);
}

const content = makeLongText(Number(process.env.SAMPLE_LEN || 8192));
const chatJson = {
  id: 'chatcmpl_SAMPLE',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content } }]
};

console.log('[sample] generating SSE for long content...', content.length);
const sse = createChatSSEStreamFromChatJson(chatJson, { requestId: 'req_sample' });

// Aggregate via parser to measure effective payload size
const t0 = Date.now();
let totalLen = 0;
await new Promise((resolve) => {
  const parser = new OpenAISSEParser(sse, (obj) => {
    try {
      const delta = obj?.choices?.[0]?.delta;
      if (delta && typeof delta.content === 'string') totalLen += delta.content.length;
    } catch {}
  }, resolve);
  parser.start();
});
const dt = Date.now() - t0;
console.log('[sample] aggregated delta length:', totalLen, 'timeMs=', dt);

if (totalLen !== content.length) {
  console.error('[sample] mismatch in delta length');
  process.exitCode = 1;
}
