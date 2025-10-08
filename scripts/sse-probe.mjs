#!/usr/bin/env node
// Probe Anthropic-style streaming from local RouteCodex server.
// Usage: PORT=5520 node scripts/sse-probe.mjs

import fetch from 'node-fetch';

const PORT = process.env.PORT || process.argv[2] || '5520';
const url = `http://127.0.0.1:${PORT}/v1/messages`;

// Minimal Anthropic Messages request with stream=true
const body = {
  model: process.env.MODEL || 'glm-4.5-air',
  stream: true,
  messages: [{ role: 'user', content: 'Say hello and then call Read tool with file_path=/etc/hosts' }],
  tools: [
    {
      name: 'Read',
      description: 'Reads a file from the local filesystem',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }
  ],
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), Number(process.env.TIMEOUT || 30000));

function parseSSEChunk(buf) {
  const text = buf.toString('utf8');
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const obj = { raw: block };
    for (const line of lines) {
      if (line.startsWith('event:')) obj.event = line.slice(6).trim();
      if (line.startsWith('data:')) obj.data = line.slice(5).trim();
    }
    return obj;
  });
}

console.log(`[probe] POST ${url}`);
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify(body),
  signal: controller.signal,
});

if (!res.ok) {
  clearTimeout(timeout);
  console.error(`[probe] HTTP ${res.status}`);
  try { console.error(await res.text()); } catch {}
  process.exit(1);
}

console.log('[probe] streaming...');
let toolUseSeen = false;
let messageDeltaSeen = false;
let stopReason = null;

async function consumeChunks(buf) {
  const chunks = parseSSEChunk(buf);
  for (const chunk of chunks) {
    if (!chunk.data) continue;
    if (chunk.data === '[DONE]') { console.log('[probe] DONE'); return true; }
    try {
      const data = JSON.parse(chunk.data);
      if (chunk.event) {
        if (chunk.event === 'content_block_start' && data?.content_block?.type === 'tool_use') {
          toolUseSeen = true;
          console.log(`[probe] tool_use start name=${data.content_block.name}`);
        }
        if (chunk.event === 'message_delta' && data?.delta?.stop_reason) {
          messageDeltaSeen = true;
          stopReason = data.delta.stop_reason;
          console.log(`[probe] message_delta stop_reason=${stopReason}`);
        }
      } else if (data?.object === 'chat.completion.chunk') {
        const choice = Array.isArray(data.choices) ? data.choices[0] : null;
        if (choice?.delta?.tool_calls) {
          toolUseSeen = true;
          console.log('[probe] tool_calls chunk emitted');
        }
      }
    } catch {
      // ignore non-JSON chunks (comments/heartbeats)
    }
  }
  return false;
}

const bodyStream = res.body;
if (typeof bodyStream.getReader === 'function') {
  const reader = bodyStream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const doneNow = await consumeChunks(value);
    if (doneNow) break;
  }
} else {
  for await (const chunk of bodyStream) {
    const doneNow = await consumeChunks(chunk);
    if (doneNow) break;
  }
}

clearTimeout(timeout);
console.log(`[probe] summary: toolUseSeen=${toolUseSeen}, messageDeltaSeen=${messageDeltaSeen}, stopReason=${stopReason}`);
process.exit(0);
