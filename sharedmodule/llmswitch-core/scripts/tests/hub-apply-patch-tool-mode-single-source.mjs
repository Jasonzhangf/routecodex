#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  const { HubPipeline } = await import(
    path.join(projectRoot, 'dist', 'conversion', 'hub', 'pipeline', 'hub-pipeline.js')
  );
  const { bootstrapVirtualRouterConfig } = await import(
    path.join(projectRoot, 'dist', 'router', 'virtual-router', 'bootstrap.js')
  );

  const { config: virtualRouter } = bootstrapVirtualRouterConfig({
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: { type: 'apikey', keys: { key1: { value: 'dummy' } } }
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
  });

  const hubPipeline = new HubPipeline({ virtualRouter });
  const request = {
    id: 'req_apply_patch_tool_mode_single_source',
    endpoint: '/v1/chat/completions',
    payload: {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'patch this file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'freeform apply_patch',
            parameters: { type: 'object', properties: {} },
            format: 'freeform'
          }
        }
      ]
    },
    metadata: {
      providerProtocol: 'openai-chat',
      applyPatchToolMode: 'schema',
      direction: 'request',
      stage: 'inbound',
      stream: false,
      __disableHubSnapshots: true
    }
  };

  const normalized = await hubPipeline.normalizeRequest(request);
  assert.equal(normalized.applyPatchToolMode, 'freeform');
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized.metadata, 'applyPatchToolMode'),
    false,
    'normalized.metadata must not carry applyPatchToolMode mirror'
  );

  const adapterContext = hubPipeline.buildAdapterContext(normalized, {
    providerKey: 'tab.key1.glm-4.7',
    providerType: 'openai-chat',
    modelId: 'glm-4.7',
    outboundProfile: 'openai-chat'
  });
  assert.equal(adapterContext.applyPatchToolMode, 'freeform');

  const result = await hubPipeline.execute(request);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.standardizedRequest?.metadata ?? {}, 'applyPatchToolMode'),
    false,
    'standardizedRequest.metadata must not carry applyPatchToolMode mirror'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.processedRequest?.metadata ?? {}, 'applyPatchToolMode'),
    false,
    'processedRequest.metadata must not carry applyPatchToolMode mirror'
  );

  hubPipeline.dispose();
  console.log('✅ hub applyPatchToolMode single-source regression passed');
}

main().catch((error) => {
  console.error('❌ hub applyPatchToolMode single-source regression failed:', error);
  process.exit(1);
});
