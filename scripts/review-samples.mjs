#!/usr/bin/env node
// Review captured samples with current LLMSwitch logic (no network)
// - Scans ~/.routecodex/codex-samples
// - For pipeline-in-anth_*.json:
//   * Measure tool_use empty inputs BEFORE
//   * Transform via AnthropicOpenAIConverter.transformRequest
//   * Measure assistant.tool_calls arguments emptiness AFTER (should be 0)
//   * Check assistant.content empty when tool_calls present
// - Writes summary CSV to tmp/review-report.csv and prints a brief summary

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

function countAnthToolUseMetrics(payload) {
  const out = { total: 0, empty: 0 };
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of msgs) {
    const cont = Array.isArray(m?.content) ? m.content : [];
    for (const b of cont) {
      if (b && b.type === 'tool_use') {
        out.total++;
        const inp = b.input;
        if (!inp || typeof inp !== 'object' || Object.keys(inp).length === 0) {
          out.empty++;
        }
      }
    }
  }
  return out;
}

function countOpenAIToolCallMetrics(openaiReq) {
  const out = { toolCalls: 0, emptyArgs: 0, nonStringArgs: 0, contentNonEmptyWithTools: 0 };
  const msgs = Array.isArray(openaiReq?.messages) ? openaiReq.messages : [];
  for (const m of msgs) {
    if (m?.role === 'assistant') {
      const tcs = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
      if (tcs.length) {
        out.toolCalls += tcs.length;
        if (typeof m.content === 'string' && m.content.trim().length > 0) {
          out.contentNonEmptyWithTools++;
        }
      }
      for (const tc of tcs) {
        const fn = tc?.function || {};
        const a = fn.arguments;
        if (typeof a !== 'string') { out.nonStringArgs++; continue; }
        try {
          const obj = JSON.parse(a);
          if (!obj || typeof obj !== 'object' || Object.keys(obj).length === 0) { out.emptyArgs++; }
        } catch { out.emptyArgs++; }
      }
    }
  }
  return out;
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.routecodex', 'codex-samples');
  const anthFiles = listFiles(dir, 'pipeline-in-anth_');
  if (anthFiles.length === 0) {
    console.log('No pipeline-in-anth_* samples found.');
    process.exit(0);
  }
  const { AnthropicOpenAIConverter } = await importSwitch();
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableTools: true } }, { logger: { logTransformation() {}, logModule() {} } });
  await conv.initialize();

  let total = 0;
  let beforeEmpty = 0;
  let beforeTotal = 0;
  let afterToolCalls = 0;
  let afterEmptyArgs = 0;
  let afterNonStringArgs = 0;
  let afterContentNonEmptyWithTools = 0;

  const rows = [['file','before_tool_use_total','before_tool_use_empty','after_tool_calls','after_empty_args','after_nonstring_args','after_content_nonempty_with_tools']];

  for (const f of anthFiles) {
    const j = readJSON(f);
    if (!j) continue;
    const payload = j?.data ?? j;
    const m1 = countAnthToolUseMetrics(payload);
    const outReq = await conv.transformRequest(payload);
    const m2 = countOpenAIToolCallMetrics(outReq);
    total++;
    beforeTotal += m1.total;
    beforeEmpty += m1.empty;
    afterToolCalls += m2.toolCalls;
    afterEmptyArgs += m2.emptyArgs;
    afterNonStringArgs += m2.nonStringArgs;
    afterContentNonEmptyWithTools += m2.contentNonEmptyWithTools;
    rows.push([path.basename(f), m1.total, m1.empty, m2.toolCalls, m2.emptyArgs, m2.nonStringArgs, m2.contentNonEmptyWithTools].join(','));
  }

  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/review-report.csv', rows.join('\n'));

  console.log('Review summary (Anthropic → OpenAI request transform):');
  console.log(` files=${total}`);
  console.log(` BEFORE: tool_use total=${beforeTotal}, empty_inputs=${beforeEmpty}`);
  console.log(` AFTER : tool_calls total=${afterToolCalls}, empty_args=${afterEmptyArgs}, nonstring_args=${afterNonStringArgs}`);
  console.log(` content_nonempty_with_tools=${afterContentNonEmptyWithTools} (expected 0)`);
  console.log('CSV written: tmp/review-report.csv');
}

main().catch(e => { console.error('review-samples failed:', e); process.exit(1); });

