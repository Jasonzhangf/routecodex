#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CODEX_ROOT = path.join(os.homedir(), '.routecodex', 'codex-samples');
const SEARCH_PATHS = [
  { dir: path.join(CODEX_ROOT, 'openai-responses'), format: 'responses' },
  { dir: path.join(CODEX_ROOT, 'anthropic-messages'), format: 'anthropic' }
];

function isObject(value) {
  return !!value && typeof value === 'object';
}

function looksResponsesPayload(node) {
  if (!isObject(node)) return false;
  if (Array.isArray(node.output)) return true;
  if (Array.isArray(node.items)) return true;
  if (isObject(node.required_action)) return true;
  return false;
}

function looksAnthropicPayload(node) {
  if (!isObject(node)) return false;
  if (Array.isArray(node.content)) return true;
  if (Array.isArray(node.messages)) return true;
  if (typeof node.stop_reason === 'string' && typeof node.role === 'string') return true;
  return false;
}

function bfsFindPayload(doc, predicate) {
  if (!isObject(doc)) return null;
  const queue = [doc];
  const seen = new WeakSet();
  while (queue.length) {
    const current = queue.shift();
    if (!isObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (predicate(current)) {
      return current;
    }
    for (const value of Object.values(current)) {
      if (isObject(value)) queue.push(value);
    }
  }
  return null;
}

function loadCodexSample() {
  for (const entry of SEARCH_PATHS) {
    if (!fs.existsSync(entry.dir)) continue;
    const files = fs.readdirSync(entry.dir).filter(f => f.toLowerCase().endsWith('.json')).sort();
    for (const file of files) {
      const full = path.join(entry.dir, file);
      try {
        const json = JSON.parse(fs.readFileSync(full, 'utf8'));
        const payload = bfsFindPayload(json, entry.format === 'responses' ? looksResponsesPayload : looksAnthropicPayload);
        if (payload) {
          return { file: full, format: entry.format, payload };
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

async function loadConverters() {
  const distRoot = path.resolve(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist');
  const responsesBridgePath = path.join(distRoot, 'conversion', 'responses', 'responses-openai-bridge.js');
  const responseRuntimePath = path.join(distRoot, 'conversion', 'hub', 'response', 'response-runtime.js');
  if (!fs.existsSync(responsesBridgePath) || !fs.existsSync(responseRuntimePath)) {
    throw new Error('llmswitch-core dist missing. 请先在 sharedmodule/llmswitch-core 运行 npm run build');
  }
  const responsesBridge = await import(pathToFileURL(responsesBridgePath).href);
  const responseRuntime = await import(pathToFileURL(responseRuntimePath).href);
  const { buildChatResponseFromResponses, buildResponsesPayloadFromChat } = responsesBridge;
  const { buildAnthropicResponseFromChat, buildOpenAIChatFromAnthropicMessage } = responseRuntime;
  if (
    typeof buildChatResponseFromResponses !== 'function' ||
    typeof buildResponsesPayloadFromChat !== 'function' ||
    typeof buildAnthropicResponseFromChat !== 'function' ||
    typeof buildOpenAIChatFromAnthropicMessage !== 'function'
  ) {
    throw new Error('conversion helpers missing. 请确认 sharedmodule/llmswitch-core 构建完成');
  }
  return {
    buildChatResponseFromResponses,
    buildResponsesPayloadFromChat,
    buildAnthropicResponseFromChat,
    buildOpenAIChatFromAnthropicMessage
  };
}

async function main() {
  const sample = loadCodexSample();
  if (!sample) {
    console.log('[anthropic-roundtrip] codex samples 未找到，跳过验证（可运行 npm run replay:codex-sample 捕获样本）');
    return;
  }
  const converters = await loadConverters();
  console.log(`[anthropic-roundtrip] 使用样本 ${sample.file} (${sample.format})`);

  let baseResponsesPayload;
  if (sample.format === 'responses') {
    baseResponsesPayload = sample.payload;
  } else {
    const chatFromAnthropic = converters.buildOpenAIChatFromAnthropicMessage(sample.payload);
    baseResponsesPayload = converters.buildResponsesPayloadFromChat(chatFromAnthropic);
  }

  const chatFromResponses = converters.buildChatResponseFromResponses(baseResponsesPayload);
  const anthropicFromChat = converters.buildAnthropicResponseFromChat(chatFromResponses);
  const chatRoundtrip = converters.buildOpenAIChatFromAnthropicMessage(anthropicFromChat);
  const responsesRoundtrip = converters.buildResponsesPayloadFromChat(chatRoundtrip);

  validateToolCalls(baseResponsesPayload, responsesRoundtrip);
  validateToolCalls(responsesRoundtrip, baseResponsesPayload);
  validatePrimaryFields(baseResponsesPayload, responsesRoundtrip);
  validatePrimaryFields(responsesRoundtrip, baseResponsesPayload);

  console.log('[anthropic-roundtrip] responses → chat → anthropic → chat → responses 闭环校验通过');
}

function toolSignature(entry) {
  if (!isObject(entry)) return null;
  const fn = isObject(entry.function) ? entry.function : entry;
  const name = typeof fn.name === 'string' ? fn.name : '';
  const args = typeof fn.arguments === 'string' ? fn.arguments : (isObject(fn.arguments) ? JSON.stringify(fn.arguments) : '');
  if (!name) return null;
  return `${name}::${args}`;
}

function collectToolCalls(payload) {
  const rawRequired = payload?.required_action?.submit_tool_outputs?.tool_calls;
  const required = Array.isArray(rawRequired) ? rawRequired : [];
  const outputCalls = Array.isArray(payload?.output)
    ? payload.output.filter(part => part && typeof part === 'object' && part.type === 'function_call')
    : [];
  return {
    required: required.map(toolSignature).filter(Boolean).sort(),
    output: outputCalls.map(toolSignature).filter(Boolean).sort()
  };
}

function validateToolCalls(original, candidate) {
  const orig = collectToolCalls(original || {});
  const next = collectToolCalls(candidate || {});
  if (orig.required.join('|') !== next.required.join('|') || orig.output.join('|') !== next.output.join('|')) {
    console.error('[anthropic-roundtrip] tool call drift detected');
    const diffDir = path.join(process.cwd(), 'tmp');
    try { fs.mkdirSync(diffDir, { recursive: true }); } catch { /* ignore */ }
    const outA = path.join(diffDir, 'responses-roundtrip-original.json');
    const outB = path.join(diffDir, 'responses-roundtrip-result.json');
    fs.writeFileSync(outA, JSON.stringify(original, null, 2));
    fs.writeFileSync(outB, JSON.stringify(candidate, null, 2));
    console.error(`详情已写入:\n  ${outA}\n  ${outB}`);
    throw new Error('roundtrip tool call mismatch');
  }
}

const PRIMARY_KEYS = [
  'object',
  'model',
  'status',
  'output_text',
  'instructions',
  'temperature',
  'top_p',
  'max_tokens',
  'max_output_tokens',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'user',
  'tools',
  'required_action',
  'output',
  'usage'
];

const DROP_KEYS = new Set([
  'id',
  'created',
  'created_at',
  'response_id',
  'item_id',
  'chunk_id',
  'request_id',
  'requestId',
  'entryEndpoint',
  'annotations',
  'system_fingerprint'
]);

function sanitizeNode(value) {
  if (Array.isArray(value)) {
    return value.map(v => sanitizeNode(v));
  }
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (DROP_KEYS.has(key)) continue;
    if (key === 'metadata') continue;
    const sanitized = sanitizeNode(value[key]);
    if (sanitized === undefined) continue;
    out[key] = sanitized;
  }
  return out;
}

function unwrapResponsesPayload(payload) {
  let current = payload;
  const visited = new Set();
  while (isObject(current) && !visited.has(current)) {
    visited.add(current);
    if (current.object === 'response') return current;
    if (isObject(current.response)) {
      current = current.response;
      continue;
    }
    if (isObject(current.data)) {
      current = current.data;
      continue;
    }
    break;
  }
  return payload;
}

function extractPrimaryFields(payload) {
  if (!isObject(payload)) return {};
  const base = unwrapResponsesPayload(payload);
  const picked = {};
  for (const key of PRIMARY_KEYS) {
    if (base[key] === undefined) continue;
    if (key === 'output') {
      if (Array.isArray(base.output)) {
        picked.output = base.output
          .filter(item => {
            const t = typeof (item && item.type) === 'string' ? String(item.type).toLowerCase() : '';
            return t !== 'reasoning';
          })
          .map(item => sanitizeNode(item));
      } else {
        picked.output = [];
      }
      continue;
    }
    picked[key] = sanitizeNode(base[key]);
    if (key === 'usage' && isObject(picked[key])) {
      const details = picked[key].prompt_tokens_details;
      if (isObject(details) && Object.keys(details).length === 0) {
        delete picked[key].prompt_tokens_details;
      }
      if (picked[key].output_tokens !== undefined) delete picked[key].output_tokens;
      if (picked[key].input_tokens !== undefined) delete picked[key].input_tokens;
    }
  }
  return picked;
}

function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeForCompare(value[key]);
  }
  return out;
}

function validatePrimaryFields(original, candidate) {
  const orig = normalizeForCompare(extractPrimaryFields(original || {}));
  const next = normalizeForCompare(extractPrimaryFields(candidate || {}));
  const origStr = JSON.stringify(orig);
  const nextStr = JSON.stringify(next);
  if (origStr !== nextStr) {
    console.error('[anthropic-roundtrip] primary field drift detected');
    const diffDir = path.join(process.cwd(), 'tmp');
    try { fs.mkdirSync(diffDir, { recursive: true }); } catch { /* ignore */ }
    const outA = path.join(diffDir, 'responses-roundtrip-primary-original.json');
    const outB = path.join(diffDir, 'responses-roundtrip-primary-result.json');
    fs.writeFileSync(outA, JSON.stringify(orig, null, 2));
    fs.writeFileSync(outB, JSON.stringify(next, null, 2));
    throw new Error('roundtrip primary field mismatch');
  }
}

main().catch((err) => {
  console.error('[anthropic-roundtrip] failed:', err);
  process.exitCode = 1;
});
