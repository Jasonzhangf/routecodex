#!/usr/bin/env node
import fs from 'node:fs';
import OpenAI from 'openai';
import { Readable } from 'node:stream';
import { aggregateOpenAIChatSSEToJSON } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/json-to-chat-sse.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/stream-equivalence.js';

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
function readableFromLines(lines) { const r = new Readable({ read(){} }); setImmediate(()=>{ for(const l of lines) r.push(l); r.push(null);}); return r; }

async function main() {
  const cfg = readGLMConfig();
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
  const stream = await client.chat.completions.create({ model: cfg.model, messages: [{ role: 'user', content: '请调用 search 工具查询 hello' }], tools, stream: true });
  const originLines = await linesFromSDKStream(stream);
  const aggregated = await aggregateOpenAIChatSSEToJSON(readableFromLines(originLines));
  const sse = createChatSSEStreamFromChatJson(aggregated, { requestId: 'live' });
  const eq = await assertEquivalent(
    bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
    bridgeOpenAIChatUpstreamToEvents(sse)
  );
  console.log('equivalence:', eq);
}

main().catch((e) => { console.error(e); process.exit(1); });

