#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SAMPLE_PATH = path.join(PROJECT_ROOT, 'test', 'samples', 'chat-blackbox', 'anthropic', 'chat-to-anthropic.json');

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
  if (!doc || typeof doc !== 'object' || !doc.chat || !doc.expected) {
    throw new Error('anthropic chat regression sample malformed');
  }
  return doc;
}

async function main() {
  const sample = loadSample();
  const opTableMod = await import(
    pathToFileURL(resolveDistPath('dist', 'conversion', 'hub', 'operation-table', 'operation-table-runner.js')).href
  );
  const { applyHubOperationTableOutboundPreMap, applyHubOperationTableOutboundPostMap } = opTableMod;
  if (typeof applyHubOperationTableOutboundPostMap !== 'function') {
    throw new Error('applyHubOperationTableOutboundPostMap missing from dist build');
  }
  const mapperMod = await import(
    pathToFileURL(resolveDistPath('dist', 'conversion', 'hub', 'semantic-mappers', 'anthropic-mapper.js')).href
  );
  const { AnthropicSemanticMapper } = mapperMod;
  if (typeof AnthropicSemanticMapper !== 'function') {
    throw new Error('AnthropicSemanticMapper missing from dist build');
  }
  const mapper = new AnthropicSemanticMapper();
  const adapterContext = {
    requestId: 'anthropic-chat-regression',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'anthropic-messages'
  };
  const chatEnvelope = structuredClone(sample.chat);
  if (typeof applyHubOperationTableOutboundPreMap === 'function') {
    await applyHubOperationTableOutboundPreMap({
      protocol: adapterContext.providerProtocol,
      chatEnvelope,
      adapterContext
    });
  }
  const format = await mapper.fromChat(chatEnvelope, adapterContext);
  applyHubOperationTableOutboundPostMap({
    chatEnvelope,
    formatEnvelope: format,
    adapterContext
  });
  const payload = format.payload;
  assert.deepStrictEqual(payload, sample.expected, 'Chat→Anthropic mapping drift detected');
  console.log('[anthropic-chat-regression] Chat → Anthropic request mapping matches golden sample.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
