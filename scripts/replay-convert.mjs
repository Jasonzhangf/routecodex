#!/usr/bin/env node
// Replay conversion: load an OpenAI ChatCompletion-like JSON and convert to Anthropic schema
// Usage: node scripts/replay-convert.mjs <path-to-json>

import fs from 'fs';
import path from 'path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/replay-convert.mjs <path-to-json>');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

// Find the inner object that contains choices or content
const unwrap = (obj) => {
  let cur = obj;
  const seen = new Set();
  while (cur && typeof cur === 'object' && !Array.isArray(cur) && !seen.has(cur)) {
    seen.add(cur);
    if ('choices' in cur || 'content' in cur) break;
    if (cur && typeof cur.data === 'object') { cur = cur.data; continue; }
    break;
  }
  return cur;
};

const root = readJson(path.resolve(file));
let payload = unwrap(root);
// If not directly a completion, recursively search for an object containing choices[].message.tool_calls
const hasToolCalls = (obj) => {
  try {
    if (!obj || typeof obj !== 'object') return false;
    if (!Array.isArray(obj.choices) || obj.choices.length === 0) return false;
    const m = obj.choices[0]?.message;
    return Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
  } catch { return false; }
};

if (!hasToolCalls(payload)) {
  // DFS search
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (hasToolCalls(cur)) { payload = cur; break; }
    for (const v of Object.values(cur)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

// Dynamically import built converter from dist
const { AnthropicOpenAIConverter } = await import('../dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');

// Minimal logger shim
const logger = {
  logModule: () => {},
  logTransformation: () => {},
};

const converter = new AnthropicOpenAIConverter({
  type: 'llmswitch-anthropic-openai',
  config: { enableTools: true, enableStreaming: false, trustSchema: true }
}, { logger });
await converter.initialize();

const out = await converter.transformResponse(payload);
console.log(JSON.stringify(out, null, 2));
