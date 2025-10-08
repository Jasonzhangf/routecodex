#!/usr/bin/env node
// Review provider responses (OpenAI-style) and validate conversion to Anthropic tool_use inputs
// - Scans ~/.routecodex/codex-samples/pipeline-out-req_*.json
// - For each response with tool_calls/function_call:
//   * Convert via AnthropicOpenAIConverter.convertOpenAIResponseToAnthropic
//   * Extract tool_use blocks; check for empty/invalid inputs and summarize keys
// - Print summary and write CSV tmp/review-provider-responses.csv

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function listFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function importSwitch() {
  const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  if (!fs.existsSync(distPath)) {
    console.error('Build missing. Run: npm run build');
    process.exit(1);
  }
  return await import(url.pathToFileURL(distPath).href);
}

function extractOpenAIResponse(obj) {
  // Try common shapes
  if (obj && typeof obj === 'object') {
    if ('data' in obj && obj.data && typeof obj.data === 'object') return obj.data;
    return obj;
  }
  return null;
}

function analyzeAnthropicBlocks(msg) {
  const out = { toolUse: 0, emptyInputs: 0, byTool: {} };
  const content = Array.isArray(msg?.content) ? msg.content : [];
  for (const b of content) {
    if (b && b.type === 'tool_use') {
      out.toolUse++;
      const inp = b.input;
      const empty = !inp || typeof inp !== 'object' || Object.keys(inp).length === 0;
      if (empty) out.emptyInputs++;
      const name = b.name || 'tool';
      const keys = empty ? [] : Object.keys(inp).sort();
      out.byTool[name] = out.byTool[name] || { count: 0, empty: 0, keys: {} };
      out.byTool[name].count++;
      if (empty) out.byTool[name].empty++;
      const ks = keys.join(',');
      if (!empty) { out.byTool[name].keys[ks] = (out.byTool[name].keys[ks] || 0) + 1; }
    }
  }
  return out;
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples');
  const files = listFiles(dir, 'pipeline-out-req_');
  if (files.length === 0) {
    console.log('No pipeline-out-req_* samples found.');
    process.exit(0);
  }
  const { AnthropicOpenAIConverter } = await importSwitch();
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, { logger: { logTransformation() {}, logModule() {} } });
  await conv.initialize();

  let seen = 0, withTools = 0, totalToolUse = 0, emptyInputs = 0;
  const rows = [['file','tool_use','empty_inputs','per_tool_breakdown']];

  for (const f of files) { // all available
    const j = readJSON(f);
    if (!j) continue;
    const resp = extractOpenAIResponse(j);
    if (!resp || !Array.isArray(resp.choices)) continue;
    seen++;
    const hasTC = !!(resp.choices[0]?.message?.tool_calls || resp.choices[0]?.message?.function_call);
    if (!hasTC) continue;
    withTools++;
    const anth = conv['convertOpenAIResponseToAnthropic'](resp);
    const a = analyzeAnthropicBlocks(anth);
    totalToolUse += a.toolUse;
    emptyInputs += a.emptyInputs;
    const perTool = Object.entries(a.byTool).map(([k,v]) => `${k}: count=${v.count}, empty=${v.empty}, keys=[${Object.entries(v.keys).slice(0,3).map(([kk,cc])=>`${kk}(${cc})`).join('; ')}]`).join(' | ');
    rows.push([path.basename(f), a.toolUse, a.emptyInputs, perTool].join(','));
  }

  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/review-provider-responses.csv', rows.join('\n'));
  console.log('Provider response review summary (OpenAI → Anthropic transform):');
  console.log(` files_seen=${seen}, with_tool_calls=${withTools}`);
  console.log(` tool_use_blocks=${totalToolUse}, empty_inputs=${emptyInputs}`);
  console.log('CSV written: tmp/review-provider-responses.csv');
}

main().catch(e => { console.error('review-provider-responses failed:', e); process.exit(1); });
