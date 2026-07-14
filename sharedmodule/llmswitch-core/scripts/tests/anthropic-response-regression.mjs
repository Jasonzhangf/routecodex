#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SAMPLE_PATH = path.join(PROJECT_ROOT, 'test', 'samples', 'chat-blackbox', 'anthropic', 'anthropic-response.json');
const NATIVE_NODE_PATH = path.join(PROJECT_ROOT, 'dist', 'native', 'router_hotpath_napi.node');
const NATIVE_RESP_SEMANTICS_FACADE_PATH = path.join(
  PROJECT_ROOT,
  'dist',
  'native',
  'router-hotpath',
  'native-hub-pipeline-resp-semantics.js'
);

function loadSample() {
  const raw = fs.readFileSync(SAMPLE_PATH, 'utf-8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || !doc.payload) {
    throw new Error('anthropic response regression sample malformed');
  }
  return doc;
}

function assertHubAnthropicToolCallShape(chat) {
  assert.equal(chat?.id, 'msg_regression_tool');
  assert.equal(chat?.object, 'chat.completion');
  assert.equal(chat?.model, 'glm-4.6');
  assert.equal(chat?.choices?.[0]?.finish_reason, 'tool_calls');
  assert.equal(chat?.choices?.[0]?.message?.content, '');
  const toolCalls = chat?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new Error(`expected exactly one Hub Anthropic response tool_call, got ${JSON.stringify(toolCalls)}`);
  }
  const [tc] = toolCalls;
  assert.equal(tc.id, 'call_regression_shell');
  assert.equal(tc.type, 'function');
  assert.equal(tc.function?.name, 'Bash');
  assert.equal(tc.function?.arguments, '{"command":"ls"}');
  assert.equal(chat?.usage?.prompt_tokens, 10);
  assert.equal(chat?.usage?.completion_tokens, 5);
  assert.equal(chat?.usage?.total_tokens, 15);
  if ('call_id' in tc) {
    throw new Error(`Hub Anthropic response tool_calls must not contain call_id, got ${JSON.stringify(tc)}`);
  }
  if ('tool_call_id' in tc) {
    throw new Error(`Hub Anthropic response tool_calls must not contain tool_call_id, got ${JSON.stringify(tc)}`);
  }
}

export async function buildAnthropicRegressionProjectionWithNative(payload) {
  if (!fs.existsSync(NATIVE_NODE_PATH)) {
    throw new Error(`required native artifact missing: ${NATIVE_NODE_PATH}`);
  }
  process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = NATIVE_NODE_PATH;
  const nativeMod = await import(
    pathToFileURL(NATIVE_RESP_SEMANTICS_FACADE_PATH).href
  );
  const { buildOpenAIChatFromAnthropicMessageFullWithNative } = nativeMod;
  if (typeof buildOpenAIChatFromAnthropicMessageFullWithNative !== 'function') {
    throw new Error('buildOpenAIChatFromAnthropicMessageFullWithNative missing from native facade');
  }
  const raw = buildOpenAIChatFromAnthropicMessageFullWithNative({
    payload: JSON.stringify(payload),
  });
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope !== 'object' || typeof envelope.result !== 'string') {
    throw new Error('native Anthropic response projection returned malformed envelope');
  }
  return JSON.parse(envelope.result);
}

async function main() {
  const sample = loadSample();
  const chat = await buildAnthropicRegressionProjectionWithNative(sample.payload);
  assertHubAnthropicToolCallShape(chat);
  console.log('[anthropic-response-regression] Hub Anthropic response mapping matches Rust-owned shape.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
