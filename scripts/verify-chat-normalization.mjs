#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const home = os.homedir();
const base = path.join(home, '.routecodex', 'codex-samples', 'chat-replay');
const rid = process.argv[2];
if (!rid || !rid.startsWith('req_')) {
  console.error('Usage: node scripts/verify-chat-normalization.mjs <req_id>');
  process.exit(1);
}
const file = path.join(base, `raw-request_${rid}.json`);

function looksJsonish(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return true; } catch { return false; }
  }
  return false;
}

async function main() {
  const exists = await fs.access(file).then(() => true).catch(() => false);
  if (!exists) {
    console.error('raw-request not found:', file);
    process.exit(2);
  }
  const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
  const body = raw.body || {};

  const modPath = path.resolve('dist/modules/pipeline/modules/llmswitch/llmswitch-openai-openai.js');
  const { OpenAINormalizerLLMSwitch } = await import('file://' + modPath);
  const deps = { errorHandlingCenter: {}, debugCenter: {}, logger: { logModule(){}, logTransformation(){} } };
  const normalizer = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} }, deps);
  if (typeof normalizer.initialize === 'function') {
    await normalizer.initialize();
  }

  const transformed = await normalizer.transformRequest(body);
  const data = transformed?.data || transformed;
  const msgs = Array.isArray(data?.messages) ? data.messages : [];
  const toolMsgs = msgs.filter(m => m && m.role === 'tool');
  const jsonish = toolMsgs.filter(m => looksJsonish(m?.content));
  const missingId = toolMsgs.filter(m => !m?.tool_call_id || typeof m.tool_call_id !== 'string');
  console.log(JSON.stringify({
    rid,
    input_toolMsgs: Array.isArray(body?.messages) ? body.messages.filter(m=>m?.role==='tool').length : 0,
    output_messages: msgs.length,
    output_toolMsgs: toolMsgs.length,
    jsonish_count: jsonish.length,
    missing_tool_call_id: missingId.length,
    samples: toolMsgs.slice(0,3).map(m => ({ tool_call_id: m.tool_call_id, content_type: typeof m?.content, sample: String(m?.content||'').slice(0,120) }))
  }, null, 2));
}

main().catch(e => { console.error('verify failed:', e?.message || e); process.exit(3); });

