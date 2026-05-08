#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function makeAdapterContext() {
  return {
    requestId: 'req-format-family',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    providerId: 'mock-provider',
    routeId: 'default'
  };
}

async function main() {
  const modules = await Promise.all([
    cacheBustedImport(moduleUrl('conversion/hub/format-adapters/chat-format-adapter.js'), 'chat-format-adapter'),
    cacheBustedImport(moduleUrl('conversion/hub/format-adapters/responses-format-adapter.js'), 'responses-format-adapter'),
    cacheBustedImport(moduleUrl('conversion/hub/format-adapters/anthropic-format-adapter.js'), 'anthropic-format-adapter'),
    cacheBustedImport(moduleUrl('conversion/hub/format-adapters/gemini-format-adapter.js'), 'gemini-format-adapter')
  ]);

  const ctx = makeAdapterContext();
  const [
    { ChatFormatAdapter },
    { ResponsesFormatAdapter },
    { AnthropicFormatAdapter },
    { GeminiFormatAdapter }
  ] = modules;

  const adapters = [
    { inst: new ChatFormatAdapter(), payload: { messages: [{ role: 'user', content: 'hi' }] } },
    { inst: new ResponsesFormatAdapter(), payload: { input: [{ role: 'user', content: 'hi' }] } },
    { inst: new AnthropicFormatAdapter(), payload: { messages: [{ role: 'user', content: 'hi' }] } },
    { inst: new GeminiFormatAdapter(), payload: { contents: [{ role: 'user', parts: [] }] } }
  ];

  for (const { inst, payload } of adapters) {
    const reqEnvelope = await inst.parseRequest(payload, ctx);
    assert.equal(reqEnvelope.protocol, inst.protocol);
    assert.equal(reqEnvelope.direction, 'request');
    const reqBuilt = await inst.buildRequest(reqEnvelope, ctx);
    assert.equal(reqBuilt, reqEnvelope.payload);

    const respEnvelope = await inst.parseResponse(payload, ctx);
    assert.equal(respEnvelope.protocol, inst.protocol);
    assert.equal(respEnvelope.direction, 'response');
    const respBuilt = await inst.buildResponse(respEnvelope, ctx);
    assert.equal(respBuilt, respEnvelope.payload);
  }

  console.log('✅ coverage-hub-format-adapters-protocol-family passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-format-adapters-protocol-family failed:', error);
  process.exit(1);
});
