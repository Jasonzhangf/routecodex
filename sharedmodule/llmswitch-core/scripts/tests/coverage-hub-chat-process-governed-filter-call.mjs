#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governed-filter-call.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeBaseRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: { stream: true },
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

async function main() {
  const { runGovernedChatRequestFilters } = await importFresh('hub-chat-process-governed-filter-call');
  assert.equal(typeof runGovernedChatRequestFilters, 'function');

  {
    const request = makeBaseRequest();
    const out = await runGovernedChatRequestFilters({
      request,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-1',
      providerProtocol: 'openai-chat',
      inboundStreamIntent: true,
      metadataToolHints: undefined,
      rawRequestBody: undefined
    });
    assert.equal(typeof out, 'object');
    assert.equal(Array.isArray(out), false);
  }

  {
    const request = makeBaseRequest();
    request.tools = [
      {
        type: 'function',
        function: {
          name: 'demo_tool',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
    const out = await runGovernedChatRequestFilters({
      request,
      entryEndpoint: '/v1/messages',
      requestId: 'req-2',
      providerProtocol: 'anthropic-chat',
      inboundStreamIntent: false,
      metadataToolHints: { force: true },
      rawRequestBody: { hello: 'world' }
    });
    assert.equal(typeof out, 'object');
    assert.equal(Array.isArray(out), false);
  }

  console.log('✅ coverage-hub-chat-process-governed-filter-call passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governed-filter-call failed:', error);
  process.exit(1);
});
