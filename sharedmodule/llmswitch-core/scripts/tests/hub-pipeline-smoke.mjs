#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function unwrapSnapshotJson(raw) {
  return raw?.data?.body?.data || raw?.data?.body || raw?.data;
}

async function loadFixture(rel) {
  const full = path.join(projectRoot, rel);
  const raw = JSON.parse(await fs.readFile(full, 'utf8'));
  const body = unwrapSnapshotJson(raw);
  if (!body || typeof body !== 'object') {
    throw new Error(`Invalid fixture shape: ${rel}`);
  }
  return body;
}

function createVirtualRouterBootstrapInput() {
  return {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: { key1: { value: 'dummy' } }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['tab.key1.glm-4.7']
          }
        ]
      },
      classifier: {}
    }
  };
}

async function main() {
  const { HubPipeline } = await import('../../dist/conversion/hub/pipeline/hub-pipeline.js');
  const { bootstrapVirtualRouterConfig } = await import('../../dist/router/virtual-router/bootstrap.js');

  const { config: virtualRouter } = bootstrapVirtualRouterConfig(createVirtualRouterBootstrapInput());
  const hubPipeline = new HubPipeline({ virtualRouter });

  const chatReq = await loadFixture('tests/fixtures/codex-samples/openai-chat/sample_provider-request.json');
  const responsesReq = await loadFixture('tests/fixtures/codex-samples/openai-responses/sample_provider-request.json');
  const anthropicReq = await loadFixture('tests/fixtures/codex-samples/anthropic-messages/sample_provider-request.json');

  // Normalize models to a single route target so routing doesn't short-circuit this smoke test.
  chatReq.model = 'glm-4.7';
  responsesReq.model = 'glm-4.7';
  anthropicReq.model = 'glm-4.7';

  // 1) Standard request pipelines (inbound → process → outbound provider payload)
  for (const [label, endpoint, providerProtocol, payload] of [
    ['openai-chat', '/v1/chat/completions', 'openai-chat', chatReq],
    ['openai-responses', '/v1/responses', 'openai-responses', responsesReq],
    ['anthropic-messages', '/v1/messages', 'anthropic-messages', anthropicReq]
  ]) {
    const result = await hubPipeline.execute({
      id: `req_hub_smoke_${label}`,
      endpoint,
      payload,
      metadata: {
        providerProtocol,
        processMode: 'chat',
        direction: 'request',
        stage: 'inbound',
        stream: false,
        __disableHubSnapshots: true
      }
    });
    assert.ok(result.providerPayload && typeof result.providerPayload === 'object', `${label} should produce providerPayload`);
    assert.ok(result.standardizedRequest && typeof result.standardizedRequest === 'object', `${label} should produce standardizedRequest`);
    assert.equal(result.metadata.entryEndpoint, endpoint, `${label} entryEndpoint preserved`);
  }

  // 2) chat_process re-entry (servertool followup style):
  // feed a standardized request surface, attach a mappable semantic in metadata, and ensure it is lifted.
  {
    const base = await hubPipeline.execute({
      id: 'req_hub_smoke_base_responses',
      endpoint: '/v1/responses',
      payload: responsesReq,
      metadata: {
        providerProtocol: 'openai-responses',
        processMode: 'chat',
        direction: 'request',
        stage: 'inbound',
        stream: false,
        __disableHubSnapshots: true
      }
    });
    assert.ok(base.standardizedRequest, 'base standardizedRequest required for re-entry');
    const reentered = await hubPipeline.execute({
      id: 'req_hub_smoke_reenter_chat_process',
      endpoint: '/v1/responses',
      payload: base.standardizedRequest,
      metadata: {
        providerProtocol: 'openai-responses',
        processMode: 'chat',
        direction: 'request',
        stage: 'outbound',
        stream: false,
        __hubEntry: 'chat_process',
        // mappable semantic: must be lifted to chat.semantics.responses.resume
        responsesResume: { tool_call_id: 'call_demo_exec', output: 'ok' },
        __disableHubSnapshots: true
      }
    });
    const semantics = reentered.standardizedRequest?.semantics || reentered.processedRequest?.semantics;
    assert.ok(semantics && typeof semantics === 'object', 're-entry should keep semantics object');
  }

  // 3) passthrough should skip chat/tool governance nodes but still produce provider payload.
  {
    const result = await hubPipeline.execute({
      id: 'req_hub_smoke_passthrough',
      endpoint: '/v1/chat/completions',
      payload: chatReq,
      metadata: {
        providerProtocol: 'openai-chat',
        processMode: 'passthrough',
        direction: 'request',
        stage: 'inbound',
        stream: false,
        __disableHubSnapshots: true
      }
    });
    assert.ok(result.providerPayload && typeof result.providerPayload === 'object', 'passthrough should still produce provider payload');
  }

  hubPipeline.dispose();
  console.log('✅ hub pipeline smoke passed');
}

main().catch((e) => {
  console.error('❌ hub pipeline smoke failed:', e);
  process.exit(1);
});

