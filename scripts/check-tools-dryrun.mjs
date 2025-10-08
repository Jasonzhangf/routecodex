#!/usr/bin/env node
// Minimal dry-run to verify Anthropic->OpenAI tool propagation using LLMSwitch
// Usage: node scripts/check-tools-dryrun.mjs ~/.routecodex/codex-samples/pipeline-in-anth_*.json

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/check-tools-dryrun.mjs <pipeline-in-anth.json>');
  process.exit(1);
}

const abs = path.resolve(file);
const raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
const payload = raw?.data ?? raw;

const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
if (!fs.existsSync(distPath)) {
  console.error('Build missing. Run: npm run build');
  process.exit(1);
}

const { AnthropicOpenAIConverter } = await import(url.pathToFileURL(distPath).href);

// Minimal dependencies stub
const deps = { logger: { logTransformation: () => {}, logModule: () => {} } };
const modCfg = { type: 'llmswitch-anthropic-openai', config: { enableTools: true } };
const conv = new AnthropicOpenAIConverter(modCfg, deps);
await conv.initialize();

const result = await conv.transformRequest(payload);

const hasToolsIn = Array.isArray(payload?.tools) && payload.tools.length > 0;
const hasToolsOut = Array.isArray(result?.tools) && result.tools.length > 0;

console.log(JSON.stringify({
  sample: path.basename(abs),
  hasToolsIn,
  hasToolsOut,
  toolsCountIn: hasToolsIn ? payload.tools.length : 0,
  toolsCountOut: hasToolsOut ? result.tools.length : 0,
  outPreview: {
    model: result?.model,
    messagesCount: Array.isArray(result?.messages) ? result.messages.length : 0,
    firstTool: hasToolsOut ? result.tools[0] : null,
  }
}, null, 2));

