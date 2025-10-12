#!/usr/bin/env node
// Replay end-to-end from provider output to validate (a) OpenAI→Anthropic response conversion
// and (b) Anthropic→OpenAI request conversion (round-trip) for tool arguments.
// Usage:
//   node scripts/replay-from-provider.mjs <path-to-openai-provider-pair.json>

import fs from 'fs/promises';
import path from 'path';

if (process.argv.length < 3) {
  console.error('Usage: node scripts/replay-from-provider.mjs <provider-pair.json>');
  process.exit(1);
}

const file = path.resolve(process.argv[2]);

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

function getToolCalls(oai) {
  try {
    const calls = oai?.response?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(calls) ? calls.map(c => ({ id: c?.id, name: c?.function?.name, args: c?.function?.arguments })) : [];
  } catch { return []; }
}

function getToolUse(anth) {
  try {
    const content = Array.isArray(anth?.content) ? anth.content : [];
    return content.filter(b => b && b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
  } catch { return []; }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function normalizeArgs(x) {
  if (!x) return {};
  if (typeof x === 'string') { const j = safeJsonParse(x); return j && typeof j === 'object' ? j : { _raw: x }; }
  if (typeof x === 'object') return x;
  return { _raw: String(x) };
}

function compare(a, b) {
  const ka = Object.keys(a||{}).sort();
  const kb = Object.keys(b||{}).sort();
  if (ka.length !== kb.length) return false;
  for (let i=0;i<ka.length;i++) if (ka[i] !== kb[i]) return false;
  return true;
}

async function main() {
  const pair = await readJson(file);
  const calls = getToolCalls(pair);

  const { AnthropicOpenAIConverter } = await import('../dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  const logger = { logModule() {}, logTransformation() {} };
  const converter = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableTools: true, enableStreaming: false, trustSchema: true } }, { logger });
  await converter.initialize();

  // Step A: OpenAI response → Anthropic message
  const oaiResponse = pair?.response;
  const anth = await converter.transformResponse(oaiResponse);
  const toolUse = getToolUse(anth);

  // Step B: Anthropic message → OpenAI request (simulate next turn)
  const anthReq = { system: '', messages: [{ role: 'assistant', content: anth?.content || [] }], tools: [] };
  const oaiReq = await converter.transformRequest(anthReq);
  const rtCalls = Array.isArray(oaiReq?.messages?.[0]?.tool_calls) ? oaiReq.messages[0].tool_calls : [];

  const report = { file: path.basename(file), counts: { provider_calls: calls.length, tool_use: toolUse.length, roundtrip_calls: rtCalls.length }, mismatches: [] };

  // Compare per id if present, else compare by index
  const byId = new Map(toolUse.map(t => [t.id, t]));
  for (let i=0;i<calls.length;i++) {
    const c = calls[i];
    const target = (c.id && byId.get(c.id)) || toolUse[i];
    if (!target) { report.mismatches.push({ id: c.id || `#${i}`, reason: 'tool_use missing' }); continue; }
    const want = normalizeArgs(c.args);
    const got = normalizeArgs(target.input);
    if (!compare(Object.keys(want), Object.keys(got))) {
      report.mismatches.push({ id: c.id || `#${i}`, name: c.name, provider_keys: Object.keys(want), tool_use_keys: Object.keys(got) });
    }
  }

  // Round-trip compare: tool_use → tool_calls
  const rtById = new Map(rtCalls.map(rc => [rc?.id, rc]));
  for (const t of toolUse) {
    const rc = (t.id && rtById.get(t.id)) || rtCalls.find(x => x?.function?.name === t.name);
    if (!rc) { report.mismatches.push({ id: t.id || 'unknown', reason: 'roundtrip tool_call missing' }); continue; }
    const want = normalizeArgs(t.input);
    const got = normalizeArgs(rc?.function?.arguments);
    if (!compare(Object.keys(want), Object.keys(got))) {
      report.mismatches.push({ id: t.id || 'unknown', name: t.name, roundtrip_keys_mismatch: { tool_use_keys: Object.keys(want), tool_call_keys: Object.keys(got) } });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => { console.error('replay-from-provider failed:', err); process.exit(1); });

