#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governed-merge.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeBaseRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ function: { name: 'base_tool', parameters: { type: 'object', properties: {} } } }],
    parameters: { stream: true, temperature: 0.2 },
    metadata: { originalEndpoint: '/v1/chat/completions', capturedContext: { a: 1 } }
  };
}

async function main() {
  const { buildGovernedMergedRequest } = await importFresh('hub-chat-process-governed-merge');
  assert.equal(typeof buildGovernedMergedRequest, 'function');

  {
    const request = makeBaseRequest();
    const governed = {
      messages: [{ role: 'assistant', content: 'ok' }],
      tools: [
        {
          function: {
            name: 'governed_tool',
            parameters: { properties: { q: { type: 'string' } } }
          }
        }
      ],
      parameters: { top_p: 0.9 },
      tool_choice: 'auto',
      stream: true
    };
    const out = buildGovernedMergedRequest({ request, governed, inboundStreamIntent: false });
    assert.equal(out.messages[0].role, 'assistant');
    assert.equal(out.tools?.[0]?.function?.name, 'governed_tool');
    assert.equal(out.parameters.temperature, 0.2);
    assert.equal(out.parameters.top_p, 0.9);
    assert.equal(out.metadata.toolChoice, 'auto');
    assert.equal(out.metadata.providerStream, true);
    assert.equal(out.metadata.originalStream, false);
    assert.equal(out.metadata.governedTools, true);
  }

  {
    const request = makeBaseRequest();
    const governed = {
      messages: 'invalid',
      parameters: [],
      stream: '1'
    };
    const out = buildGovernedMergedRequest({ request, governed, inboundStreamIntent: true });
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.tools?.[0]?.function?.name, 'base_tool');
    assert.equal(out.parameters.temperature, 0.2);
    assert.equal(out.metadata.providerStream, undefined);
    assert.equal(out.metadata.toolChoice, undefined);
    assert.equal(out.metadata.governedTools, false);
  }

  {
    const request = makeBaseRequest();
    const governed = {
      tools: { bad: true },
      tool_choice: 1
    };
    const out = buildGovernedMergedRequest({ request, governed, inboundStreamIntent: true });
    assert.equal(out.tools, undefined);
    assert.equal(out.metadata.toolChoice, undefined);
    assert.equal(out.metadata.governedTools, true);
  }

  {
    const request = makeBaseRequest();
    const governed = {
      tool_choice: { type: 'function', function: { name: 'a' } },
      stream: false
    };
    const out = buildGovernedMergedRequest({ request, governed, inboundStreamIntent: true });
    assert.equal(out.metadata.toolChoice?.type, 'function');
    assert.equal(out.metadata.providerStream, false);
  }

  console.log('✅ coverage-hub-chat-process-governed-merge passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governed-merge failed:', error);
  process.exit(1);
});
