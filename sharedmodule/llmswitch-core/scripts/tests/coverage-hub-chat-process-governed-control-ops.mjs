#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governed-control-ops.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeBaseRequest() {
  return {
    model: 'gpt-base',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: { stream: false, temperature: 0.3 },
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

async function main() {
  const { applyGovernedControlOperations } = await importFresh('hub-chat-process-governed-control-ops');
  assert.equal(typeof applyGovernedControlOperations, 'function');

  {
    const request = makeBaseRequest();
    const governed = {
      stream: true,
      tool_choice: { type: 'function', function: { name: 'run' } },
      model: '  gpt-governed  '
    };
    const out = applyGovernedControlOperations({
      request,
      governed,
      inboundStreamIntent: true
    });
    assert.equal(out.metadata.inboundStream, true);
    assert.equal(out.parameters.stream, true);
    assert.equal(out.parameters.tool_choice.type, 'function');
    assert.equal(out.model, 'gpt-governed');
  }

  {
    const request = makeBaseRequest();
    const governed = {
      stream: 'x',
      model: '   '
    };
    const out = applyGovernedControlOperations({
      request,
      governed,
      inboundStreamIntent: false
    });
    assert.equal(out.metadata.inboundStream, false);
    assert.equal(out.parameters.stream, false);
    assert.equal(out.parameters.tool_choice, undefined);
    assert.equal(out.model, 'gpt-base');
  }

  {
    const request = makeBaseRequest();
    const governed = {
      tool_choice: null,
      model: 123
    };
    const out = applyGovernedControlOperations({
      request,
      governed,
      inboundStreamIntent: true
    });
    assert.equal(Object.prototype.hasOwnProperty.call(out.parameters, 'tool_choice'), true);
    assert.equal(out.parameters.tool_choice, null);
    assert.equal(out.model, 'gpt-base');
  }

  console.log('✅ coverage-hub-chat-process-governed-control-ops passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governed-control-ops failed:', error);
  process.exit(1);
});
