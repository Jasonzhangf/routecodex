#!/usr/bin/env node
// Reconstruct Anthropic requests from original provider-out-openai_* request snapshots
// Use the current LLMSwitch (OpenAI -> Anthropic) transformRequest to generate fresh Anth requests,
// then audit tool_use inputs for empties. Writes reconstructed files to tmp/reconstructed-anth/.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const home = process.env.HOME || process.env.USERPROFILE || '';
const base = path.join(home, '.routecodex', 'codex-samples');

function listFiles(prefix) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(f => f.startsWith(prefix) && f.endsWith('.json')).map(f => path.join(base, f));
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importSwitch() {
  const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  if (!fs.existsSync(distPath)) {
    console.error('Build missing. Run: npm run build');
    process.exit(1);
  }
  return await import(url.pathToFileURL(distPath).href);
}

function analyzeAnth(payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  let total = 0, empty = 0;
  for (const m of msgs) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const b of content) {
      if (b && b.type === 'tool_use') {
        total++;
        const inp = b.input;
        if (!inp || typeof inp !== 'object' || Object.keys(inp).length === 0) empty++;
      }
    }
  }
  return { total, empty };
}

async function main() {
  const files = listFiles('provider-out-openai_');
  if (files.length === 0) {
    console.log('No provider-out-openai_* snapshots found.');
    process.exit(0);
  }
  const { AnthropicOpenAIConverter } = await importSwitch();
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableTools: true } }, { logger: { logTransformation(){}, logModule(){} } });
  await conv.initialize();

  const outDir = path.join('tmp', 'reconstructed-anth');
  fs.mkdirSync(outDir, { recursive: true });

  let seen = 0, withTools = 0, totalToolUse = 0, emptyToolUse = 0;
  for (const f of files) {
    const req = readJSON(f);
    if (!req) continue;
    seen++;
    // provider-out-openai_* is a request snapshot; use transformRequest to convert OpenAI->Anthropic
    const anthReq = await conv.transformRequest(req);
    const analysis = analyzeAnth(anthReq);
    if (analysis.total > 0) withTools++;
    totalToolUse += analysis.total;
    emptyToolUse += analysis.empty;
    const outPath = path.join(outDir, path.basename(f).replace('provider-out-openai_', 'anth-from-provider_'));
    fs.writeFileSync(outPath, JSON.stringify(anthReq, null, 2));
  }

  console.log('Reconstruction audit summary (from provider requests):');
  console.log(` files=${seen}, with_tools=${withTools}`);
  console.log(` tool_use_total=${totalToolUse}, empty_tool_use=${emptyToolUse}`);
  console.log(` output dir: ${outDir}`);
}

main().catch(e => { console.error('reconstruct-and-audit failed:', e); process.exit(1); });

