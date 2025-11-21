#!/usr/bin/env node
import fs from 'node:fs';
import OpenAI from 'openai';
import { Readable } from 'node:stream';
import { aggregateOpenAIChatSSEToJSON } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/json-to-chat-sse.js';

function readGLMConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';
  const raw = fs.readFileSync(p, 'utf-8');
  const j = JSON.parse(raw);
  const baseURL = j.virtualrouter.providers.glm.baseURL;
  const apiKey = j.virtualrouter.providers.glm.auth.apiKey || j.virtualrouter.providers.glm.apiKey?.[0];
  return { baseURL, apiKey, model: 'glm-4.6' };
}

async function linesFromSDKStream(stream) {
  const lines = [];
  for await (const chunk of stream) lines.push('data: ' + JSON.stringify(chunk) + '\n\n');
  lines.push('data: [DONE]\n\n');
  return lines;
}

function readableFromLines(lines) {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l); r.push(null); });
  return r;
}

async function main() {
  const cfg = readGLMConfig();
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
  const stream = await client.chat.completions.create({ model: cfg.model, messages: [{ role: 'user', content: '请调用 search 工具查询 hello' }], tools, stream: true });
  const originLines = await linesFromSDKStream(stream);
  const agg1 = await aggregateOpenAIChatSSEToJSON(readableFromLines(originLines));
  const sse = createChatSSEStreamFromChatJson(agg1, { requestId: 'dbg' });
  const lines2 = await (async () => {
    const arr = [];
    sse.on('data', (c) => arr.push(String(c)));
    await new Promise((r) => sse.on('end', r));
    return arr.join('').split('\n').filter(Boolean).map((s) => s + '\n');
  })();
  const agg2 = await aggregateOpenAIChatSSEToJSON(readableFromLines(lines2));
  console.log('origin tool_calls:', JSON.stringify(agg1?.choices?.[0]?.message?.tool_calls, null, 2));
  console.log('resynth tool_calls:', JSON.stringify(agg2?.choices?.[0]?.message?.tool_calls, null, 2));
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
