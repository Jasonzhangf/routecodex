#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SAMPLE_PATH = path.join(PROJECT_ROOT, 'test', 'samples', 'chat-blackbox', 'anthropic', 'anthropic-response.json');

function resolveDistPath(...segments) {
  const direct = path.join(PROJECT_ROOT, ...segments);
  if (fs.existsSync(direct)) {
    return direct;
  }
  return path.join(PROJECT_ROOT, 'sharedmodule', 'llmswitch-core', ...segments);
}

function loadSample() {
  const raw = fs.readFileSync(SAMPLE_PATH, 'utf-8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || !doc.payload || !doc.expected) {
    throw new Error('anthropic response regression sample malformed');
  }
  return doc;
}

async function main() {
  const sample = loadSample();
  const runtimeMod = await import(
    pathToFileURL(resolveDistPath('dist', 'conversion', 'hub', 'response', 'response-runtime.js')).href
  );
  const { buildOpenAIChatFromAnthropicMessage } = runtimeMod;
  if (typeof buildOpenAIChatFromAnthropicMessage !== 'function') {
    throw new Error('buildOpenAIChatFromAnthropicMessage missing from dist build');
  }
  const chat = buildOpenAIChatFromAnthropicMessage(structuredClone(sample.payload), {
    aliasMap: structuredClone(sample.aliasMap),
    includeToolCallIds: true
  });
  assert.deepStrictEqual(chat, sample.expected, 'Anthropic response → Chat mapping drift detected');
  // Regression: includeToolCallIds: false should not include call_id/tool_call_id
  const chatNoIds = buildOpenAIChatFromAnthropicMessage(structuredClone(sample.payload), {
    aliasMap: structuredClone(sample.aliasMap),
    includeToolCallIds: false
  });
  if (!chatNoIds || !chatNoIds.choices || !chatNoIds.choices[0] || !chatNoIds.choices[0].message) {
    throw new Error('chatNoIds missing expected structure');
  }
  const tcNoIds = chatNoIds.choices[0].message.tool_calls;
  if (!Array.isArray(tcNoIds) || tcNoIds.length === 0) {
    throw new Error('chatNoIds missing tool_calls array');
  }
  for (const tc of tcNoIds) {
    if ('call_id' in tc) {
      throw new Error(`chatNoIds tool_calls should not contain call_id, got ${JSON.stringify(tc)}`);
    }
    if ('tool_call_id' in tc) {
      throw new Error(`chatNoIds tool_calls should not contain tool_call_id, got ${JSON.stringify(tc)}`);
    }
  }
  console.log('[anthropic-response-regression] Anthropic response mapping matches golden sample.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
