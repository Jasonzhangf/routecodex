#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-servertool-orchestration.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeBaseRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function countToolByName(tools, name) {
  if (!Array.isArray(tools)) {
    return 0;
  }
  return tools.filter((tool) => tool?.function?.name === name).length;
}

async function main() {
  const { applyServerToolOrchestration } = await importFresh('hub-chat-process-servertool-orchestration');
  assert.equal(typeof applyServerToolOrchestration, 'function');

  {
    const request = makeBaseRequest();
    const out = await applyServerToolOrchestration({
      request,
      metadata: {},
      requestId: 'req-1'
    });
    assert.equal(countToolByName(out.tools, 'continue_execution'), 0);
    assert.equal(out.metadata?.continueExecutionEnabled, undefined);
  }

  {
    const request = makeBaseRequest();
    const out = await applyServerToolOrchestration({
      request,
      metadata: { __rt: { serverToolFollowup: true } },
      requestId: 'req-2'
    });
    assert.equal(out.tools, undefined);
    assert.equal(out.metadata.continueExecutionEnabled, undefined);
  }

  {
    const request = makeBaseRequest();
    request.tools = [
      {
        type: 'function',
        function: {
          name: 'continue_execution',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
    const out = await applyServerToolOrchestration({
      request,
      metadata: {},
      requestId: 'req-3'
    });
    assert.equal(countToolByName(out.tools, 'continue_execution'), 1);
  }

  console.log('✅ coverage-hub-chat-process-servertool-orchestration passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-servertool-orchestration failed:', error);
  process.exit(1);
});
