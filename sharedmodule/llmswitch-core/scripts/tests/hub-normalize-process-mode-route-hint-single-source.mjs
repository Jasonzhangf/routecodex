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
  const normalized = await hubPipeline.normalizeRequest({
    id: 'req_normalize_process_mode_route_hint',
    endpoint: '/v1/chat/completions',
    payload: {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }]
    },
    metadata: {
      providerProtocol: 'openai-chat',
      processMode: 'passthrough',
      routeHint: 'thinking',
      direction: 'request',
      stage: 'inbound',
      stream: false,
      __disableHubSnapshots: true
    }
  });

  assert.equal(normalized.processMode, 'passthrough');
  assert.equal(normalized.routeHint, 'thinking');
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized.metadata, 'processMode'),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized.metadata, 'routeHint'),
    false
  );

  hubPipeline.dispose();
  console.log('✅ hub normalize processMode/routeHint single-source regression passed');
}

main().catch((error) => {
  console.error('❌ hub normalize processMode/routeHint single-source regression failed:', error);
  process.exit(1);
});
