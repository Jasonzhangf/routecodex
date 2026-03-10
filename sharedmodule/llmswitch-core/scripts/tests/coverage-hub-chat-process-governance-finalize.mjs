#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governance-finalize.js')
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

async function main() {
  const { finalizeGovernedRequest } = await importFresh('hub-chat-process-governance-finalize');
  assert.equal(typeof finalizeGovernedRequest, 'function');

  {
    const request = makeBaseRequest();
    const governanceEngine = {
      governRequest(req) {
        return {
          request: req,
          summary: { applied: false, kept: true }
        };
      }
    };
    const out = finalizeGovernedRequest({
      request,
      providerProtocol: 'openai-chat',
      governanceEngine
    });
    assert.equal(out, request);
    assert.equal(out.metadata.toolGovernance, undefined);
  }

  {
    const request = makeBaseRequest();
    request.metadata.toolGovernance = { previous: true };
    const governanceEngine = {
      governRequest(req) {
        const cloned = { ...req, metadata: { ...req.metadata } };
        return {
          request: cloned,
          summary: { applied: true, patched: 1 }
        };
      }
    };
    const out = finalizeGovernedRequest({
      request,
      providerProtocol: 'openai-chat',
      governanceEngine
    });
    assert.equal(out.metadata.toolGovernance.previous, true);
    assert.equal(out.metadata.toolGovernance.request.applied, true);
    assert.equal(out.metadata.toolGovernance.request.patched, 1);
  }

  console.log('✅ coverage-hub-chat-process-governance-finalize passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governance-finalize failed:', error);
  process.exit(1);
});
